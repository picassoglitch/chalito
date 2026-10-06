import { existsSync, readFileSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { SigningKeyPair } from "@chalito/crypto";
import type { PolicyHolder } from "./agent-core.js";
import type { AnchorStore } from "./anchor.js";
import { ensureChalitoDir } from "./config.js";
import { signLocal, verifyLocal } from "./local-sig.js";
import { DEFAULT_POLICY, Policy, policyHash } from "./policy/index.js";
import type { Logger } from "./redact.js";

export type PolicyChangeVia = Parameters<PolicyHolder["set"]>[1];

const HEADER = `# Chalito local policy (ADR 0008). This file is the ceiling for every session on this
# computer. Phones and the web can only tighten it; loosening needs a local edit
# (\`chalito policy edit\`) and a local confirmation. Sessions can never edit ~/.chalito.
`;

export const policyToYaml = (p: Policy): string => HEADER + stringify(p);

export type ParsedPolicy = { ok: true; policy: Policy } | { ok: false; error: string };

export const parsePolicyYaml = (text: string): ParsedPolicy => {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    return { ok: false, error: `YAML: ${err instanceof Error ? err.message : "parse error"}` };
  }
  const res = Policy.safeParse(raw);
  if (!res.success)
    return {
      ok: false,
      error: res.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    };
  return { ok: true, policy: res.data };
};

export interface FilePolicyOptions {
  /** Called after every change (set or confirmed local edit) with the new hash. */
  onChange?: (hash: string, via: PolicyChangeVia, policy: Policy) => void | Promise<void>;
  /** Keychain rollback anchor; production always passes it. */
  anchor?: AnchorStore;
  /** policy.yaml doesn't match the signed lock (or the lock is older than the anchor): refused. */
  onTamper?: (info: { fileHash: string | null; inForceHash: string }) => void;
  log?: Logger;
  /** Debounce for file-watch events (editors write in several steps). */
  debounceMs?: number;
}

/** Nothing runs: no workspaces, no adapters, no origins. Used when there's no good policy to fall back to. */
export const DENY_ALL_POLICY: Policy = {
  ...DEFAULT_POLICY,
  workspaces: [],
  adapters: { claudeCode: false, codex: false, grok: false, gemini: false },
  origins: { local: false, client: false, mcp: false, call: false },
};

interface Lock {
  policy: Policy;
  policyHash: string;
  /** Monotonic; checked against the keychain anchor so an older signed lock can't come back. */
  seq: number;
  /** Hash of the policy this one replaced (GENESIS for the first). */
  prevHash: string;
}

const GENESIS = "0".repeat(64);

export type PolicyTamper = "unsigned_edit" | "rollback";

/**
 * ~/.chalito/policy.yaml plus ~/.chalito/policy.lock, the agent-signed copy of the
 * policy in force. Only `set()` (the agent itself, or `chalito policy edit` after a
 * local confirmation) writes both. A yaml that doesn't match the lock is refused: the
 * signed policy stays in force (deny-all if there is none) and `policy.tampered` is
 * reported, so a shell write that slipped past the classifier can't loosen anything.
 *
 * Rollback: the lock carries `seq` + `prevHash`, and the keychain anchor remembers the
 * latest `seq`/hash. A validly signed but older lock (a restored backup) is refused and
 * the policy falls back to deny-all. This process also never accepts a lower `seq`
 * than it has seen (in-memory high-water mark).
 *
 * Created with the beta defaults (no workspaces) on first run. Writes are atomic, 0600.
 */
export class FilePolicyHolder implements PolicyHolder {
  #policy: Policy;
  #hash: string;
  #seq = 0;
  #tampered: PolicyTamper | null = null;
  #watcher: FSWatcher | null = null;
  #timer: NodeJS.Timeout | null = null;
  readonly #anchor: AnchorStore | undefined;

