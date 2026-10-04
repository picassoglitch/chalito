import { existsSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { SigningKeyPair } from "@chalito/crypto";
import type { PolicyHolder } from "./agent-core.js";
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
  /** policy.yaml doesn't match the signed lock: the edit is refused. */
  onTamper?: (info: { fileHash: string | null; inForceHash: string }) => void;
  log?: Logger;
  /** Debounce for file-watch events (editors write in several steps). */
  debounceMs?: number;
}

/** Nothing runs: no workspaces, no adapters, no origins. Used when there's no good policy to fall back to. */
export const DENY_ALL_POLICY: Policy = {
  ...DEFAULT_POLICY,
  workspaces: [],
  adapters: { claudeCode: false, codex: false },
  origins: { local: false, client: false, mcp: false, call: false },
};

interface Lock {
  policy: Policy;
  policyHash: string;
}

/**
 * ~/.chalito/policy.yaml plus ~/.chalito/policy.lock, the agent-signed copy of the
 * policy in force. Only `set()` (the agent itself, or `chalito policy edit` after a
 * local confirmation) writes both. A yaml that doesn't match the lock is refused: the
 * signed policy stays in force (deny-all if there is none) and `policy.tampered` is
 * reported, so a shell write that slipped past the classifier can't loosen anything.
 * Created with the beta defaults (no workspaces) on first run. Writes are atomic, 0600.
 */
export class FilePolicyHolder implements PolicyHolder {
  #policy: Policy;
  #hash: string;
  #tampered = false;
  #watcher: FSWatcher | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(
    readonly dir: string,
    private readonly keys: SigningKeyPair,
    private readonly opts: FilePolicyOptions = {},
  ) {
    ensureChalitoDir(dir);
    let lock = this.#readLock();
    if (!existsSync(this.file)) {
      if (lock) this.#writeYaml(lock.policy);
      else this.#seal(DEFAULT_POLICY);
      lock = this.#readLock();
    }
    const parsed = parsePolicyYaml(readFileSync(this.file, "utf8"));
    if (parsed.ok && lock && policyHash(parsed.policy) === lock.policyHash) {
      this.#policy = parsed.policy;
    } else {
      this.#policy = lock?.policy ?? DENY_ALL_POLICY;
      this.#tampered = true;
    }
    this.#hash = policyHash(this.#policy);
    if (this.#tampered) this.#reportTamper(parsed.ok ? policyHash(parsed.policy) : null);
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

  /** Whether the yaml on disk was refused (it differs from the signed policy in force). */
  get tampered(): boolean {
    return this.#tampered;
  }

  get(): Policy {
    return this.#policy;
  }

  async set(p: Policy, via: PolicyChangeVia): Promise<void> {
    const policy = Policy.parse(p);
    this.#seal(policy);
    this.#tampered = false;
    await this.#apply(policy, via);
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
   * Re-reads yaml + lock. A signed change (another process ran `chalito policy edit`)
   * is applied; an unsigned edit is refused and reported. Returns whether the policy changed.
   */
  async reload(): Promise<boolean> {
    const lock = this.#readLock();
    const parsed = existsSync(this.file) ? parsePolicyYaml(readFileSync(this.file, "utf8")) : null;
    const fileHash = parsed?.ok ? policyHash(parsed.policy) : null;
    if (parsed?.ok && lock && fileHash === lock.policyHash) {
      this.#tampered = false;
      if (fileHash === this.#hash) return false;
      await this.#apply(parsed.policy, "local");
      return true;
    }
    if (fileHash === this.#hash && lock?.policyHash !== this.#hash) {
      // Only the lock went missing or bad; the yaml is the policy already in force. Re-seal it.
      this.#seal(this.#policy);
      return false;
    }
    this.#tampered = true;
    this.#reportTamper(fileHash);
    return false;
  }

  close(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#watcher?.close();
    this.#watcher = null;
  }

  #reportTamper(fileHash: string | null): void {
    this.opts.log?.error("policy.tampered", { fileHash, inForceHash: this.#hash, file: this.file });
    this.opts.onTamper?.({ fileHash, inForceHash: this.#hash });
  }

  async #apply(policy: Policy, via: PolicyChangeVia): Promise<void> {
    this.#policy = policy;
    this.#hash = policyHash(policy);
    this.opts.log?.info("policy.changed", { via, policyHash: this.#hash });
    await this.opts.onChange?.(this.#hash, via, policy);
  }

  #readLock(): Lock | null {
    if (!existsSync(this.lockFile)) return null;
    try {
      const { sig, ...body } = JSON.parse(readFileSync(this.lockFile, "utf8")) as Lock & { sig: unknown };
      if (!verifyLocal("chalito.policy-lock.v1", body, sig, this.keys.publicKey)) return null;
      const policy = Policy.parse(body.policy);
      return policyHash(policy) === body.policyHash ? { policy, policyHash: body.policyHash } : null;
    } catch {
      return null;
    }
  }

  /** Lock first, then yaml: both written synchronously, so a watcher never sees one without the other. */
  #seal(p: Policy): void {
    const body: Lock = { policy: p, policyHash: policyHash(p) };
    const tmp = `${this.lockFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...body, sig: signLocal("chalito.policy-lock.v1", body, this.keys) }), {
      mode: 0o600,
    });
    renameSync(tmp, this.lockFile);
    this.#writeYaml(p);
  }

  #writeYaml(p: Policy): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, policyToYaml(p), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
