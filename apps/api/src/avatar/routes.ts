import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { HubUnavailable, type AvatarQuote, type HubClient } from "@chalito/billing";
import { errorMessage } from "@chalito/redact";
import type { Deps } from "../deps.js";
import { principal, requireAuth, type AuthEnv } from "../lib/auth.js";
import { fail } from "../lib/errors.js";
import { rateLimit } from "../lib/rate-limit.js";
import { cardObject, uploadObject, type AvatarFiles } from "./files.js";
import { freeMarkers } from "./free-marker.js";
import { UPLOAD_TYPES, type AvatarRepo, type CardManifestLike, type CreationRecord } from "./repo.js";

export interface AvatarDeps {
  repo: AvatarRepo;
  files: AvatarFiles;
  hub: Pick<HubClient, "admit" | "settle">;
  /** What one creation costs and reserves (avatarQuote from @chalito/billing, prices.yaml). */
  quote: AvatarQuote;
  /** Keys the free-creation markers (src/avatar/free-marker.ts markerKey). */
  markerKey: string;
}

/** The job's own limit (apps/avatar-jobs src/process.ts LIMITS.maxBytes); the signed PUT enforces it too. */
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
/** How long a signed upload URL lives. */
export const UPLOAD_URL_SECONDS = 15 * 60;
/** A creation nobody uploaded to by then expires (its reservation is cancelled). */
export const UPLOAD_WINDOW_MS = 30 * 60_000;
/** A creation still queued or generating this long after its upload window is a failure (timeout). */
export const GENERATION_TIMEOUT_MS = 20 * 60_000;
/** Creations an owner may start per rolling 24 h, failures included (each one costs image calls). */
export const DAILY_CREATIONS = 5;
/** Signed read URLs for the finished card. */
export const READ_URL_SECONDS = 60 * 60;
/** Signed read URLs for a co-member's card: shorter, since they reach other people. */
export const ROOM_READ_URL_SECONDS = 15 * 60;
const RoomId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
/** The hub reservation outlives the upload window plus generation. */
const RESERVATION_TTL_SECONDS = 60 * 60;

const CreationId = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/);
/**
 * Self-attestation, required on every start (owner decision 2026-10-05): the photo is of the person,
 * they're 13 or older and, at 13–17, a parent or guardian allows it. "under_13" is accepted only to
 * answer it with a clear refusal. Recorded on the creation (migration 20261005000200).
 */
const AttestationIn = z.object({
  ownPhoto: z.boolean(),
  ageBand: z.enum(["under_13", "13_17", "18_plus"]),
  guardianConsent: z.boolean().optional(),
});
const Start = z.object({
  creationId: CreationId,
  contentType: z.enum(UPLOAD_TYPES),
  attestation: AttestationIn.optional(),
  /** Onboarding: the companion wears the card as soon as it's ready. */
  useWhenReady: z.boolean().optional(),
});
const Use = z.object({ creationId: CreationId.nullable() });

/** 128 random bits, lowercase hex: a valid path segment for the job (and companions.asset_id). */
const newAssetId = () => randomBytes(16).toString("hex");

const noTokens = () => ({ error: "no_tokens", chips: [{ label: "¿Por qué?", href: "/creditos" }] });

/**
 * Custom companions (photo → the roster's five drawings in the Chalito style, apps/avatar-jobs).
 *
 *   POST /creations           start: needs the self-attestation (own photo, 13+, guardian at 13–17);
 *                             free if it's the person's first, otherwise admitted by the hub before
 *                             any work; answers a signed PUT for the photo
 *   POST /creations/:id/uploaded  the photo is up (the bucket's finalize event starts the job)
 *   GET  /creations/:id       status; the finished card with signed URLs
 *   POST /use                 the companion wears that card (or, with null, its roster avatar again)
 *   GET  /quote, GET /companion
 *   GET  /rooms/:roomId/cards  co-members' custom cards (members of that room only, 15-minute URLs)
 *
 * The job bills a paid success (image.generations at the real cost; the hub adds its margin) and
 * deletes the photo in every outcome. The api settles the hub reservation once a creation is
 * terminal: succeeded → succeeded, anything else → cancelled (a failure is never charged).
 */
