import { createHash, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { canonicalize } from "@chalito/crypto";
import { generateShortCode, hashShortCode, normalizeShortCode, verifyGlyph } from "@chalito/glyph";
import {
  CompanionId,
  CreateRoomInviteRequest,
  CreateRoomRequest,
  GlyphPayload,
  JoinRoomRequest,
  PostRoomEventRequest,
  PromoteRoomEventRequest,
  RoomActorRequest,
  RoomReportRequest,
  RotateRoomKeyRequest,
  SetRoomRetentionRequest,
  WrapRoomKeysRequest,
} from "@chalito/protocol";
import { MemoryBuckets } from "@chalito/guard";
import type { z } from "zod";
import type { Deps } from "../deps.js";
import { principal, requireAuth, type AuthEnv } from "../lib/auth.js";
import { fail } from "../lib/errors.js";
import { rateLimit } from "../lib/rate-limit.js";
import { inviteTtlMs, roomLimitsFor, roomsConfig } from "../rooms/limits.js";
import { RoomError, type RoomsRepo } from "../rooms/repo.js";

/**
 * Rooms (brief §5 M11, ADR 0010). Every route acts for a verified client device and its owner's
 * companion; the database functions enforce the room rules again. Content arrives sealed with
 * the room key and stays opaque here. Messaging is notifications, never commands: nothing in
 * this file can create a command, a session or a prompt for any device.
 */
export const roomsRoutes = (deps: Deps & { rooms?: RoomsRepo }) => {
  const app = new Hono<AuthEnv>();
  const limiter = rateLimit({ capacity: 60, refillPerSec: 2, now: deps.now });
  const client = requireAuth(deps, ["client"]);

  const repo = (): RoomsRepo => deps.rooms ?? fail(503, "rooms_unavailable");
  const parse = async <S extends z.ZodTypeAny>(schema: S, body: unknown): Promise<z.infer<S>> => {
    const r = schema.safeParse(body);
    return r.success ? r.data : fail(400, "bad_request");
  };
  const json = (c: { req: { json(): Promise<unknown> } }) => c.req.json().catch(() => null);
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RoomError) return fail(err.status, err.code);
      throw err;
    }
  };
  const glyphHash = (g: unknown) => createHash("sha256").update(canonicalize(g)).digest("hex");

  app.use("*", client, limiter);

  /** Create: the creator's client generated epoch 1 and wrapped it to its owner's client devices. */
  app.post("/", async (c) => {
    const p = principal(c);
    const b = await parse(CreateRoomRequest, await json(c));
    const limits = roomLimitsFor(await repo().userTier(p.owner));
    const room = await run(() =>
      repo().create({
        uid: p.owner,
        companion: b.companionId,
        roomId: b.roomId,
        type: b.type,
        name: b.name,
        wrapped: b.wrappedKeys,
        roomLimit: limits.rooms,
        ttl: roomsConfig.defaults.ephemeralTtl,
        keepPromoted: roomsConfig.defaults.keepPromoted,
      }),
    );
    await deps.audit.record({
      action: "room.created",
      owner: p.owner,
      actor: p.uid,
      target: b.roomId,
      meta: { type: b.type },
    });
    return c.json(
      {
        roomId: room.room_id,
        keyEpoch: room.key_epoch,
        retention: { ephemeralTtl: room.ephemeral_ttl, keepPromoted: room.keep_promoted },
      },
      201,
    );
  });

  /**
   * Invite: the member's client signs a `room_invite` glyph with its own device key (codeId =
   * invite id). Only hashes of the glyph and of the short code are stored (ADR 0010).
   */
  app.post("/:roomId/invites", async (c) => {
    const p = principal(c);
    const b = await parse(CreateRoomInviteRequest, await json(c));
    const glyph = GlyphPayload.safeParse(b.glyph);
    if (!glyph.success || glyph.data.body.purpose !== "room_invite") return fail(400, "bad_glyph");
    const now = deps.now();
    const check = await verifyGlyph(glyph.data, now);
    if (!check.ok) return fail(400, `glyph_${check.reason}`);
    const device = await deps.repo.getDevice(p.owner, p.deviceId!);
    if (!device || device.pubSign !== glyph.data.body.issuerPubSign) return fail(403, "glyph_not_from_this_device");
    if (glyph.data.body.expiresAt > now + inviteTtlMs()) return fail(400, "invite_ttl_too_long");
    const shortCode = await generateShortCode();
    await run(async () =>
      repo().invite({
        uid: p.owner,
        companion: b.companionId,
        roomId: c.req.param("roomId"),
        inviteId: glyph.data.body.codeId,
        glyphHash: glyphHash(glyph.data),
        shortHash: await hashShortCode(shortCode),
        maxUses: b.maxUses,
        expiresAt: glyph.data.body.expiresAt,
      }),
    );
    return c.json({ inviteId: glyph.data.body.codeId, shortCode, expiresAt: glyph.data.body.expiresAt }, 201);
  });

  /** Join with an invite (typed short code or a scanned glyph). Keys are wrapped next by a member. */
  app.post("/join", async (c) => {
    const p = principal(c);
    const b = await parse(JoinRoomRequest, await json(c));
    let hash: string;
    if (b.shortCode) {
      const code = normalizeShortCode(b.shortCode);
      if (!code) return fail(400, "bad_short_code");
      hash = await hashShortCode(code);
    } else {
      const glyph = GlyphPayload.safeParse(b.glyph);
      if (!glyph.success || glyph.data.body.purpose !== "room_invite") return fail(400, "bad_glyph");
      const check = await verifyGlyph(glyph.data, deps.now());
      if (!check.ok) return fail(400, `glyph_${check.reason}`);
      hash = glyphHash(glyph.data);
    }
    // membersPerRoom follows the room owner's plan.
    const limits = roomLimitsFor(await repo().inviteOwnerTier(hash));
    const roomId = await run(() =>
      repo().join({ uid: p.owner, companion: b.companionId, hash, memberLimit: limits.membersPerRoom }),
    );
    await deps.audit.record({ action: "room.joined", owner: p.owner, actor: p.uid, target: roomId });
    return c.json({ roomId }, 201);
  });

  /** A member's devices, so a co-member's client can wrap the room key to them. */
  app.post("/:roomId/members/:companionId/devices", async (c) => {
    const p = principal(c);
    const b = await parse(RoomActorRequest, await json(c));
    const rows = await run(() =>
      repo().memberDevices({
        uid: p.owner,
        companion: b.companionId,
        roomId: c.req.param("roomId"),
        target: c.req.param("companionId"),
      }),
    );
    return c.json({ devices: rows.map((r) => ({ deviceId: r.device_id, pubBox: r.pub_box })) });
  });

  app.post("/:roomId/keys", async (c) => {
    const p = principal(c);
    const b = await parse(WrapRoomKeysRequest, await json(c));
    await run(() =>
      repo().wrapKeys({
        uid: p.owner,
        companion: b.companionId,
        roomId: c.req.param("roomId"),
        target: b.targetCompanionId,
        epoch: b.epoch,
        wrapped: b.wrappedKeys,
      }),
    );
    return c.body(null, 204);
  });

  /** Leave: the room then needs a new epoch, installed by a remaining member's client (/rotate). */
  /**
   * Report an event and/or a member to the platform. Per reporter: a burst of 10, then 20 an hour
   * (shared across instances when the api has the Postgres buckets); a repeat for the same
   * target returns the existing report (200) instead of a new one.
   */
  const reportBuckets = deps.rateBuckets ?? new MemoryBuckets();
  app.post("/:roomId/reports", async (c) => {
    const p = principal(c);
    const b = await parse(RoomReportRequest, await json(c));
    const key = createHash("sha256").update(`room.report:${p.owner}`).digest("hex");
    if (!(await reportBuckets.take(key, 10, 20 / 3600, deps.now()))) return fail(429, "rate_limited");
    const roomId = c.req.param("roomId");
    const r = await run(() =>
      repo().report({
        uid: p.owner,
        companion: b.companionId,
        roomId,
        reportId: `rpt_${randomUUID().replace(/-/g, "")}`,
        eventId: b.eventId ?? null,
        member: b.memberCompanionId ?? null,
        reason: b.reason,
        note: b.note ?? null,
        plaintext: b.attachPlaintext === true ? (b.attachedPlaintext ?? null) : null,
      }),
    );
    if (!r.duplicate)
      await deps.audit.record({
        action: "room.reported",
        owner: p.owner,
        actor: p.uid,
        target: roomId,
        meta: { reportId: r.reportId, reason: b.reason, plaintextAttached: b.attachPlaintext === true },
      });
    return c.json({ reportId: r.reportId, duplicate: r.duplicate }, r.duplicate ? 200 : 201);
  });

  app.post("/:roomId/leave", async (c) => {
    const p = principal(c);
    const b = await parse(RoomActorRequest, await json(c));
    await run(() => repo().leave({ uid: p.owner, companion: b.companionId, roomId: c.req.param("roomId") }));
    await deps.audit.record({ action: "room.left", owner: p.owner, actor: p.uid, target: c.req.param("roomId") });
    return c.body(null, 204);
  });

  /**
   * Remove a member (owner only, never the owner itself): like a leave, the room then needs a new
   * epoch (/rotate) and the removed member's devices are told to close the room channel.
   */
  app.post("/:roomId/members/:companionId/remove", async (c) => {
    const p = principal(c);
    const b = await parse(RoomActorRequest, await json(c));
    const target = await parse(CompanionId, c.req.param("companionId"));
    const roomId = c.req.param("roomId");
    await run(() => repo().removeMember({ uid: p.owner, companion: b.companionId, roomId, target }));
    await deps.audit.record({
      action: "room.member_removed",
      owner: p.owner,
      actor: p.uid,
      target: roomId,
      meta: { companionId: target },
    });
    return c.body(null, 204);
  });

  app.post("/:roomId/rotate", async (c) => {
    const p = principal(c);
    const b = await parse(RotateRoomKeyRequest, await json(c));
    await run(() =>
      repo().rotate({
        uid: p.owner,
        companion: b.companionId,
        roomId: c.req.param("roomId"),
        epoch: b.epoch,
        wrapped: b.wrappedKeys,
      }),
    );
    await deps.audit.record({
      action: "room.key_rotated",
      owner: p.owner,
      actor: p.uid,
      target: c.req.param("roomId"),
      meta: { epoch: b.epoch },
    });
    return c.body(null, 204);
  });

  /** Dissolve (owner): events, members, keys and invites go; promoted records stay with their owners. */
  app.post("/:roomId/dissolve", async (c) => {
    const p = principal(c);
    const b = await parse(RoomActorRequest, await json(c));
    await run(() => repo().dissolve({ uid: p.owner, companion: b.companionId, roomId: c.req.param("roomId") }));
    await deps.audit.record({ action: "room.dissolved", owner: p.owner, actor: p.uid, target: c.req.param("roomId") });
    return c.body(null, 204);
  });

  /**
   * Post an event. Only the protocol's notification kinds exist; the body is sealed with the room
   * key, so the api can't read it, and nothing here turns it into a command or a prompt. The
   * database stamps t and expires_at and publishes pointers on chalito:room:<id>.
   */
  app.post("/:roomId/events", async (c) => {
    const p = principal(c);
    const b = await parse(PostRoomEventRequest, await json(c));
    if (b.ct.epoch !== b.keyEpoch) return fail(400, "epoch_mismatch");
    const e = await run(() =>
      repo().post({
        uid: p.owner,
        companion: b.companionId,
        roomId: c.req.param("roomId"),
        eid: b.eid,
        to: b.to,
        kind: b.kind,
        urgency: b.urgency,
        ct: b.ct,
        epoch: b.keyEpoch,
      }),
    );
    return c.json({ eid: b.eid, t: e.t, expiresAt: e.expiresAt }, 201);
  });

  app.post("/:roomId/events/:eid/promote", async (c) => {
    const p = principal(c);
    const b = await parse(PromoteRoomEventRequest, await json(c));
    await run(() =>
      repo().promote({
        uid: p.owner,
        companion: b.companionId,
        roomId: c.req.param("roomId"),
        eid: c.req.param("eid"),
        rid: b.rid,
        kind: b.kind,
        ct: b.ct,
      }),
    );
    await deps.audit.record({
      action: "room.promoted",
      owner: p.owner,
      actor: p.uid,
      target: c.req.param("roomId"),
      meta: { eid: c.req.param("eid"), rid: b.rid },
    });
    return c.body(null, 204);
  });

  /** Retention (owner only), audited; members see it on the room row. */
  app.post("/:roomId/retention", async (c) => {
    const p = principal(c);
    const b = await parse(SetRoomRetentionRequest, await json(c));
    if (!roomsConfig.allowedEphemeralTtl.includes(b.retention.ephemeralTtl)) return fail(400, "ttl_not_allowed");
    const before = await repo().room(c.req.param("roomId"));
    const r = await run(() =>
      repo().setRetention({
        uid: p.owner,
        companion: b.companionId,
        roomId: c.req.param("roomId"),
        ttl: b.retention.ephemeralTtl,
        keepPromoted: b.retention.keepPromoted,
      }),
    );
    await deps.audit.record({
      action: "room.retention_changed",
      owner: p.owner,
      actor: p.uid,
      target: c.req.param("roomId"),
      meta: {
        from: before ? { ephemeralTtl: before.ephemeral_ttl, keepPromoted: before.keep_promoted } : null,
        to: { ephemeralTtl: r.ephemeral_ttl, keepPromoted: r.keep_promoted },
      },
    });
    return c.json({ retention: { ephemeralTtl: r.ephemeral_ttl, keepPromoted: r.keep_promoted } });
  });

  return app;
};
