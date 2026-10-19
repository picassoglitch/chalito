import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { COORD_RULE_TTL_MS, CoordRule, CoordRuleRevoke } from "@chalito/protocol";
import type { TrustedClientList } from "@chalito/crypto";

/**
 * The owner's remembered answers ("Siempre así", ADR 0025 §6), read from the cloud and kept only
 * when they verify here: signed by a client in this device's LOCAL trusted list, for this owner,
 * not expired, not made in the future, and never withdrawn. The cloud can drop a rule; it can't
 * make or widen one, and it can't bring back one this device knows was withdrawn:
 * - a signed revocation (`chalito.coordrule-revoke.v1`) from a trusted client, and
 * - a rule this device had verified that later disappears from the cloud
 * both leave a local tombstone until the rule would have expired anyway. A failed read keeps the
 * last good set for one more refresh window, then falls back to none.
 */

/** Rule ids this device must refuse, each until when (the rule's own expiry at the latest). */
export interface CoordTombstones {
  load(): Record<string, number>;
  save(t: Record<string, number>): void;
}

export const memoryTombstones = (): CoordTombstones => {
  let t: Record<string, number> = {};
  return { load: () => ({ ...t }), save: (n) => void (t = { ...n }) };
};

export interface CoordRulesDeps {
  list: () => Promise<unknown[]>;
  listRevocations: () => Promise<unknown[]>;
  trust: () => TrustedClientList;
  owner: string;
  now: () => number;
  tombstones?: CoordTombstones;
  /** How long a read is reused (default 30 s). */
  refreshMs?: number;
  log?: (msg: string, meta: Record<string, unknown>) => void;
}

/** A rule's createdAt may be at most this far ahead of the device clock. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** At most this many tombstones are kept (the oldest-ending go first). */
const MAX_TOMBSTONES = 5000;

export class CoordRules {
  #cache: { at: number; matches: ReadonlySet<string> } | null = null;
  #inflight: Promise<ReadonlySet<string>> | null = null;
  /** The rules verified on the last good read: id → expiry (to tombstone one that disappears). */
  #seen = new Map<string, number>();
  readonly #tombstones: CoordTombstones;

  constructor(private readonly d: CoordRulesDeps) {
    this.#tombstones = d.tombstones ?? memoryTombstones();
  }

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
    let revRaw: unknown[];
    try {
      [raw, revRaw] = await Promise.all([this.d.list(), this.d.listRevocations()]);
    } catch (err) {
      this.d.log?.("coord.rules_read_failed", { error: err instanceof Error ? err.message : "error" });
      // Keep the last good set for one more window; older than that, none.
      if (this.#cache && now - this.#cache.at < 2 * ttl) return this.#cache.matches;
      return new Set();
    }
    const trust = this.d.trust();
    const tomb = Object.fromEntries(Object.entries(this.#tombstones.load()).filter(([, until]) => until > now));
    let changed = false;
    const bury = (id: string, until: number) => {
      if ((tomb[id] ?? 0) >= until) return;
      tomb[id] = until;
      changed = true;
    };

    // Signed revocations from a locally trusted client of this owner.
    for (const r of revRaw) {
      const p = CoordRuleRevoke.safeParse(r);
      if (!p.success || p.data.body.uid !== this.d.owner) continue;
      if (!(await trust.verifySigned(p.data, "chalito.coordrule-revoke.v1")).ok) continue;
      bury(p.data.body.ruleId, Math.max(now, p.data.body.revokedAt) + COORD_RULE_TTL_MS);
    }

    const out = new Set<string>();
    const seen = new Map<string, number>();
    let rejected = 0;
    for (const r of raw) {
      const p = CoordRule.safeParse(r);
      if (!p.success) {
        rejected++;
        continue;
      }
      const b = p.data.body;
      if (
        b.uid !== this.d.owner ||
        b.expiresAt <= now ||
        b.createdAt > now + CLOCK_SKEW_MS ||
        tomb[b.ruleId] !== undefined ||
        !(await trust.verifySigned(p.data, "chalito.coordrule.v1")).ok
      ) {
        rejected++;
        continue;
      }
      out.add(b.match);
      seen.set(b.ruleId, b.expiresAt);
    }
    // A rule verified last time and gone now was removed: it never comes back on this device.
    for (const [id, expiresAt] of this.#seen) if (!seen.has(id)) bury(id, expiresAt);
    this.#seen = seen;

    if (changed) {
      const kept = Object.entries(tomb)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_TOMBSTONES);
      try {
        this.#tombstones.save(Object.fromEntries(kept));
      } catch (err) {
        this.d.log?.("coord.tombstones_save_failed", { error: err instanceof Error ? err.message : "error" });
      }
    }
    if (rejected) this.d.log?.("coord.rules_rejected", { count: rejected });
    this.#cache = { at: now, matches: out };
    return out;
  }
}

/** Tombstones on disk (`~/.chalito/coord-revoked.json`), written atomically. */
export const fileTombstones = (file: string): CoordTombstones => ({
  load: () => {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      return Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).filter(
          (e): e is [string, number] => /^cr_[A-Za-z0-9_-]{8,64}$/.test(e[0]) && typeof e[1] === "number",
        ),
      );
    } catch {
      return {};
    }
  },
  save: (t) => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
    renameSync(tmp, file);
  },
});
