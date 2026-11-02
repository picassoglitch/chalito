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

const CARD_CHANGED_KEY = "chalito-desktop-companion-card";

/** The pet window re-asks for its custom card on any `storage` event (pet/scene.ts); it also redraws the LCD's card. */
export const announceCardChanged = (storage: Pick<Storage, "setItem"> = localStorage): void => {
  try {
    storage.setItem(CARD_CHANGED_KEY, String(Date.now()));
  } catch {
    // The pet's periodic card refresh picks it up instead.
  }
};

export interface CustomCompanionView {
  /** The character the tile stands for: the worn one, else the newest. Null: no tile. */
  own: KeptCharacter | null;
  wearing: boolean;
  /** The last "use" failed (the selection stayed as it was). */
  failed: boolean;
}

/** The panel's "Your character" tile: loads the kept characters and switches the companion between them and the roster. */
export class CustomCompanion {
  #view: CustomCompanionView = { own: null, wearing: false, failed: false };
  readonly #listeners = new Set<() => void>();

  constructor(
    private readonly api: CompanionAvatarApi,
    private readonly cardChanged: () => void = () => announceCardChanged(),
  ) {}

  subscribe = (l: () => void): (() => void) => {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  };
  getSnapshot = (): CustomCompanionView => this.#view;

  /** Signed out, offline or none kept: no tile, and nothing to say about it. */
  async load(): Promise<void> {
    const kept = await this.api.kept();
    if (kept === "error") return;
    // Owner 2026-11-02 — one tile, like the PWA: the worn character, else the newest kept one.
    const own = kept.find((k) => k.worn) ?? kept[0] ?? null;
    this.#set({ own, wearing: !!own?.worn });
  }

  async wear(): Promise<void> {
    const own = this.#view.own;
    if (!own || this.#view.wearing) return;
    if ((await this.api.use(own.creationId)) !== "ok") return this.#set({ failed: true });
    this.#set({ own: { ...own, worn: true }, wearing: true, failed: false });
    this.cardChanged();
  }

  /** A roster pick while wearing the character: the server only clears it on an avatar change, so ask outright. */
  async backToRoster(): Promise<void> {
    const own = this.#view.own;
    if (!own || !this.#view.wearing) return;
    if ((await this.api.use(null)) !== "ok") return this.#set({ failed: true });
    this.#set({ own: { ...own, worn: false }, wearing: false, failed: false });
    this.cardChanged();
  }

  #set(p: Partial<CustomCompanionView>): void {
    this.#view = { ...this.#view, ...p };
    for (const l of this.#listeners) l();
  }
}
