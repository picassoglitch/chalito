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
  /** The companion wears this creation (null: back to its roster avatar). */
  use(creationId: string | null): Promise<"ok" | "error">;
}

/** The PWA's kept()/use() (apps/web lib/avatar.ts), as this device's session. */
export const httpCompanionAvatar = (
  apiBase: string,
  token: () => Promise<string | null>,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): CompanionAvatarApi => {
  const call = async (path: string, body?: unknown): Promise<Response | null> => {
    const bearer = await token().catch(() => null);
    if (!apiBase || !bearer) return null;
    try {
      return await fetchImpl(`${apiBase}/v1/avatar${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: "no-store",
      });
    } catch {
      return null;
    }
  };
  return {
    kept: async () => {
      const r = await call("/creations");
      if (!r?.ok) return "error";
      const list = ((await r.json().catch(() => null)) as { creations?: unknown } | null)?.creations;
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
    use: async (creationId) => ((await call("/use", { creationId }))?.ok ? "ok" : "error"),
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
): Promise<void> => (key === CARD_CHANGED_KEY ? card.refreshAfterChange() : card.refresh());

export interface CustomCompanionView {
  /** The character the tile stands for: the worn one, else the newest. Null: no tile. */
  own: KeptCharacter | null;
  wearing: boolean;
  /** The last switch failed (the selection stayed as it was). */
  failed: boolean;
}

type Choice = { kind: "own" } | { kind: "roster"; apply: () => void };

// The panel's "Your character" tile: kept characters and switching to and from them.
// Picks run one at a time and the last one wins (a new pick replaces one still waiting).
export class CustomCompanion {
  #view: CustomCompanionView = { own: null, wearing: false, failed: false };
  readonly #listeners = new Set<() => void>();
  #next: Choice | null = null;
  #busy = false;
  /** Bumped by every pick and when picks finish: a kept list read across one is stale. */
  #gen = 0;

  constructor(
    private readonly api: CompanionAvatarApi,
    private readonly opts: {
      /** Lets a pending companion save land first (DesktopSettings.flushCompanion). */
      beforeWear?: () => Promise<void>;
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
    return this.#reload({ clearFailed: true, duringPick: false });
  }

  wear(): Promise<void> {
    return this.#pick({ kind: "own" });
  }

  // While wearing the character, `apply` (the avatar change) waits for use(null): the server only
  // clears it on an avatar change, and a failed switch must leave everything as it was.
  pickRoster(apply: () => void): Promise<void> {
    return this.#pick({ kind: "roster", apply });
  }

  async #reload(o: { clearFailed: boolean; duringPick: boolean }): Promise<void> {
    const gen = this.#gen;
    const kept = await this.api.kept();
    if (kept === "error" || gen !== this.#gen || (this.#busy && !o.duringPick)) return;
    // Owner 2026-11-02 — one tile, like the PWA: the worn character, else the newest kept one.
    const own = kept.find((k) => k.worn) ?? kept[0] ?? null;
    this.#set({ own, wearing: !!own?.worn, ...(o.clearFailed ? { failed: false } : {}) });
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
  }

  async #run(p: Choice): Promise<void> {
    const own = this.#view.own;
    if (p.kind === "roster" && (!own || !this.#view.wearing)) return p.apply();
    if (!own || (p.kind === "own" && this.#view.wearing)) return;
    if (p.kind === "own") await this.opts.beforeWear?.();
    const ok = (await this.api.use(p.kind === "own" ? own.creationId : null)) === "ok";
    if (!ok) {
      this.#set({ failed: true });
      // What the server wears now is unknown; the tile follows its answer.
      return this.#reload({ clearFailed: false, duringPick: true });
    }
    const wearing = p.kind === "own";
    this.#set({ own: { ...own, worn: wearing }, wearing, failed: false });
    if (p.kind === "roster") p.apply();
    (this.opts.cardChanged ?? announceCardChanged)();
  }

  #set(p: Partial<CustomCompanionView>): void {
    this.#view = { ...this.#view, ...p };
    for (const l of this.#listeners) l();
  }
}
