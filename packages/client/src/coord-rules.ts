import { sha256, utf8 } from "@chalito/crypto";
import {
  COORD_RULE_TTL_MS,
  CoordRuleBody,
  CoordRuleRevokeBody,
  rememberMatchFor,
  ruleMatchText,
  type RuleMatch,
} from "@chalito/protocol";
import type { ClientKeys } from "./keys.js";
import { writeWithRetry, type RetryOptions, type SupaClient } from "./supa.js";

/**
 * "Siempre así" (ADR 0025 §6): the owner's remembered answers to coordinator helpers.
 *
 * A rule is signed here (`chalito.coordrule.v1`) and stored in `chalito.coord_rules`; each of the
 * owner's computers verifies it against its own trusted list before using it. The row holds only
 * a hash of what it matches; the readable label is sealed to THIS device (other devices list it as
 * "Regla recordada" and can still remove it). Removing a rule signs a withdrawal
 * (`chalito.coordrule-revoke.v1`) first, so a computer that saw it never uses the rule again,
 * even if the row comes back.
 */

export class CoordRuleError extends Error {
  override name = "CoordRuleError";
  constructor(readonly code: "not_rememberable" | "not_found") {
    super(code);
  }
}

export interface RememberInput {
  toolName: string;
  input: unknown;
  /**
   * The helper's workspace label from the approval's details: sealed and hash-bound by the agent
   * (security review). Never from a plaintext column.
   */
  workspaceLabel: string;
  /** The risk the agent SIGNED on the approval: only MED can be remembered. */
  risk: string;
}

export interface CoordRuleView {
  ruleId: string;
  /** What it matches, when this device made it; null elsewhere. */
  label: string | null;
  createdAt: number;
  expiresAt: number;
  /** Signed by this device. */
  mine: boolean;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

const ruleId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `cr_${btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
};

/** The exact command (or web host) a rule matches, as the confirmation shows it (security review). */
export const describeRule = (m: RuleMatch): string =>
  m.kind === "command" ? `${m.argv.join(" ")} · ${m.workspaceLabel}` : `${m.domain} · ${m.workspaceLabel}`;

export class CoordRulesClient {
  constructor(
    private readonly o: {
      db: SupaClient;
      keys: ClientKeys;
      owner: string;
      now?: () => number;
      retry?: RetryOptions;
    },
  ) {}

  #now() {
    return (this.o.now ?? Date.now)();
  }

  /** What "Siempre así" would remember for this prompt, or null (HIGH/CRITICAL, compound commands, …). */
  matchFor(a: RememberInput): RuleMatch | null {
    if (a.risk !== "MED") return null;
    return rememberMatchFor({ toolName: a.toolName, input: a.input, workspaceLabel: a.workspaceLabel });
  }

  /** Signs and stores the rule; returns its id. */
  async remember(a: RememberInput): Promise<string> {
    const m = this.matchFor(a);
    const text = m && ruleMatchText(m);
    if (!m || !text) throw new CoordRuleError("not_rememberable");
    const now = this.#now();
    const body = CoordRuleBody.parse({
      v: 1,
      ruleId: ruleId(),
      uid: this.o.owner,
      match: hex(await sha256(utf8(text))),
      createdAt: now,
      expiresAt: now + COORD_RULE_TTL_MS,
    });
    const rule = await this.o.keys.sign("chalito.coordrule.v1", body);
    const labelCt = await this.o.keys.seal(
      { label: describeRule(m) },
      { [this.o.keys.deviceId]: this.o.keys.pubBox },
      `coordrule:${body.ruleId}`,
    );
    await writeWithRetry(
      "remember coordinator rule",
      () =>
        this.o.db.from("coord_rules").insert({
          owner: this.o.owner,
          rule_id: body.ruleId,
          signer_device_id: this.o.keys.deviceId,
          rule,
          label_ct: labelCt,
          expires_at: new Date(body.expiresAt).toISOString(),
        }),
      this.o.retry,
    );
    return body.ruleId;
  }

  /** The owner's rules that haven't expired, newest first. */
  async list(): Promise<CoordRuleView[]> {
    const { data, error } = await this.o.db
      .from("coord_rules")
      .select("rule_id, signer_device_id, label_ct, created_at, expires_at")
      .eq("owner", this.o.owner)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    const now = this.#now();
    const out: CoordRuleView[] = [];
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const expiresAt = Date.parse(String(r.expires_at));
      if (!(expiresAt > now)) continue;
      const id = String(r.rule_id);
      let label: string | null = null;
      if (r.label_ct && typeof r.label_ct === "object") {
        try {
          const opened = await this.o.keys.open<{ label?: unknown }>(r.label_ct as never, `coordrule:${id}`);
          label = typeof opened?.label === "string" ? opened.label.slice(0, 200) : null;
        } catch {
          label = null;
        }
      }
      out.push({
        ruleId: id,
        label,
        createdAt: Date.parse(String(r.created_at)),
        expiresAt,
        mine: r.signer_device_id === this.o.keys.deviceId,
      });
    }
    return out;
  }

  /** Withdraws a rule: the signed withdrawal first (computers keep it), then the row goes. */
  async forget(id: string): Promise<void> {
    const body = CoordRuleRevokeBody.parse({ v: 1, uid: this.o.owner, ruleId: id, revokedAt: this.#now() });
    const revoke = await this.o.keys.sign("chalito.coordrule-revoke.v1", body);
    await writeWithRetry(
      "withdraw coordinator rule",
      async () => {
        const r = await this.o.db.from("coord_rule_revocations").insert({
          owner: this.o.owner,
          rule_id: id,
          signer_device_id: this.o.keys.deviceId,
          revoke,
        });
        // Already withdrawn (from another device, or a retry): fine.
        return r.error?.code === "23505" ? { data: null, error: null } : r;
      },
      this.o.retry,
    );
    await writeWithRetry(
      "remove coordinator rule",
      () => this.o.db.from("coord_rules").delete().eq("owner", this.o.owner).eq("rule_id", id),
      this.o.retry,
    );
  }
}