  constructor(
    readonly dir: string,
    private readonly keys: SigningKeyPair,
    private readonly opts: FilePolicyOptions = {},
  ) {
    this.#anchor = opts.anchor;
    ensureChalitoDir(dir);
    let lock = this.#readLock();
    if (!existsSync(this.file)) {
      if (lock) this.#writeYaml(lock.policy);
      else this.#seal(DEFAULT_POLICY, GENESIS, 0);
      lock = this.#readLock();
    }
    const parsed = parsePolicyYaml(readFileSync(this.file, "utf8"));
    const fileHash = parsed.ok ? policyHash(parsed.policy) : null;
    if (lock && !this.#anchorAllows(lock)) {
      this.#policy = DENY_ALL_POLICY;
      this.#tampered = "rollback";
    } else if (parsed.ok && lock && fileHash === lock.policyHash) {
      this.#policy = parsed.policy;
      this.#accept(lock);
    } else {
      this.#policy = lock?.policy ?? DENY_ALL_POLICY;
      if (lock) this.#accept(lock);
      this.#tampered = "unsigned_edit";
    }
    this.#hash = policyHash(this.#policy);
    if (this.#tampered) this.#reportTamper(fileHash);
  }

  get file(): string {
    return join(this.dir, "policy.yaml");
  }

  get lockFile(): string {
    return join(this.dir, "policy.lock");
  }

  get hash(): string {
    return this.#hash;
  }

  get seq(): number {
    return this.#seq;
  }

  /** The lock's link to the policy it replaced (GENESIS for the first, or before any lock). */
  get prevHash(): string {
    return this.#readLock()?.prevHash ?? GENESIS;
  }

  /** When the lock in force was written (ms), or null before the first one. */
  get updatedAt(): number | null {
    try {
      return statSync(this.lockFile).mtimeMs;
    } catch {
      return null;
    }
  }

  /** Whether what's on disk was refused (unsigned edit, or a rolled-back lock). */
  get tampered(): boolean {
    return this.#tampered !== null;
  }

  get tamperReason(): PolicyTamper | null {
    return this.#tampered;
  }

  get(): Policy {
    return this.#policy;
  }

  async set(p: Policy, via: PolicyChangeVia): Promise<void> {
    const policy = Policy.parse(p);
    this.#seal(policy, this.#hash, Math.max(this.#seq, this.#anchor?.policy()?.seq ?? 0));
    this.#tampered = null;
    await this.#anchor?.flush();
    await this.#apply(policy, via);
  }

  /** Waits for the keychain anchor write of the latest seal. */
  async flush(): Promise<void> {
    await this.#anchor?.flush();
  }

  /** Starts watching the file for local edits. */
  watch(): this {
    if (this.#watcher) return this;
    // Watch the directory: atomic saves replace the inode, which ends a file watch.
    this.#watcher = watch(this.dir, (_event, name) => {
      if (name !== null && name !== "policy.yaml" && name !== "policy.lock") return;
      if (this.#timer) clearTimeout(this.#timer);
      this.#timer = setTimeout(() => void this.reload(), this.opts.debounceMs ?? 150);
    });
    return this;
  }

  /**
   * Re-reads yaml + lock. A newer signed change (another process ran `chalito policy edit`)
   * is applied; an unsigned edit or an older lock is refused and reported. Returns whether
   * the policy changed.
   */
  async reload(): Promise<boolean> {
    await this.#anchor?.load();
    const lock = this.#readLock();
    const parsed = existsSync(this.file) ? parsePolicyYaml(readFileSync(this.file, "utf8")) : null;
    const fileHash = parsed?.ok ? policyHash(parsed.policy) : null;
    if (lock && (lock.seq < this.#seq || !this.#anchorAllows(lock))) {
      this.#tampered = "rollback";
      this.#reportTamper(fileHash);
      return false;
    }
    if (parsed?.ok && lock && fileHash === lock.policyHash) {
      this.#tampered = null;
      this.#accept(lock);
      if (fileHash === this.#hash) return false;
      await this.#apply(parsed.policy, "local");
      return true;
    }
    if (fileHash === this.#hash && lock?.policyHash !== this.#hash) {
      // Only the lock went missing or bad; the yaml is the policy already in force. Re-seal it.
      this.#seal(this.#policy, this.#hash, Math.max(this.#seq, this.#anchor?.policy()?.seq ?? 0));
      return false;
    }
    this.#tampered = "unsigned_edit";
    this.#reportTamper(fileHash);
    return false;
  }

  close(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#watcher?.close();
    this.#watcher = null;
  }

  /**
   * No anchor yet: only a first (seq ≤ 1) or pre-anchor lock is accepted. Otherwise the
   * lock must be newer than the anchor, or the anchor's own seq with the same hash.
   */
  #anchorAllows(lock: Lock): boolean {
    if (!this.#anchor) return true;
    const a = this.#anchor.policy();
    if (!a) return lock.seq <= 1;
    return lock.seq > a.seq || (lock.seq === a.seq && lock.policyHash === a.hash);
  }

  #accept(lock: Lock): void {
    this.#seq = Math.max(this.#seq, lock.seq);
    const a = this.#anchor?.policy();
    if (this.#anchor && (!a || lock.seq > a.seq))
      void this.#anchor
        .setPolicy({ seq: lock.seq, hash: lock.policyHash })
        .catch((err: unknown) =>
          this.opts.log?.error("policy.anchor_write_failed", { error: err instanceof Error ? err.message : "error" }),
        );
  }

  #reportTamper(fileHash: string | null): void {
    this.opts.log?.error("policy.tampered", {
      reason: this.#tampered,
      fileHash,
      inForceHash: this.#hash,
      file: this.file,
    });
    this.opts.onTamper?.({ fileHash, inForceHash: this.#hash });
  }

  async #apply(policy: Policy, via: PolicyChangeVia): Promise<void> {
    this.#policy = policy;
    this.#hash = policyHash(policy);
    this.opts.log?.info("policy.changed", { via, policyHash: this.#hash, seq: this.#seq });
    await this.opts.onChange?.(this.#hash, via, policy);
  }

  #readLock(): Lock | null {
    if (!existsSync(this.lockFile)) return null;
    try {
      const { sig, ...body } = JSON.parse(readFileSync(this.lockFile, "utf8")) as Partial<Lock> & { sig: unknown };
      if (!verifyLocal("chalito.policy-lock.v1", body, sig, this.keys.publicKey)) return null;
      const policy = Policy.parse(body.policy);
      if (policyHash(policy) !== body.policyHash) return null;
      // Locks written before seq existed count as seq 0.
      return {
        policy,
        policyHash: body.policyHash,
        seq: Number.isInteger(body.seq) ? body.seq! : 0,
        prevHash: typeof body.prevHash === "string" ? body.prevHash : GENESIS,
      };
    } catch {
      return null;
    }
  }

  /** Lock first, then yaml: both written synchronously, so a watcher never sees one without the other. */
  #seal(p: Policy, prevHash: string, prevSeq: number): void {
    const body: Lock = { policy: p, policyHash: policyHash(p), seq: prevSeq + 1, prevHash };
    const tmp = `${this.lockFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...body, sig: signLocal("chalito.policy-lock.v1", body, this.keys) }), {
      mode: 0o600,
    });
    renameSync(tmp, this.lockFile);
    this.#writeYaml(p);
    this.#accept(body);
  }

  #writeYaml(p: Policy): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, policyToYaml(p), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
