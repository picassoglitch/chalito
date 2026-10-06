/**
 * Custom companions (/v1/avatar on apps/api): a photo of the person becomes their own companion in
 * the Chalito style, with the roster's five drawings. The first one is free; later ones cost hub
 * tokens (never money). The photo goes straight to the bucket through a signed PUT, is only a
 * reference, and is deleted as soon as the character is made.
 */
import { parseRoomCards, parseSignedCard, type SignedCard } from "@chalito/scene/custom-card";

export const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];
/** The server's limit (apps/api src/avatar/routes.ts UPLOAD_MAX_BYTES). */
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;

export type CreationStatus = "awaiting_upload" | "queued" | "generating" | "succeeded" | "failed" | "expired";
export type CreationFailure = "rejected" | "refused" | "provider" | "upload_missing" | "timeout";

export interface CustomCard {
  /** emotion → layer file, and thumbnail size → file (keys of `urls`). */
  emotions: Record<string, string>;
  thumbs: Record<string, string>;
  /** file → short-lived signed URL. */
  urls: Record<string, string>;
}

export interface Creation {
  creationId: string;
  status: CreationStatus;
  free: boolean;
  priceTokens: number;
  failure?: CreationFailure;
  card?: CustomCard;
}

export interface Quote {
  free: boolean;
  priceTokens: number;
  dailyLeft: number;
  active: Creation | null;
}

export type StartResult =
  | { ok: true; creation: Creation; upload: { url: string; headers: Record<string, string> } }
  | { ok: false; reason: "no_tokens"; chipHref: string }
  | { ok: false; reason: "busy" | "daily_limit" | "retry" | "failed" };

export interface AvatarApi {
  quote(): Promise<Quote | "error">;
  start(creationId: string, contentType: PhotoType): Promise<StartResult>;
  /** PUT the photo to the signed URL; true when the bucket took it. */
  upload(target: { url: string; headers: Record<string, string> }, photo: Blob): Promise<boolean>;
  uploaded(creationId: string): Promise<Creation | "error">;
  status(creationId: string): Promise<Creation | "error">;
  /** The companion wears this creation (null: back to its roster avatar). */
  use(creationId: string | null): Promise<"ok" | "no_companion" | "error">;
  /** The companion's custom card with fresh signed URLs (GET /companion); null when it wears a roster avatar. */
  companion(): Promise<SignedCard | null | "error">;
  /** A room's members' custom cards by companion id (GET /rooms/:roomId/cards; members only). */
  roomCards(roomId: string): Promise<Map<string, SignedCard> | "error">;
}

/** One per "create" tap, reused on retries: 16–64 of [A-Za-z0-9_-]. */
export const newCreationId = (): string => `cr_${crypto.randomUUID().replaceAll("-", "")}`;

export const isActive = (s: CreationStatus) => s === "awaiting_upload" || s === "queued" || s === "generating";

/** What the browser checks before uploading (the server and the job check again). */
export const checkPhoto = (f: { type: string; size: number }): "ok" | "type" | "size" => {
  if (!(PHOTO_TYPES as readonly string[]).includes(f.type)) return "type";
  if (f.size <= 0 || f.size > PHOTO_MAX_BYTES) return "size";
  return "ok";
};

const STATUSES: readonly string[] = ["awaiting_upload", "queued", "generating", "succeeded", "failed", "expired"];
const FAILURES: readonly string[] = ["rejected", "refused", "provider", "upload_missing", "timeout"];
const FILE = /^[a-z0-9-]+\.webp$/;
/** Signed URLs come from the bucket host only. */
const SIGNED = /^https:\/\/storage\.googleapis\.com\//;

const strMap = (v: unknown, ok: (k: string, v: string) => boolean): Record<string, string> | null => {
  if (!v || typeof v !== "object") return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x !== "string" || !ok(k, x)) return null;
    out[k] = x;
  }
  return out;
};

const parseCard = (v: unknown): CustomCard | null => {
  const c = v as { manifest?: { emotions?: { src?: unknown }; thumbs?: unknown }; urls?: unknown } | null;
  const urls = strMap(c?.urls, (k, u) => FILE.test(k) && SIGNED.test(u));
  const emotions = strMap(c?.manifest?.emotions?.src, (k, f) => /^[a-z]{1,20}$/.test(k) && FILE.test(f));
  const thumbs = strMap(c?.manifest?.thumbs, (k, f) => /^\d{2,4}$/.test(k) && FILE.test(f));
  if (!urls || !emotions || !thumbs || !emotions.neutral) return null;
  if (![...Object.values(emotions), ...Object.values(thumbs)].every((f) => f in urls)) return null;
  return { emotions, thumbs, urls };
};

