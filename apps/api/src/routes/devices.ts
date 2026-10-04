import { Hono } from "hono";
import { fromB64url, verifyEnvelope } from "@chalito/crypto";
import {
  EnrollEndorsedClientRequest,
  EnrollFirstClientRequest,
  RefreshChallenge,
  RevokeDeviceRequest,
} from "@chalito/protocol";
import type { Deps } from "../deps.js";
import { deviceUid, principal, requireAuth, type AuthEnv } from "../lib/auth.js";
import { buildDeviceDoc, checkRegistration, mintDeviceToken } from "../lib/devices.js";
import { fail } from "../lib/errors.js";
import { rateLimit } from "../lib/rate-limit.js";
import { hashRecoveryCode } from "../lib/recovery.js";

const CLIENT_KINDS = ["phone", "web"] as const;

export const deviceRoutes = (deps: Deps) => {
  const app = new Hono<AuthEnv>();

  /** First trusted client (the phone). Only while the account has no active client. */
  app.post("/first", requireAuth(deps, ["user"]), async (c) => {
    const p = principal(c);
    const body = EnrollFirstClientRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const reg = body.data.registration;
    await checkRegistration(deps, reg, p.owner, [...CLIENT_KINDS]);
    const doc = await buildDeviceDoc(deps, {
      owner: p.owner,
      deviceId: reg.body.deviceId,
      kind: reg.body.kind,
      platform: reg.body.platform,
      name: reg.body.name,
      role: "client",
      pubSign: reg.body.pubSign,
      pubBox: reg.body.pubBox,
      enrolledVia: "first_client",
      endorsedBy: null,
    });
    const recovery = await hashRecoveryCode(body.data.recoveryCode);
    const devices = deps.db.collection(`users/${p.owner}/devices`);
    await deps.db.runTransaction(async (tx) => {
      const active = await tx.get(devices.where("role", "==", "client").where("revoked", "==", false).limit(1));
      if (!active.empty) fail(409, "client_exists", "Add new phones with an endorsement from a trusted one.");
      const ref = devices.doc(doc.deviceId);
      if ((await tx.get(ref)).exists) fail(409, "device_exists");
      tx.create(ref, doc);
      tx.set(deps.db.doc(`users/${p.owner}/private/recovery`), {
        ...recovery,
        cooldownUntil: null,
        createdAt: deps.now(),
      });
    });
    await deps.audit.record({
      action: "device.enrolled",
      owner: p.owner,
      actor: p.uid,
      target: doc.deviceId,
      meta: { via: "first_client" },
    });
    return c.json(
      { customToken: await mintDeviceToken(deps, p.owner, doc.deviceId, "client"), deviceId: doc.deviceId },
      201,
    );
  });

  /** Additional client endorsed by an active client. Agents still verify the endorsement locally. */
  app.post("/endorsed", requireAuth(deps, ["user"]), async (c) => {
    const p = principal(c);
    const body = EnrollEndorsedClientRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const { registration: reg, endorsement: e } = body.data;
    await checkRegistration(deps, reg, p.owner, [...CLIENT_KINDS]);
    if (
      e.body.uid !== p.owner ||
      e.body.newDeviceId !== reg.body.deviceId ||
      e.body.pubSign !== reg.body.pubSign ||
      e.body.pubBox !== reg.body.pubBox
    ) {
      fail(400, "endorsement_mismatch");
    }
    if (Math.abs(deps.now() - e.body.issuedAt) > 24 * 60 * 60 * 1000) fail(400, "stale_endorsement");
    const signer = await deps.db.doc(`users/${p.owner}/devices/${e.signerDeviceId}`).get();
    if (!signer.exists || signer.get("revoked") !== false || signer.get("role") !== "client")
      fail(403, "endorser_not_trusted");
    const ok = await verifyEnvelope(
      e,
      "chalito.endorsement.v1",
      new Map([[e.signerDeviceId, await fromB64url(signer.get("pubSign"))]]),
    );
    if (!ok.ok) fail(400, "bad_endorsement");
    const doc = await buildDeviceDoc(deps, {
      owner: p.owner,
      deviceId: reg.body.deviceId,
      kind: reg.body.kind,
      platform: reg.body.platform,
      name: reg.body.name,
      role: "client",
      pubSign: reg.body.pubSign,
      pubBox: reg.body.pubBox,
      enrolledVia: "endorsement",
      endorsedBy: e.signerDeviceId,
    });
    try {
      await deps.db.doc(`users/${p.owner}/devices/${doc.deviceId}`).create(doc);
    } catch (err) {
      if ((err as { code?: number }).code === 6) return fail(409, "device_exists");
      throw err;
    }
    await deps.db.doc(`users/${p.owner}/endorsements/${doc.deviceId}`).set({ ...e, createdAt: deps.now() });
    await deps.audit.record({
      action: "device.enrolled",
      owner: p.owner,
      actor: p.uid,
      target: doc.deviceId,
      meta: { via: "endorsement", by: e.signerDeviceId },
    });
    return c.json(
      { customToken: await mintDeviceToken(deps, p.owner, doc.deviceId, "client"), deviceId: doc.deviceId },
      201,
    );
  });

  /** Device credential refresh: a fresh signature over a one-time challenge. No bearer secret on disk. */
  app.post("/token", rateLimit({ capacity: 30, refillPerSec: 0.5, now: deps.now }), async (c) => {
    const body = RefreshChallenge.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const ch = body.data;
    if (ch.signerDeviceId !== ch.body.deviceId) fail(400, "signer_mismatch");
    if (Math.abs(deps.now() - ch.body.issuedAt) > deps.config.skewMs) fail(400, "stale_request");
    const ref = deps.db.doc(`users/${ch.body.owner}/devices/${ch.body.deviceId}`);
    const snap = await ref.get();
    if (!snap.exists || snap.get("revoked") !== false) fail(403, "device_revoked");
    const ok = await verifyEnvelope(
      ch,
      "chalito.refresh-challenge.v1",
      new Map([[ch.body.deviceId, await fromB64url(snap.get("pubSign"))]]),
    );
    if (!ok.ok) fail(401, "bad_signature");
    try {
      await deps.db
        .doc(`deviceNonces/${ch.body.deviceId}_${ch.body.nonce}`)
        .create({ expireAt: new Date(ch.body.issuedAt + deps.config.skewMs * 2) });
    } catch (err) {
      if ((err as { code?: number }).code === 6) return fail(409, "replayed_nonce");
      throw err;
    }
    await ref.update({ lastSeenAt: deps.now() });
    const role = snap.get("role") as "client" | "agent";
    return c.json({
      customToken: await mintDeviceToken(deps, ch.body.owner, ch.body.deviceId, role),
      deviceId: ch.body.deviceId,
    });
  });

  /** Revoke any device of the account from an active client (or the device itself). */
  app.post("/revoke", requireAuth(deps, ["client"]), async (c) => {
    const p = principal(c);
    const body = RevokeDeviceRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const ref = deps.db.doc(`users/${p.owner}/devices/${body.data.deviceId}`);
    const snap = await ref.get();
    if (!snap.exists) fail(404, "not_found");
    if (snap.get("revoked") === true) return c.json({ ok: true, alreadyRevoked: true });
    await ref.update({ revoked: true, revokedAt: deps.now(), revokedBy: p.deviceId });
    const uid = deviceUid(body.data.deviceId);
    await deps.auth.updateUser(uid, { disabled: true }).catch(() => undefined);
    await deps.auth.revokeRefreshTokens(uid).catch(() => undefined);
    await deps.audit.record({ action: "device.revoked", owner: p.owner, actor: p.uid, target: body.data.deviceId });
    return c.json({ ok: true });
  });

  return app;
};
