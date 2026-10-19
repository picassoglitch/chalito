import { CoordRule } from "@chalito/protocol";
import type { TrustedClientList } from "@chalito/crypto";

/**
 * The owner's remembered answers ("Siempre así", ADR 0025 §6), read from the cloud and kept only
 * when they verify here: signed by a client in this device's LOCAL trusted list, for this owner,
 * not expired, not made in the future. The cloud can drop a rule; it can't make or widen one (a
 * removed or revoked client's rules stop verifying with it). A failed read keeps the last good
 * set for one more refresh window, then falls back to none.
 */
export interface CoordRulesDeps {
  list: () => Promise<unknown[]>;
  trust: () => TrustedClientList;
  owner: string;
  now: () => number;
  /** How long a read is reused (default 30 s). */
  refreshMs?: number;
  log?: (msg: string, meta: Record<string, unknown>) => void;
}

/** A rule's createdAt may be at most this far ahead of the device clock. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export class CoordRules {
  #cache: { at: number; matches: ReadonlySet<string> } | null = null;
  #inflight: Promise<ReadonlySet<string>> | null = null;

  constructor(private readonly d: CoordRulesDeps) {}

  /** Match hashes of the rules that verify now. */
  async matches(): Promise<ReadonlySet<string>> {
    const now = this.d.now();
    const ttl = this.d.refreshMs ?? 30_000;
    if (this.#cache && now - this.#cache.at < ttl) return this.#cache.matches;
    this.#inflight ??= this.#load(now, ttl).finally(() => (this.#inflight = null));
    return this.#inflight;
  }

  /** Drop the cache (a rule was added or removed, or trust changed). */
  invalidate(): void {
    this.#cache = null;
  }

  async #load(now: number, ttl: number): Promise<ReadonlySet<string>> {
    let raw: unknown[];
    try {
      raw = await this.d.list();
    } catch (err) {
      this.d.log?.("coord.rules_read_failed", { error: err instanceof Error ? err.message : "error" });
      // Keep the last good set for one more window; older than that, none.
      if (this.#cache && now - this.#cache.at < 2 * ttl) return this.#cache.matches;
      return new Set();
    }
    const trust = this.d.trust();
    const out = new Set<string>();
    let rejected = 0;
    for (const r of raw) {
      const p = CoordRule.safeParse(r);
      if (!p.success) {
        rejected++;
        continue;
      }
      const b = p.data.body;
      if (b.uid !== this.d.owner || b.expiresAt <= now || b.createdAt > now + CLOCK_SKEW_MS) {
        rejected++;
        continue;
      }
      const sig = await trust.verifySigned(p.data, "chalito.coordrule.v1");
      if (!sig.ok) {
        rejected++;
        continue;
      }
      out.add(b.match);
    }
    if (rejected) this.d.log?.("coord.rules_rejected", { count: rejected });
    this.#cache = { at: now, matches: out };
    return out;
  }
}