export const parseCreation = (v: unknown): Creation | null => {
  const b = v as Record<string, unknown> | null;
  if (
    !b ||
    typeof b.creationId !== "string" ||
    !STATUSES.includes(b.status as string) ||
    typeof b.free !== "boolean" ||
    typeof b.priceTokens !== "number" ||
    !Number.isFinite(b.priceTokens) ||
    (b.failure !== undefined && !FAILURES.includes(b.failure as string))
  )
    return null;
  const card = b.status === "succeeded" ? parseCard(b.card) : null;
  if (b.status === "succeeded" && !card) return null;
  return {
    creationId: b.creationId,
    status: b.status as CreationStatus,
    free: b.free,
    priceTokens: b.priceTokens,
    ...(b.failure ? { failure: b.failure as CreationFailure } : {}),
    ...(card ? { card } : {}),
  };
};

/** The api's chip, if it's a same-site path; otherwise the credits page. */
const chipHref = (body: unknown): string => {
  const href = (body as { chips?: { href?: unknown }[] } | null)?.chips?.[0]?.href;
  return typeof href === "string" && /^\/(?![/\\])/.test(href) ? href : "/creditos";
};

export const httpAvatar = (
  base: string,
  token: () => Promise<string | null>,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): AvatarApi => {
  const call = async (path: string, body?: unknown): Promise<Response | null> => {
    const bearer = await token();
    if (!base || !bearer) return null;
    try {
      return await fetchImpl(`${base}/v1/avatar${path}`, {
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
  const json = (r: Response) => r.json().catch(() => null) as Promise<unknown>;
  const creation = async (r: Response | null) => (r?.ok ? (parseCreation(await json(r)) ?? "error") : "error");
  return {
    quote: async () => {
      const r = await call("/quote");
      if (!r?.ok) return "error";
      const b = (await json(r)) as Record<string, unknown> | null;
      if (!b || typeof b.free !== "boolean" || typeof b.priceTokens !== "number" || typeof b.dailyLeft !== "number")
        return "error";
      const active = b.active ? parseCreation(b.active) : null;
      return { free: b.free, priceTokens: b.priceTokens, dailyLeft: b.dailyLeft, active };
    },
    start: async (creationId, contentType) => {
      const r = await call("/creations", { creationId, contentType });
      if (!r || r.status >= 500) return { ok: false, reason: "retry" };
      const b = (await json(r)) as { error?: unknown; upload?: { url?: unknown; headers?: unknown } } | null;
      if (r.status === 402 && b?.error === "no_tokens")
        return { ok: false, reason: "no_tokens", chipHref: chipHref(b) };
      if (r.status === 409 && b?.error === "busy") return { ok: false, reason: "busy" };
      if (r.status === 429) return { ok: false, reason: b?.error === "daily_limit" ? "daily_limit" : "retry" };
      const c = r.ok ? parseCreation(b) : null;
      const headers = strMap(b?.upload?.headers, (k) => k === "content-type" || k.startsWith("x-goog-"));
      if (!c || typeof b?.upload?.url !== "string" || !SIGNED.test(b.upload.url) || !headers)
        return { ok: false, reason: "failed" };
      return { ok: true, creation: c, upload: { url: b.upload.url, headers } };
    },
    upload: async (target, photo) => {
      try {
        const r = await fetchImpl(target.url, { method: "PUT", headers: target.headers, body: photo });
        return r.ok;
      } catch {
        return false;
      }
    },
    uploaded: async (creationId) => creation(await call(`/creations/${encodeURIComponent(creationId)}/uploaded`, {})),
    status: async (creationId) => creation(await call(`/creations/${encodeURIComponent(creationId)}`)),
    use: async (creationId) => {
      const r = await call("/use", { creationId });
      if (r?.ok) return "ok";
      const e = r ? ((await json(r)) as { error?: unknown } | null)?.error : null;
      return e === "no_companion" ? "no_companion" : "error";
    },
    companion: async () => {
      const r = await call("/companion");
      if (!r?.ok) return "error";
      const c = parseSignedCard(await json(r), { now: Date.now(), isUrl: (u) => SIGNED.test(u) });
      return c === "invalid" ? "error" : c;
    },
    roomCards: async (roomId) => {
      const r = await call(`/rooms/${encodeURIComponent(roomId)}/cards`);
      if (!r?.ok) return "error";
      const m = parseRoomCards(await json(r), { now: Date.now(), isUrl: (u) => SIGNED.test(u) });
      return m === "invalid" ? "error" : m;
    },
  };
};
