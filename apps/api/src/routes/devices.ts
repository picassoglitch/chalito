import { Hono } from "hono";
import { fromB64url, verifyEnvelope } from "@chalito/crypto";
import {
  EnrollEndorsedClientRequest,
  EnrollFirstClientRequest,
  RefreshChallenge,
  RevokeDeviceRequest,
} from "@chalito/protocol";
import type { Deps } from "../deps.js";
import { endDeviceVoice } from "../voice/routes.js";
import { principal, requireAuth, type AuthEnv } from "../lib/auth.js";
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
    const enrolled = await deps.repo.enrollFirstClient(p.owner, doc, {
      ...recovery,
      cooldownUntil: null,
      createdAt: deps.now(),
    });
    if (enrolled === "client_exists")
      fail(409, "client_exists", "Add new phones with an endorsement from a trusted one.");
    if (enrolled === "device_exists") fail(409, "device_exists");
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
    const signer = await deps.repo.getDevice(p.owner, e.signerDeviceId);
    if (!signer || signer.revoked !== false || signer.role !== "client") return fail(403, "endorser_not_trusted");
    const ok = await verifyEnvelope(
      e,
      "chalito.endorsement.v1",
      new Map([[e.signerDeviceId, await fromB64url(signer.pubSign)]]),
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
    if ((await deps.repo.createDevice(p.owner, doc)) === "exists") return fail(409, "device_exists");
    await deps.repo.saveEndorsement(p.owner, doc.deviceId, e, deps.now());
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
    const device = await deps.repo.getDevice(ch.body.owner, ch.body.deviceId);
    if (!device || device.revoked !== false) return fail(403, "device_revoked");
    const ok = await verifyEnvelope(
      ch,
      "chalito.refresh-challenge.v1",
      new Map([[ch.body.deviceId, await fromB64url(device.pubSign)]]),
    );
    if (!ok.ok) fail(401, "bad_signature");
    if (!(await deps.repo.claimDeviceNonce(ch.body.deviceId, ch.body.nonce, ch.body.issuedAt + deps.config.skewMs * 2)))
      return fail(409, "replayed_nonce");
    await deps.repo.touchDevice(ch.body.owner, ch.body.deviceId, deps.now());
    const role = device.role;
    const customToken = await mintDeviceToken(deps, ch.body.owner, ch.body.deviceId, role);
    // The agent has its own credential now: the pairing watcher it was claimed through is done.
    if (role === "agent" && deps.identity.releasePairingWatch) {
      try {
        for (const codeId of await deps.repo.releasePairingWatches(ch.body.owner, ch.body.deviceId))
          await deps.identity.releasePairingWatch(codeId);
      } catch (err) {
        console.error("[api] pairing watch release failed", err instanceof Error ? err.message : "error");
      }
    }
    return c.json({ customToken, deviceId: ch.body.deviceId });
  });

  /** Revoke any device of the account from an active client (or the device itself). */
  app.post("/revoke", requireAuth(deps, ["client"]), async (c) => {
    const p = principal(c);
    const body = RevokeDeviceRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const res = await deps.repo.revokeDevice(p.owner, body.data.deviceId, deps.now(), p.deviceId);
    if (res === "not_found") return fail(404, "not_found");
    if (res === "already_revoked") return c.json({ ok: true, alreadyRevoked: true });
    await deps.identity.disableDevice(body.data.deviceId);
    // Its desktop voice call ends now (billed to this moment), not when the client notices.
    if (deps.voice) await endDeviceVoice(deps, deps.voice, p.owner, body.data.deviceId);
    await deps.audit.record({ action: "device.revoked", owner: p.owner, actor: p.uid, target: body.data.deviceId });
    return c.json({ ok: true });
  });

  return app;
};