export const avatarRoutes = (deps: Deps, av: AvatarDeps) => {
  const app = new Hono<AuthEnv>();
  const auth = requireAuth(deps, ["user", "client"]);
  const limiter = rateLimit({ capacity: 30, refillPerSec: 1, now: deps.now });
  // Starting costs image calls: a tight per-IP bucket on top of the daily per-owner cap.
  const startLimiter = rateLimit({ capacity: 10, refillPerSec: 1 / 60, now: deps.now });

  const settle = async (c: CreationRecord) => {
    if (!c.reservationId || c.settled) return;
    try {
      const r = await av.hub.settle({
        reservation_id: c.reservationId,
        outcome: c.status === "succeeded" ? "succeeded" : "cancelled",
      });
      if (r.ok || r.closed) await av.repo.markSettled(c.creationId, deps.now());
      else console.error("[avatar] settle failed", r.httpStatus);
    } catch (err) {
      // The reservation expires on the hub by itself; the next poll tries again.
      console.error("[avatar] settle failed", errorMessage(err));
    }
  };

  /** Moves a stale creation on (expired upload, stuck job), deletes a leftover photo, settles. */
  const reconcile = async (c: CreationRecord): Promise<CreationRecord> => {
    const now = deps.now();
    let moved = false;
    if (c.status === "awaiting_upload" && now > c.uploadDeadline)
      moved = await av.repo.expire(c.creationId, c.status, now);
    else if ((c.status === "queued" || c.status === "generating") && now > c.uploadDeadline + GENERATION_TIMEOUT_MS)
      moved = await av.repo.expire(c.creationId, c.status, now);
    if (moved) {
      // Never keep a photo: whatever was uploaded for a creation that won't run goes now.
      await av.files.deleteAll(uploadObject(c.owner, c.assetId)).catch((err: unknown) => {
        console.error("[avatar] delete upload failed", errorMessage(err));
      });
    }
    const fresh = moved ? ((await av.repo.get(c.creationId)) ?? c) : c;
    if (fresh.reservationId && !fresh.settled && ["succeeded", "failed", "expired"].includes(fresh.status)) {
      await settle(fresh);
      return (await av.repo.get(c.creationId)) ?? fresh;
    }
    return fresh;
  };

  /** The card's files as signed reads, and when they stop working (taken before signing: never late). */
  const cardUrls = async (owner: string, assetId: string, manifest: CardManifestLike, ttl = READ_URL_SECONDS) => {
    const expiresAt = deps.now() + ttl * 1000;
    const files = new Set([...Object.values(manifest.emotions?.src ?? {}), ...Object.values(manifest.thumbs ?? {})]);
    const urls: Record<string, string> = {};
    for (const f of files)
      if (/^[a-z0-9-]+\.webp$/.test(f)) urls[f] = await av.files.signedRead(cardObject(owner, assetId, f), ttl);
    return { manifest, urls, expiresAt };
  };

  const view = async (c: CreationRecord) => ({
    creationId: c.creationId,
    status: c.status,
    free: c.free,
    priceTokens: c.free ? 0 : av.quote.priceTokens,
    ...(c.failure ? { failure: c.failure } : {}),
    ...(c.status === "succeeded" && c.manifest ? { card: await cardUrls(c.owner, c.assetId, c.manifest) } : {}),
  });

  const upload = (c: CreationRecord) =>
    av.files.signedUpload(uploadObject(c.owner, c.assetId), c.contentType, UPLOAD_MAX_BYTES, UPLOAD_URL_SECONDS);

  const owned = async (owner: string, creationId: string) => {
    if (!CreationId.safeParse(creationId).success) return fail(400, "bad_request");
    const c = await av.repo.get(creationId);
    if (!c || c.owner !== owner) return fail(404, "unknown_creation");
    return c;
  };

  /** Free eligibility: once per person (this account, or a deleted one with the same hub id or email). */
  const freeFor = async (owner: string) =>
    av.repo.freeAvailable(owner, freeMarkers(av.markerKey, owner, await av.repo.ownerEmail(owner)));

  app.get("/quote", auth, limiter, async (c) => {
    const p = principal(c);
    for (const u of await av.repo.unsettled(p.owner)) await settle(u);
    let active = await av.repo.active(p.owner);
    if (active) active = await reconcile(active);
    const started = await av.repo.startedSince(p.owner, deps.now() - 24 * 3_600_000);
    return c.json({
      free: await freeFor(p.owner),
      priceTokens: av.quote.priceTokens,
      dailyLeft: Math.max(0, DAILY_CREATIONS - started),
      active: active && !["succeeded", "failed", "expired"].includes(active.status) ? await view(active) : null,
    });
  });

  app.post("/creations", auth, startLimiter, async (c) => {
    const p = principal(c);
    const body = Start.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const { creationId, contentType, attestation, useWhenReady = false } = body.data;
    if (!attestation?.ownPhoto) return fail(400, "attestation_required");
    if (attestation.ageBand === "under_13") return fail(403, "age_refused");
    if (attestation.ageBand === "13_17" && attestation.guardianConsent !== true) return fail(403, "guardian_required");
    const ageBand = attestation.ageBand;

    // A retry of a start: answer it again (a fresh upload URL while it waits), never admit twice.
    const prior = await av.repo.get(creationId);
    if (prior) {
      if (prior.owner !== p.owner) return fail(409, "creation_id_conflict");
      const now = await reconcile(prior);
      return c.json({
        ...(await view(now)),
        ...(now.status === "awaiting_upload" ? { upload: await upload(now) } : {}),
        replay: true,
      });
    }

    if ((await av.repo.startedSince(p.owner, deps.now() - 24 * 3_600_000)) >= DAILY_CREATIONS)
      return fail(429, "daily_limit");
    const active = await av.repo.active(p.owner);
    if (active && ["awaiting_upload", "queued", "generating"].includes((await reconcile(active)).status))
      return c.json({ error: "busy", creationId: active.creationId }, 409);

    const markers = freeMarkers(av.markerKey, p.owner, await av.repo.ownerEmail(p.owner));
    const free = await av.repo.freeAvailable(p.owner, markers);
    let reservationId: string | null = null;
    if (!free) {
      let admit;
      try {
        admit = await av.hub.admit({
          external_user_id: p.owner,
          external_job_id: `avatar:${creationId}`,
          class: "job",
          operation: "avatar.create",
          est_tokens: av.quote.estTokens,
          ttl_seconds: RESERVATION_TTL_SECONDS,
        });
      } catch (err) {
        if (err instanceof HubUnavailable) return fail(503, "hub_unavailable");
        throw err;
      }
      if (!admit.allowed) {
        if (admit.reason === "no_tokens") return c.json(noTokens(), 402);
        return fail(402, "not_admitted", admit.reason);
      }
      // An admit is not a balance check: a balance short of the price is no_tokens too.
      if (!admit.balance.unlimited && admit.balance.remaining < av.quote.priceTokens) {
        await av.hub.settle({ reservation_id: admit.reservation_id, outcome: "cancelled" });
        return c.json(noTokens(), 402);
      }
      reservationId = admit.reservation_id;
    }

    const now = deps.now();
    const result = await av.repo.insert({
      creationId,
      owner: p.owner,
      assetId: newAssetId(),
      free,
      reservationId,
      estTokens: free ? null : av.quote.estTokens,
      contentType,
      uploadDeadline: now + UPLOAD_WINDOW_MS,
      createdAt: now,
      attestation: { ownPhoto: true, ageBand, guardianConsent: ageBand === "13_17", at: now },
      useWhenReady,
      freeMarkers: free ? markers : null,
    });
    if (result === "duplicate_id") {
      // A concurrent retry with the same id won: same external_job_id, so the same reservation. Keep it.
      const won = await av.repo.get(creationId);
      if (!won || won.owner !== p.owner) return fail(409, "creation_id_conflict");
      return c.json({ ...(await view(won)), replay: true });
    }
    if (result !== "inserted") {
      if (reservationId) await av.hub.settle({ reservation_id: reservationId, outcome: "cancelled" });
      return c.json({ error: "busy" }, 409);
    }
    const created = (await av.repo.get(creationId))!;
    await deps.audit.record({
      action: "avatar.create",
      owner: p.owner,
      actor: p.uid,
      target: creationId,
      meta: { free, useWhenReady },
    });
    return c.json({ ...(await view(created)), upload: await upload(created) }, 201);
  });

  app.post("/creations/:id/uploaded", auth, limiter, async (c) => {
    const p = principal(c);
    let cr = await reconcile(await owned(p.owner, c.req.param("id")));
    if (cr.status === "awaiting_upload") {
      const obj = await av.files.stat(uploadObject(cr.owner, cr.assetId));
      if (!obj) return fail(409, "upload_missing");
      await av.repo.markQueued(cr.creationId);
      cr = (await av.repo.get(cr.creationId))!;
    }
    return c.json(await view(cr));
  });

  app.get("/creations/:id", auth, limiter, async (c) => {
    const p = principal(c);
    return c.json(await view(await reconcile(await owned(p.owner, c.req.param("id")))));
  });

  app.post("/use", auth, limiter, async (c) => {
    const p = principal(c);
    const body = Use.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    if (body.data.creationId === null) {
      if (!(await av.repo.setCompanion(p.owner, null))) return fail(404, "no_companion");
      return c.json({ ok: true, assetId: null });
    }
    const cr = await owned(p.owner, body.data.creationId);
    if (cr.status !== "succeeded" || !cr.manifest) return fail(409, "not_ready");
    if (!(await av.repo.setCompanion(p.owner, { assetId: cr.assetId, manifest: cr.manifest })))
      return fail(404, "no_companion");
    await deps.audit.record({ action: "avatar.use", owner: p.owner, actor: p.uid, target: cr.creationId });
    return c.json({ ok: true, assetId: cr.assetId });
  });

  /** The companion's custom card with signed URLs (the renderers load it like a roster card). */
  app.get("/companion", auth, limiter, async (c) => {
    const p = principal(c);
    const card = await av.repo.companionCard(p.owner);
    if (!card) return c.json({ assetId: null });
    return c.json({ assetId: card.assetId, card: await cardUrls(p.owner, card.assetId, card.manifest) });
  });

  /**
   * The custom cards of a room's members, so the room scene draws everyone as they look. Only for a
   * caller who is a member of that room right now (anyone else gets no cards, whether or not the
   * room exists); URLs live 15 minutes and are re-asked for before then.
   */
  app.get("/rooms/:roomId/cards", auth, limiter, async (c) => {
    const p = principal(c);
    const roomId = c.req.param("roomId");
    if (!RoomId.safeParse(roomId).success) return fail(400, "bad_request");
    const rows = await av.repo.roomCards(p.owner, roomId);
    const cards = [];
    for (const r of rows)
      cards.push({
        companionId: r.companionId,
        assetId: r.assetId,
        card: await cardUrls(r.owner, r.assetId, r.manifest, ROOM_READ_URL_SECONDS),
      });
    return c.json({ cards });
  });

  return app;
};
