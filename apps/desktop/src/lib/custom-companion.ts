/** The avatar bucket's signed-URL host (tauri.conf.json img-src allows it). */
const SIGNED = /^https:\/\/storage\.googleapis\.com\//;

/** One of the person's kept characters (GET /v1/avatar/creations), newest first. */
export interface KeptCharacter {
  creationId: string;
  /** The companion wears it now. */
  worn: boolean;
  /** A signed thumbnail, when there is one. */
  thumb?: string;
}

export interface CompanionAvatarApi {
  kept(): Promise<KeptCharacter[] | "error">;
  /** The companion wears this creation (null: back to its roster avatar). "unknown": sent, no answer. */
  use(creationId: string | null): Promise<"ok" | "error" | "unknown">;
}

const warn = (step: string) => console.warn(`custom companion: ${step}`);

type Outcome = { kind: "ok"; json: unknown } | { kind: "error" } | { kind: "unknown" };

/** The PWA's kept()/use() (apps/web lib/avatar.ts), as this device's session. */
export const httpCompanionAvatar = (
  apiBase: string,
  token: () => Promise<string | null>,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  timeoutMs = 10_000,
): CompanionAvatarApi => {
  // One deadline for the whole call (session token, request and body): picks wait on it.
  const call = async (step: string, path: string, body?: unknown): Promise<Outcome> => {
    const signal = AbortSignal.timeout(timeoutMs);
    const gaveUp = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    gaveUp.catch(() => undefined);
    const until = <T>(p: Promise<T>): Promise<T> => Promise.race([p, gaveUp]);
    let sent = false;
    try {
      const bearer = await until(token().catch(() => null));
      if (!apiBase || !bearer) return (warn(`${step} no token`), { kind: "error" });
      sent = true;
      const r = await until(
        fetchImpl(`${apiBase}/v1/avatar${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${bearer}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          cache: "no-store",
          signal,
        }),
      );
      if (!r.ok) return (warn(`${step} HTTP ${r.status}`), { kind: "error" });
      return { kind: "ok", json: await until(r.json().catch(() => null)) };
    } catch {
      if (!sent) return (warn(`${step} no token`), { kind: "error" });
      warn(`${step} ${signal.aborted ? "aborted" : "network error"}`);
      // The server may still have done it.
      return { kind: "unknown" };
    }
  };
  return {
    kept: async () => {
      const r = await call("kept", "/creations");
      if (r.kind !== "ok") return "error";
      const list = (r.json as { creations?: unknown } | null)?.creations;
      if (!Array.isArray(list)) return "error";
      const out: KeptCharacter[] = [];
      for (const e of list as Record<string, unknown>[]) {
        if (typeof e?.creationId !== "string" || typeof e.worn !== "boolean") continue;
        out.push({
          creationId: e.creationId,
          worn: e.worn,
          ...(typeof e.thumb === "string" && SIGNED.test(e.thumb) ? { thumb: e.thumb } : {}),
        });
      }
      return out;
    },
    use: async (creationId) => {
      const r = await call("use", "/use", { creationId });
      return r.kind === "ok" ? "ok" : r.kind;
    },
  };
};

export const CARD_CHANGED_KEY = "chalito-desktop-companion-card";

/** The pet window re-asks for its custom card on a `storage` event (pet/scene.ts); it also redraws the LCD's card. */
export const announceCardChanged = (storage: Pick<Storage, "setItem"> = localStorage): void => {
  try {
    // A new value every time: an unchanged one fires no `storage` event.
    storage.setItem(CARD_CHANGED_KEY, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  } catch {
    // The pet's periodic card refresh picks it up instead.
  }
};

/** In the pet window: after the panel changed the card, a request already running may predate the change. */
export const refreshOnStorage = (
  key: string | null,
  card: { refresh: () => Promise<void>; refreshAfterChange: () => Promise<void> },
): Promise<void> =>
  // Never rejects: the pet fires it and forgets; a failed refresh retries on the source's own clock.
  (key === CARD_CHANGED_KEY ? card.refreshAfterChange() : card.refresh()).catch((e: unknown) =>
    // Signed URLs carry their signature in the query: keep it out of the log.
    console.warn("pet: card refresh failed", String(e instanceof Error ? e.message : e).replace(/\?\S*/g, "?…")),
  );

export interface CustomCompanionView {
  /** The character the tile stands for: the worn one, else the newest. Null: no tile. */
  own: KeptCharacter | null;
  wearing: boolean;
  /** The last switch failed (the selection stayed as it was). */
  failed: boolean;
}

type Choice = { kind: "own" } | { kind: "roster"; apply: () => void };
/** What the person asked for last, and (for a roster pet) whether the avatar change went through. */
type Intent = { kind: "own" } | { kind: "roster"; applied: boolean };

// The panel's "Your character" tile: kept characters and switching to and from them.
// Picks run one at a time and the last one wins (a new pick replaces one still waiting).
export class CustomCompanion {
  #view: CustomCompanionView = { own: null, wearing: false, failed: false };
  readonly #listeners = new Set<() => void>();
  #next: Choice | null = null;
  #busy = false;
  /** Bumped by every pick and when picks finish: a kept list read across one is stale. */
  #gen = 0;
  /** Bumped by every answered /use: a reconciling read from before one is stale. */
  #useSeq = 0;
  /** A wear on its way: a roster pick waits behind it. */
  #wearInFlight = false;
  #reloadAfter = false;
  #intent: Intent | null = null;
  /** A /use went out without an answer; the server may still apply it, so the tile follows its reads. */
  #reconciling = false;
  #reconcileTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly api: CompanionAvatarApi,
    private readonly opts: {
      /** Lets a pending companion save land first (DesktopSettings.flushCompanion); bounded by waitMs. */
      beforeWear?: () => Promise<void>;
      waitMs?: number;
      /** How long after an unanswered /use to read again what the server wears. */
      reconcileMs?: number;
      cardChanged?: () => void;
    } = {},
  ) {}

  subscribe = (l: () => void): (() => void) => {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  };
  getSnapshot = (): CustomCompanionView => this.#view;

  /** Signed out, offline or none kept: no tile, and nothing to say about it. */
  load(): Promise<void> {
    return this.#reload(this.#reconciling ? "last-reconcile" : "load");
  }

  wear(): Promise<void> {
    return this.#pick({ kind: "own" });
  }

  // While wearing the character, `apply` (the avatar change) waits for use(null): the server only
  // clears it on an avatar change, and a failed switch must leave everything as it was.
  pickRoster(apply: () => void): Promise<void> {
    if (this.#view.wearing || this.#wearInFlight) return this.#pick({ kind: "roster", apply });
    this.#next = null;
    this.#intent = { kind: "roster", applied: true };
    apply();
    // An unanswered /use may still land: its reads stay, and so does the error until they agree.
    if (!this.#reconciling) {
      this.#gen++;
      this.#set({ failed: false });
    }
    return Promise.resolve();
  }

  async #reload(mode: "load" | "after-error" | "reconcile" | "last-reconcile"): Promise<void> {
    const gen = this.#gen;
    const seq = this.#useSeq;
    const kept = await this.api.kept();
    if (kept === "error" || this.#busy || seq !== this.#useSeq) return;
    const reconcile = mode === "reconcile" || mode === "last-reconcile";
    if (reconcile ? !this.#reconciling : gen !== this.#gen) return;
    // Owner 2026-11-02 — one tile, like the PWA: the worn character, else the newest kept one.
    const own = kept.find((k) => k.worn) ?? kept[0] ?? null;
    const wearing = !!own?.worn;
    if (!reconcile) return this.#set({ own, wearing, ...(mode === "load" ? { failed: false } : {}) });
    const i = this.#intent;
    const agreed = i?.kind === "own" ? wearing : !!i?.applied && !wearing;
    if (mode === "last-reconcile") this.#endReconcile();
    this.#set({ own, wearing, failed: !agreed });
    (this.opts.cardChanged ?? announceCardChanged)();
  }

  #endReconcile(): void {
    this.#reconciling = false;
    clearTimeout(this.#reconcileTimer);
  }

  async #pick(p: Choice): Promise<void> {
    this.#gen++;
    this.#next = p;
    if (this.#busy) return;
    this.#busy = true;
    try {
      for (let n: Choice | null = this.#next; n; n = this.#next) {
        this.#next = null;
        await this.#run(n);
      }
    } finally {
      this.#busy = false;
      // A list read while these ran may predate them.
      this.#gen++;
    }
    if (this.#reloadAfter) {
      this.#reloadAfter = false;
      // What the server wears after a failure is unknown; the tile follows its answer.
      await this.#reload(this.#reconciling ? "reconcile" : "after-error");
    }
  }

  async #run(p: Choice): Promise<void> {
    const own = this.#view.own;
    if (p.kind === "roster" && (!own || !this.#view.wearing)) {
      this.#intent = { kind: "roster", applied: true };
      return p.apply();
    }
    if (!own || (p.kind === "own" && this.#view.wearing)) return;
    this.#intent = p.kind === "own" ? { kind: "own" } : { kind: "roster", applied: false };
    this.#wearInFlight = p.kind === "own";
    let r: "ok" | "error" | "unknown";
    try {
      const ready = p.kind === "roster" || (await this.#bounded(this.opts.beforeWear?.()));
      if (!ready) warn("beforeWear timeout");
      r = ready ? await this.api.use(p.kind === "own" ? own.creationId : null) : "error";
    } finally {
      this.#wearInFlight = false;
    }
    if (r !== "unknown") this.#useSeq++;
    if (r !== "ok") {
      this.#set({ failed: true });
      this.#reloadAfter = true;
      if (r === "unknown") {
        this.#reconciling = true;
        clearTimeout(this.#reconcileTimer);
        this.#reconcileTimer = setTimeout(() => void this.#reload("reconcile"), this.opts.reconcileMs ?? 3_000);
      }
      return;
    }
    this.#endReconcile();
    const wearing = p.kind === "own";
    this.#set({ own: { ...own, worn: wearing }, wearing, failed: false });
    if (p.kind === "roster") {
      this.#intent = { kind: "roster", applied: true };
      p.apply();
    }
    (this.opts.cardChanged ?? announceCardChanged)();
  }

  /** True once `work` is done; false when it failed or outlasted waitMs. */
  async #bounded(work: Promise<void> | undefined): Promise<boolean> {
    if (!work) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean>((r) => (timer = setTimeout(() => r(false), this.opts.waitMs ?? 10_000)));
    try {
      return await Promise.race([
        work.then(
          () => true,
          () => false,
        ),
        late,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #set(p: Partial<CustomCompanionView>): void {
    this.#view = { ...this.#view, ...p };
    for (const l of this.#listeners) l();
  }
}
