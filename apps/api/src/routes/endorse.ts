import { Hono } from "hono";
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { fromB64url, randomBytes, toB64url, verifyEnvelope } from "@chalito/crypto";
import { generateShortCode, hashShortCode, normalizeShortCode } from "@chalito/glyph";
import {
  ApproveEndorseCodeRequest,
  CreateEndorseCodeRequest,
  ResolveEndorseCodeRequest,
  TakeEndorsementRequest,
} from "@chalito/protocol";
import type { Deps } from "../deps.js";
import { principal, requireAuth, type AuthEnv } from "../lib/auth.js";
import { checkRegistration } from "../lib/devices.js";
import { fail } from "../lib/errors.js";
import { rateLimit } from "../lib/rate-limit.js";
import { webauthnConfigFromEnv, type WebAuthnConfig } from "./webauthn.js";

export const ENDORSE_CODE_TTL_MS = 5 * 60 * 1000;
const CLIENT_KINDS = ["phone", "web"] as const;

/**
 * Endorsement handoff (ADR 0006: a new browser / desktop panel of the same account). The cloud
 * relays and records; the trusted client checks the fingerprint and signs; the server and every
 * agent verify the endorsement. Codes are random, short-lived, hashed at rest (short code) and
 * single use at each step.
 *
 *   POST /codes    new device (`user`): its self-signed registration → code + watch token
 *   POST /resolve  trusted client (`client`): code id or short code → the registration
 *   POST /approve  trusted client (`client`): signed endorsement (+ passkey step-up if it has one)
 *   POST /take     new device (`user`): the endorsement, once
 */
