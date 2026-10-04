import { Hono } from "hono";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { fromB64url, toB64url, verifyWebAuthnBinding } from "@chalito/crypto";
import { WebAuthnBindRequest } from "@chalito/protocol";
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

  /**
   * R-M11: replacing a device's passkey requires an assertion by the CURRENT one, over a fresh
   * server challenge (/assert/options), so a stolen session + device key can't swap in the
   * thief's passkey. Losing the old passkey means re-enrolling the device (endorsement or
   * recovery), not replacing it here.
   */
  const verifyCurrentPasskey = async (
    owner: string,
    deviceId: string,
    cred: NonNullable<Awaited<ReturnType<typeof deps.repo.getDeviceWebAuthn>>>,
    response: AuthenticationResponseJSON | undefined,
  ): Promise<"ok" | "required" | "failed" | "cloned"> => {
    if (!response || typeof response !== "object") return "required";
    const challenge = await deps.repo.takeWebAuthnChallenge(owner, deviceId, "assert", deps.now());
    if (!challenge) return "failed";
    const counter = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: wa.origins,
      expectedRPID: wa.rpId,
      credential: {
        id: cred.credentialId,
        publicKey: new Uint8Array(await fromB64url(cred.publicKey)),
        // The repo's atomic compare below is the counter check (and the clone alert).
        counter: 0,
        transports: cred.transports as never,
      },
      requireUserVerification: true,
    }).then(
      (r) =>
        r.verified && r.authenticationInfo.credentialID === cred.credentialId ? r.authenticationInfo.newCounter : null,
      () => null,
    );
    if (counter === null) return "failed";
    const bumped = await deps.repo.bumpWebAuthnCounter(owner, deviceId, cred.credentialId, counter);
    return bumped === "ok" ? "ok" : bumped === "cloned" ? "cloned" : "failed";
  };

  app.post("/register/options", requireAuth(deps, ["client"]), limiter, async (c) => {
    const p = principal(c);
    const device = await activeDevice(p.owner, p.deviceId!);
    const existing = await deps.repo.getDeviceWebAuthn(p.owner, device.deviceId);
    if (existing) {
      const body = (await c.req.json().catch(() => null)) as { currentAssertion?: AuthenticationResponseJSON } | null;
      const check = await verifyCurrentPasskey(p.owner, device.deviceId, existing, body?.currentAssertion);
      if (check !== "ok") {
        await deps.audit.record({
          action: check === "cloned" ? "webauthn.clone_suspected" : "webauthn.replace_refused",
          owner: p.owner,
          actor: p.uid,
          target: device.deviceId,
          meta: { reason: check, during: "register.options" },
        });
        if (check === "required") return fail(409, "current_passkey_required");
        return fail(
          check === "cloned" ? 403 : 401,
          check === "cloned" ? "authenticator_cloned" : "current_passkey_failed",
        );
      }
    }
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
    const replaced = await deps.repo.getDeviceWebAuthn(p.owner, device.deviceId);
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
      meta: { credentialId: stored.credentialId, ...(replaced ? { replaced: replaced.credentialId } : {}) },
    });
    if (replaced && replaced.credentialId !== stored.credentialId) {
      // R-M11: a passkey changed: every device of the account hears about it (metadata only).
      const nid = `passkey_${device.deviceId}_${deps.now()}`;
      await deps.repo.createNotification(p.owner, nid, {
        v: 1,
        nid,
        uid: p.owner,
        level: "L3",
        source: "security",
        urgency: "critical",
        counts: { approvals: 0, questions: 0, messages: 0, mesas: 0 },
        deepLink: "/dispositivos",
        coalesceKey: `security:passkey:${device.deviceId}`,
        state: "pending",
        step: 0,
        nextAt: null,
        channels: ["desktop", "push", "whatsapp"],
        createdAt: deps.now(),
        ackedAt: null,
        ackedVia: null,
      });
      await deps.audit.record({
        action: "webauthn.replaced",
        owner: p.owner,
        actor: p.uid,
        target: device.deviceId,
        meta: { from: replaced.credentialId, to: stored.credentialId },
      });
    }
    return c.json(
      { credential: { credentialId: stored.credentialId, publicKey: stored.publicKey, rpId: stored.rpId } },
      201,
    );
  });

  /**
   * The device's binding for the passkey it just registered: signed by its DEVICE key over
   * {deviceId, credentialId, publicKey, rpId}. Must match the stored credential exactly.
   */
  app.post("/register/bind", requireAuth(deps, ["client"]), limiter, async (c) => {
    const p = principal(c);
    const body = WebAuthnBindRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const binding = body.data.binding;
    const device = await activeDevice(p.owner, p.deviceId!);
    const cred = await deps.repo.getDeviceWebAuthn(p.owner, device.deviceId);
    if (!cred) return fail(409, "no_passkey");
    const check = await verifyWebAuthnBinding(binding, {
      deviceId: device.deviceId,
      pubSign: device.pubSign,
      rpId: wa.rpId,
    });
    if (!check.ok) return fail(400, `bad_binding_${check.reason}`);
    if (binding.body.credentialId !== cred.credentialId || binding.body.publicKey !== cred.publicKey)
      return fail(400, "bad_binding_credential_mismatch");
    if (!(await deps.repo.setDeviceWebAuthnBinding(p.owner, device.deviceId, binding)))
      return fail(403, "device_revoked");
    await deps.audit.record({
      action: "webauthn.bound",
      owner: p.owner,
      actor: p.uid,
      target: device.deviceId,
      meta: { credentialId: cred.credentialId },
    });
    return c.json({ ok: true });
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
