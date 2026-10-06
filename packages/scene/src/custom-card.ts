/**
 * Cards that aren't served from the roster: a person's own custom companion (a photo made into a
 * card by apps/avatar-jobs, kept private in the avatar bucket and read through short-lived signed
 * URLs from GET /v1/avatar/companion). No three.js here: shells import this from
 * "@chalito/scene/custom-card" without pulling the renderer in.
 */

/**
 * Where a card's files are, file by file. The loader asks `url` at load time, so the URLs may
 * change underneath (signed URLs being refreshed) without the card counting as a different one.
 */
export interface CardFiles {
  /** Stable identity (the asset id): what decides whether a card must be reloaded. */
  key: string;
  /** card.json's contents when the caller already has them; otherwise fetched from url("card.json"). */
  manifest?: unknown;
  /** Card file name ("layer-happy.webp") → its URL, or undefined when there is none. */
  url: (file: string) => string | undefined;
  /** Called once when a file fails to load (e.g. an expired signed URL); the load is then retried once. */
  refresh?: () => Promise<void>;
}

/** A card to draw: a roster id (served under the asset base) or a card's own files. */
export type CardRef = string | CardFiles;

export const isCardFiles = (c: CardRef): c is CardFiles => typeof c !== "string";

/** A fixed file → URL map as CardFiles. */
export const cardFilesFrom = (key: string, urls: Readonly<Record<string, string>>, manifest?: unknown): CardFiles => ({
  key,
  ...(manifest === undefined ? {} : { manifest }),
  url: (f) => (Object.hasOwn(urls, f) ? urls[f] : undefined),
});

/** The person's custom card as GET /v1/avatar/companion answers it, validated. */
export interface SignedCard {
  assetId: string;
  /** card.json (apps/avatar-jobs CardManifest): size, drawings, shadow, cosmetic anchors, thumbs. */
  manifest: SignedManifest;
  /** Card file name → signed URL. */
  urls: Record<string, string>;
  /** Epoch ms when the signed URLs stop working. */
  expiresAt: number;
}

export interface SignedManifest {
  width: number;
  height: number;
  emotions: { src: Record<string, string> };
  thumbs: Record<string, string>;
  anchors?: Partial<Record<string, { x: number; y: number; z: number; w?: number }>>;
  [k: string]: unknown;
}

/** When the api doesn't say how long the URLs live (older api): assume less than it signs (60 min). */
export const DEFAULT_SIGNED_TTL_MS = 30 * 60_000;

const FILE = /^[a-z0-9-]+\.webp$/;
const ASSET = /^[a-z0-9]{8,64}$/;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const strMap = (v: unknown, ok: (k: string, x: string) => boolean): Record<string, string> | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x !== "string" || !ok(k, x)) return null;
    out[k] = x;
  }
  return out;
};

/**
 * Validates GET /v1/avatar/companion's body: null when the companion has no custom card
 * (`{ assetId: null }`), "invalid" when the body isn't a usable card. Every drawing and thumb must
 * have a URL that `isUrl` accepts (the web keeps them to the bucket's host).
 */
