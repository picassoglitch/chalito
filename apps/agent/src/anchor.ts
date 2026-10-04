import type { SecretStore } from "./secrets.js";

/** Head of the Developer-mode audit chain. `epoch` moves forward only on `chalito devmode reset`. */
export interface ChainHead {
  hash: string;
  count: number;
  epoch: number;
}

export interface PolicyAnchor {
  seq: number;
  hash: string;
}

interface AnchorData {
  devmode: ChainHead | null;
  policy: PolicyAnchor | null;
}

/** Keychain entry for the rollback anchor (outside ~/.chalito, so a file restore can't move it back). */
export const ANCHOR_SECRET = "local-anchor";
/** m3-cli-2's devmode-only entry, read once for migration. */
const LEGACY_CHAIN_HEAD_SECRET = "devmode-chain-head";

const newer = (a: ChainHead, b: ChainHead) => a.epoch > b.epoch || (a.epoch === b.epoch && a.count > b.count);

const parseHead = (v: unknown): ChainHead | null => {
  const h = v as Partial<ChainHead> | null;
  return h && typeof h.hash === "string" && Number.isInteger(h.count)
    ? { hash: h.hash, count: h.count!, epoch: Number.isInteger(h.epoch) ? h.epoch! : 0 }
    : null;
};

const parsePolicy = (v: unknown): PolicyAnchor | null => {
  const p = v as Partial<PolicyAnchor> | null;
  return p && Number.isInteger(p.seq) && typeof p.hash === "string" ? { seq: p.seq!, hash: p.hash } : null;
};

/**
 * Monotonic counters for the agent's signed local files, kept in the OS keychain:
 * `{devmode head (epoch, count, hash), policy (seq, hash)}`. A file pair older than the
 * anchor is a rollback. Reads are synchronous (a cache) because policy and Developer-mode
 * checks run inside synchronous reads. The cache is also the daemon's in-memory
 * high-water mark: `load()` never moves it backwards, even if the keychain does.
 */
export class AnchorStore {
  #data: AnchorData = { devmode: null, policy: null };
  #pending: Promise<void> = Promise.resolve();

  constructor(private readonly secrets: SecretStore) {}

  /** (Re)loads from the keychain; call at startup and when another process may have moved it. */
  async load(): Promise<this> {
    let stored: AnchorData = { devmode: null, policy: null };
    try {
      const raw = await this.secrets.get(ANCHOR_SECRET);
      if (raw) {
        const j = JSON.parse(raw) as { devmode?: unknown; policy?: unknown };
        stored = { devmode: parseHead(j.devmode), policy: parsePolicy(j.policy) };
      } else {
        const legacy = await this.secrets.get(LEGACY_CHAIN_HEAD_SECRET);
        if (legacy) stored.devmode = parseHead(JSON.parse(legacy));
      }
    } catch {
      /* unreadable: keep what this process already knows */
    }
    const cur = this.#data;
    this.#data = {
      devmode: !cur.devmode
        ? stored.devmode
        : stored.devmode && newer(stored.devmode, cur.devmode)
          ? stored.devmode
          : cur.devmode,
      policy: !cur.policy
        ? stored.policy
        : stored.policy && stored.policy.seq > cur.policy.seq
          ? stored.policy
          : cur.policy,
    };
    return this;
  }

  devmodeHead(): ChainHead | null {
    return this.#data.devmode;
  }

  policy(): PolicyAnchor | null {
    return this.#data.policy;
  }

  /** Moves the devmode head forward (never back) and writes through to the keychain. */
  setDevmodeHead(head: ChainHead): Promise<void> {
    if (this.#data.devmode && !newer(head, this.#data.devmode)) return this.#pending;
    this.#data = { ...this.#data, devmode: head };
    return this.#persist();
  }

  setPolicy(p: PolicyAnchor): Promise<void> {
    if (this.#data.policy && p.seq <= this.#data.policy.seq) return this.#pending;
    this.#data = { ...this.#data, policy: p };
    return this.#persist();
  }

  /** Waits for pending keychain writes. */
  flush(): Promise<void> {
    return this.#pending;
  }

  #persist(): Promise<void> {
    const snapshot = JSON.stringify(this.#data);
    // Serialised; a failed write surfaces to its caller but doesn't block the next one.
    this.#pending = this.#pending.catch(() => undefined).then(() => this.secrets.set(ANCHOR_SECRET, snapshot));
    return this.#pending;
  }
}
