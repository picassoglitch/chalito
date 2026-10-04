import { Hono } from "hono";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { toB64url } from "@chalito/crypto";
import type { Deps } from "../deps.js";
import { principal, requireAuth, type AuthEnv } from "../lib/auth.js";
import { fail } from "../lib/errors.js";
import { rateLimit } from "../lib/rate-limit.js";

/**
 * WebAuthn passkeys (D-019, D-034). A trusted client device enrols one passkey; its public key
 * goes on the device record, and the client shows it at each agent's local reverse check, where
 * the agent records it. HIGH/CRITICAL step-ups are assertions over the decision itself, verified
 * by the agent (no server round-trip). `assert/options` serves server-checked security actions.
 *
 * Challenges are per device and purpose, stored server-side, single-use and short-lived.
 */
export interface WebAuthnConfig {
  /** Relying party id: the web app's registrable domain. */
  rpId: string;
  rpName: string;
  /** Origins the browser may report (the PWA, plus localhost in development). */
  origins: string[];
  /** Challenge lifetime. */
  challengeTtlMs: number;
}

export const webauthnConfigFromEnv = (env: Record<string, string | undefined> = process.env): WebAuthnConfig => {
  const rpId = env.CHALITO_WEBAUTHN_RP_ID ?? "chalito.chalyb.com";
  return {
    rpId,
    rpName: env.CHALITO_WEBAUTHN_RP_NAME ?? "Chalito",
    origins: (env.CHALITO_WEBAUTHN_ORIGINS ?? `https://${rpId}`)
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    challengeTtlMs: 5 * 60 * 1000,
  };
};

/** COSE algorithms accepted: EdDSA (Ed25519) and ES256, the two the agent verifies. */
const ALGS = [-8, -7];

export const webauthnRoutes = (deps: Deps, wa: WebAuthnConfig = webauthnConfigFromEnv()) => {
  const app = new Hono<AuthEnv>();
  const limiter = rateLimit({ capacity: 10, refillPerSec: 0.2, now: deps.now });

  const activeDevice = async (owner: string, deviceId: string) => {
    const device = await deps.repo.getDevice(owner, deviceId);
    if (!device || device.revoked !== false) return fail(403, "device_revoked");
    return device;
  };

  app.post("/register/options", requireAuth(deps, ["client"]), limiter, async (c) => {
    const p = principal(c);
    const device = await activeDevice(p.owner, p.deviceId!);
    const existing = await deps.repo.getDeviceWebAuthn(p.owner, device.deviceId);
    const options = await generateRegistrationOptions({
      rpName: wa.rpName,
      rpID: wa.rpId,
      userName: device.name,
      userDisplayName: device.name,
      // One passkey per device: the user handle is the device id, not the person.
      userID: new TextEncoder().encode(device.deviceId),
      attestationType: "none",
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      supportedAlgorithmIDs: ALGS,
      excludeCredentials: existing ? [{ id: existing.credentialId, transports: existing.transports }] : [],
    });
    await deps.repo.putWebAuthnChallenge({
      owner: p.owner,
      deviceId: device.deviceId,
      purpose: "register",
      challenge: options.challenge,
      expiresAt: deps.now() + wa.challengeTtlMs,
    });
    return c.json({ options });
  });

  app.post("/register/verify", requireAuth(deps, ["client"]), limiter, async (c) => {
    const p = principal(c);
    const body = (await c.req.json().catch(() => null)) as { response?: RegistrationResponseJSON } | null;
    if (!body?.response || typeof body.response !== "object") return fail(400, "bad_request");
    const device = await activeDevice(p.owner, p.deviceId!);
    const challenge = await deps.repo.takeWebAuthnChallenge(p.owner, device.deviceId, "register", deps.now());
    if (!challenge) return fail(400, "challenge_expired");
    let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      result = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: challenge,
        expectedOrigin: wa.origins,
        expectedRPID: wa.rpId,
        requireUserVerification: true,
        supportedAlgorithmIDs: ALGS,
      });
    } catch {
      return fail(400, "bad_registration");
    }
    if (!result.verified) return fail(400, "bad_registration");
    const cred = result.registrationInfo.credential;
    const stored = {
      credentialId: cred.id,
      publicKey: await toB64url(cred.publicKey),
      rpId: wa.rpId,
      counter: cred.counter,
      transports: cred.transports ?? [],
      createdAt: deps.now(),
    };
    if (!(await deps.repo.setDeviceWebAuthn(p.owner, device.deviceId, stored))) return fail(403, "device_revoked");
    await deps.audit.record({
      action: "webauthn.registered",
      owner: p.owner,
      actor: p.uid,
      target: device.deviceId,
      meta: { credentialId: stored.credentialId },
    });
    return c.json(
      { credential: { credentialId: stored.credentialId, publicKey: stored.publicKey, rpId: stored.rpId } },
      201,
    );
  });

  app.post("/assert/options", requireAuth(deps, ["client"]), limiter, async (c) => {
    const p = principal(c);
    const device = await activeDevice(p.owner, p.deviceId!);
    const cred = await deps.repo.getDeviceWebAuthn(p.owner, device.deviceId);
    if (!cred) return fail(409, "no_passkey");
    const options = await generateAuthenticationOptions({
      rpID: wa.rpId,
      allowCredentials: [{ id: cred.credentialId, transports: cred.transports }],
      userVerification: "required",
    });
    await deps.repo.putWebAuthnChallenge({
      owner: p.owner,
      deviceId: device.deviceId,
      purpose: "assert",
      challenge: options.challenge,
      expiresAt: deps.now() + wa.challengeTtlMs,
    });
    return c.json({ options });
  });

  return app;
};