export const endorseRoutes = (deps: Deps, wa: WebAuthnConfig = webauthnConfigFromEnv()) => {
  const app = new Hono<AuthEnv>();

  app.post(
    "/codes",
    requireAuth(deps, ["user"]),
    rateLimit({ capacity: 10, refillPerSec: 0.1, now: deps.now }),
    async (c) => {
      const p = principal(c);
      const body = CreateEndorseCodeRequest.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return fail(400, "bad_request");
      const reg = body.data.registration;
      await checkRegistration(deps, reg, p.owner, [...CLIENT_KINDS]);
      if (await deps.repo.getDevice(p.owner, reg.body.deviceId)) return fail(409, "device_exists");
      const codeId = await toB64url(await randomBytes(16));
      const shortCode = await generateShortCode();
      const expiresAt = deps.now() + ENDORSE_CODE_TTL_MS;
      const created = await deps.repo.createEndorseCode({
        codeId,
        shortCodeHash: await hashShortCode(shortCode),
        owner: p.owner,
        registration: reg,
        expiresAt,
      });
      if (created === "exists") return fail(409, "code_exists");
      // The same scoped watcher as a pairing code: it can only listen on chalito:pairing:<codeId>.
      const watchToken = await deps.identity.mintPairingWatch(codeId);
      await deps.audit.record({
        action: "endorse.code_created",
        owner: p.owner,
        actor: p.uid,
        target: reg.body.deviceId,
      });
      return c.json({ codeId, shortCode, watchToken, expiresAt }, 201);
    },
  );

  app.post(
    "/resolve",
    requireAuth(deps, ["client"]),
    rateLimit({ capacity: 10, refillPerSec: 0.05, now: deps.now }),
    async (c) => {
      const p = principal(c);
      const body = ResolveEndorseCodeRequest.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return fail(400, "bad_request");
      let code;
      if ("codeId" in body.data) code = await deps.repo.findEndorseCode(body.data.codeId);
      else {
        const sc = normalizeShortCode(body.data.shortCode);
        if (!sc) return fail(400, "bad_request");
        code = await deps.repo.findEndorseCodeByShortHash(await hashShortCode(sc));
      }
      // Another account's code, an expired or used one: all look the same from here.
      if (!code || code.owner !== p.owner || code.expiresAt <= deps.now() || code.endorsement)
        return fail(404, "not_found");
      return c.json({ codeId: code.codeId, registration: code.registration, expiresAt: code.expiresAt });
    },
  );

  app.post("/approve", requireAuth(deps, ["client"]), async (c) => {
    const p = principal(c);
    const body = ApproveEndorseCodeRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const { codeId, endorsement: e, stepUp } = body.data;
    if (e.signerDeviceId !== p.deviceId) return fail(403, "signer_mismatch");
    const endorser = await deps.repo.getDevice(p.owner, p.deviceId!);
    if (!endorser || endorser.revoked !== false || endorser.role !== "client") return fail(403, "endorser_not_trusted");
    const sig = await verifyEnvelope(
      e,
      "chalito.endorsement.v1",
      new Map([[endorser.deviceId, await fromB64url(endorser.pubSign)]]),
    );
    if (!sig.ok) return fail(400, "bad_endorsement");

    const code = await deps.repo.findEndorseCode(codeId);
    if (!code || code.owner !== p.owner) return fail(404, "not_found");
    if (code.endorsement) return fail(409, "already_endorsed");
    if (code.expiresAt <= deps.now()) return fail(410, "expired");
    const reg = code.registration.body;
    if (
      e.body.uid !== p.owner ||
      e.body.newDeviceId !== reg.deviceId ||
      e.body.pubSign !== reg.pubSign ||
      e.body.pubBox !== reg.pubBox
    )
      return fail(400, "endorsement_mismatch");
    if (reg.deviceId === endorser.deviceId) return fail(400, "self_endorsement");
    if (Math.abs(deps.now() - e.body.issuedAt) > deps.config.skewMs * 5) return fail(400, "stale_endorsement");

    // Passkey step-up where the endorsing device has one (a server-challenged assertion).
    const cred = await deps.repo.getDeviceWebAuthn(p.owner, endorser.deviceId);
    if (cred) {
      if (!stepUp) return fail(401, "step_up_required");
      const challenge = await deps.repo.takeWebAuthnChallenge(p.owner, endorser.deviceId, "assert", deps.now());
      if (!challenge) return fail(401, "step_up_failed");
      const counter = await verifyAuthenticationResponse({
        response: stepUp as unknown as AuthenticationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: wa.origins,
        expectedRPID: wa.rpId,
        credential: {
          id: cred.credentialId,
          publicKey: new Uint8Array(await fromB64url(cred.publicKey)),
          // The counter check is the repo's atomic compare below (it also catches concurrent
          // assertions and raises the clone alert), so the library doesn't pre-empt it.
          counter: 0,
          transports: cred.transports as never,
        },
        requireUserVerification: true,
      }).then(
        (r) =>
          r.verified && r.authenticationInfo.credentialID === cred.credentialId
            ? r.authenticationInfo.newCounter
            : null,
        () => null,
      );
      if (counter === null) return fail(401, "step_up_failed");
      const bumped = await deps.repo.bumpWebAuthnCounter(p.owner, endorser.deviceId, cred.credentialId, counter);
      if (bumped === "cloned") {
        // A sign counter that didn't move forward: a copy of this passkey may exist. Refuse and alert.
        await deps.audit.record({
          action: "webauthn.clone_suspected",
          owner: p.owner,
          actor: p.uid,
          target: endorser.deviceId,
          meta: { credentialId: cred.credentialId, stored: cred.counter, reported: counter, during: "endorse.approve" },
        });
        console.warn("[api] passkey sign counter did not advance; refusing (possible cloned authenticator)");
        return fail(403, "authenticator_cloned");
      }
      if (bumped === "not_found") return fail(401, "step_up_failed");
    }

    const res = await deps.repo.approveEndorseCode(
      codeId,
      p.owner,
      { endorsement: e, endorsedByDeviceId: endorser.deviceId, endorsedAt: deps.now() },
      deps.now(),
    );
    // Lost a race with another approval, or the code expired in between.
    if (res !== "ok") return fail(res === "not_found" ? 404 : res === "expired" ? 410 : 409, res);
    await deps.audit.record({
      action: "endorse.approved",
      owner: p.owner,
      actor: p.uid,
      target: reg.deviceId,
      meta: { by: endorser.deviceId, stepUp: Boolean(cred) },
    });
    return c.json({ ok: true });
  });

  app.post("/take", requireAuth(deps, ["user"]), async (c) => {
    const p = principal(c);
    const body = TakeEndorsementRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const r = await deps.repo.takeEndorsement(body.data.codeId, p.owner, deps.now());
    if (!r.ok) return fail(r.reason === "not_found" ? 404 : r.reason === "expired" ? 410 : 409, r.reason);
    // The watcher is done (best effort; expired watchers are swept hourly anyway).
    if (deps.identity.releasePairingWatch)
      await deps.identity.releasePairingWatch(body.data.codeId).catch(() => undefined);
    return c.json({ endorsement: r.endorsement });
  });

  return app;
};