export const parseSignedCard = (
  body: unknown,
  opts: { now: number; isUrl?: (url: string) => boolean },
): SignedCard | null | "invalid" => {
  const b = body as { assetId?: unknown; card?: { manifest?: unknown; urls?: unknown; expiresAt?: unknown } } | null;
  if (!b || typeof b !== "object") return "invalid";
  if (b.assetId === null) return null;
  if (typeof b.assetId !== "string" || !ASSET.test(b.assetId)) return "invalid";
  const isUrl = opts.isUrl ?? ((u: string) => /^https:\/\//.test(u));
  const urls = strMap(b.card?.urls, (k, u) => FILE.test(k) && isUrl(u));
  const m = b.card?.manifest as Record<string, unknown> | undefined;
  if (!urls || !m || !isNum(m.width) || !isNum(m.height) || m.width <= 0 || m.height <= 0) return "invalid";
  const src = strMap(
    (m.emotions as { src?: unknown } | undefined)?.src,
    (k, f) => /^[a-z]{1,20}$/.test(k) && FILE.test(f),
  );
  const thumbs = strMap(m.thumbs, (k, f) => /^\d{2,4}$/.test(k) && FILE.test(f));
  if (!src || !thumbs || !src.neutral) return "invalid";
  if (![...Object.values(src), ...Object.values(thumbs)].every((f) => Object.hasOwn(urls, f))) return "invalid";
  const expiresAt = isNum(b.card?.expiresAt) ? b.card.expiresAt : opts.now + DEFAULT_SIGNED_TTL_MS;
  return {
    assetId: b.assetId,
    manifest: { ...m, width: m.width, height: m.height, emotions: { ...(m.emotions as object), src }, thumbs },
    urls,
    expiresAt,
  };
};

/**
 * Validates GET /v1/avatar/rooms/:roomId/cards: the room members' custom cards by companion id.
 * A member whose entry is unusable is left out (drawn from their roster avatar).
 */
export const parseRoomCards = (
  body: unknown,
  opts: { now: number; isUrl?: (url: string) => boolean },
): Map<string, SignedCard> | "invalid" => {
  const cards = (body as { cards?: unknown } | null)?.cards;
  if (!Array.isArray(cards)) return "invalid";
  const out = new Map<string, SignedCard>();
  for (const e of cards as { companionId?: unknown; assetId?: unknown; card?: unknown }[]) {
    if (typeof e?.companionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(e.companionId)) continue;
    const c = parseSignedCard({ assetId: e.assetId, card: e.card }, opts);
    if (c && c !== "invalid") out.set(e.companionId, c);
  }
  return out;
};

/** The custom card's smallest thumbnail at least `size` px (or the largest there is), as a URL. */
export const signedThumb = (c: SignedCard, size = 128): string | undefined => {
  const sizes = Object.keys(c.manifest.thumbs)
    .map(Number)
    .sort((a, b) => a - b);
  const pick = sizes.find((s) => s >= size) ?? sizes.at(-1);
  return pick === undefined ? undefined : c.urls[c.manifest.thumbs[String(pick)]!];
};

/** setTimeout's longest delay (2^31 - 1 ms). */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

interface SourceTiming {
  now?: () => number;
  timers?: Timers;
  /** Refresh this long before the URLs expire. */
  refreshMarginMs?: number;
  /** After a failed fetch, try again this much later. */
  retryMs?: number;
}

export interface SignedCardsSourceOptions extends SourceTiming {
  /** The cards by id (e.g. companion id), parsed; throws when it can't tell. */
  fetch: () => Promise<ReadonlyMap<string, SignedCard>>;
}

/**
 * Signed cards kept with working URLs: fetched on first use, re-fetched a margin before the
 * soonest expiry, on demand (`refresh`, also what a load error calls) and after a change. A failed
 * fetch keeps the cards it had (drawn textures stay valid) and retries later. Snapshot: undefined
 * until the first answer, then the cards by id (a missing id: draw the roster avatar).
 */
export class SignedCardsSource {
  readonly #opts: Required<SourceTiming> & Pick<SignedCardsSourceOptions, "fetch">;
  #cards: ReadonlyMap<string, SignedCard> | undefined = undefined;
  #inflight: Promise<void> | null = null;
  #timer: unknown = null;
  #started = false;
  #disposed = false;
  readonly #listeners = new Set<() => void>();
  /** Per id, stable while the card is the same asset, so hosts don't reload it on a URL refresh. */
  readonly #files = new Map<string, CardFiles>();

  constructor(opts: SignedCardsSourceOptions) {
    this.#opts = {
      now: () => Date.now(),
      timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
      refreshMarginMs: 5 * 60_000,
      retryMs: 60_000,
      ...opts,
    };
  }

  getSnapshot = (): ReadonlyMap<string, SignedCard> | undefined => this.#cards;

  /** Listens for changes; the first listener starts the fetching. */
  subscribe = (l: () => void): (() => void) => {
    this.#listeners.add(l);
    this.start();
    return () => this.#listeners.delete(l);
  };

  start(): void {
    if (this.#started || this.#disposed) return;
    this.#started = true;
    void this.refresh();
  }

  /** The first answer (fetching it if nobody has yet). */
  async ready(): Promise<ReadonlyMap<string, SignedCard> | undefined> {
    this.start();
    if (this.#inflight) await this.#inflight;
    return this.#cards;
  }

  /** Fetches now (concurrent calls share one request). */
  refresh = (): Promise<void> => {
    if (this.#disposed) return Promise.resolve();
    this.#started = true;
    this.#inflight ??= this.#fetch().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  };

  /** One card's files for a loader (late-bound: always the freshest URLs), or null without one. */
  files(id: string): CardFiles | null {
    return this.#files.get(id) ?? null;
  }

  dispose(): void {
    this.#disposed = true;
    this.#unschedule();
    this.#listeners.clear();
  }

  async #fetch(): Promise<void> {
    let next: ReadonlyMap<string, SignedCard>;
    try {
      next = await this.#opts.fetch();
    } catch {
      if (this.#disposed) return;
      if (this.#cards === undefined) this.#emit(new Map()); // can't tell: roster avatars meanwhile
      this.#schedule(this.#opts.retryMs);
      return;
    }
    if (this.#disposed) return;
    this.#emit(next);
    const soonest = Math.min(...[...next.values()].map((c) => c.expiresAt));
    // At least 10 s apart; at most what a timer can hold (a longer delay would fire at once).
    if (next.size)
      this.#schedule(Math.min(MAX_TIMER_MS, Math.max(10_000, soonest - this.#opts.refreshMarginMs - this.#opts.now())));
    else this.#unschedule();
  }

  #emit(cards: ReadonlyMap<string, SignedCard>): void {
    const prev = this.#cards;
    this.#cards = cards;
    for (const id of [...this.#files.keys()]) if (!cards.has(id)) this.#files.delete(id);
    for (const [id, card] of cards) {
      if (this.#files.has(id) && prev?.get(id)?.assetId === card.assetId) continue;
      const assetId = card.assetId;
      this.#files.set(id, {
        key: `custom:${assetId}`,
        manifest: card.manifest,
        url: (f) => {
          const c = this.#cards?.get(id);
          return c && c.assetId === assetId && Object.hasOwn(c.urls, f) ? c.urls[f] : undefined;
        },
        refresh: this.refresh,
      });
    }
    for (const l of [...this.#listeners]) l();
  }

  #schedule(ms: number): void {
    this.#unschedule();
    this.#timer = this.#opts.timers.set(() => {
      this.#timer = null;
      void this.refresh();
    }, ms);
  }

  #unschedule(): void {
    if (this.#timer !== null) this.#opts.timers.clear(this.#timer);
    this.#timer = null;
  }
}

export interface CustomCardSourceOptions extends SourceTiming {
  /** GET /v1/avatar/companion, parsed: null when there's no custom card; throws when it can't tell. */
  fetch: () => Promise<SignedCard | null>;
}

const SELF = "self";

/**
 * The person's own custom card (a SignedCardsSource of one), refreshed the same way and after a
 * change (the "use" button). Snapshot: undefined until the first answer, null for "no custom
 * card" (draw the roster avatar), or the card.
 */
export class CustomCardSource {
  readonly #inner: SignedCardsSource;
  #card: SignedCard | null | undefined = undefined;
  #from: ReadonlyMap<string, SignedCard> | undefined = undefined;

  constructor(opts: CustomCardSourceOptions) {
    const { fetch, ...timing } = opts;
    this.#inner = new SignedCardsSource({
      ...timing,
      fetch: async () => {
        const c = await fetch();
        return new Map(c ? [[SELF, c]] : []);
      },
    });
  }

  getSnapshot = (): SignedCard | null | undefined => {
    const cards = this.#inner.getSnapshot();
    if (cards !== this.#from) {
      this.#from = cards;
      this.#card = cards === undefined ? undefined : (cards.get(SELF) ?? null);
    }
    return this.#card;
  };

  subscribe = (l: () => void): (() => void) => this.#inner.subscribe(l);

  start(): void {
    this.#inner.start();
  }

  async ready(): Promise<SignedCard | null | undefined> {
    await this.#inner.ready();
    return this.getSnapshot();
  }

  refresh = (): Promise<void> => this.#inner.refresh();

  files(): CardFiles | null {
    return this.#inner.files(SELF);
  }

  dispose(): void {
    this.#inner.dispose();
  }
}
