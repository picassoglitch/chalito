import { Hono } from "hono";
import { deriveDeviceId, fingerprint, fromB64url, verifyEnvelope } from "@chalito/crypto";
import { generateShortCode, hashShortCode, normalizeShortCode, verifyGlyph } from "@chalito/glyph";
import {
  ClaimPairingRequest,
  CreatePairingCodeRequest,
  ResolveShortCodeRequest,
  type PairingCodeDoc,
} from "@chalito/protocol";
import type { Deps } from "../deps.js";
import { principal, requireAuth, type AuthEnv } from "../lib/auth.js";
import { buildDeviceDoc } from "../lib/devices.js";
import { fail } from "../lib/errors.js";
import { rateLimit } from "../lib/rate-limit.js";
import { deviceLimitFor } from "../rooms/limits.js";

/** Phone-first pairing (ADR 0006). The cloud relays and records; humans confirm fingerprints. */
export const pairingRoutes = (deps: Deps) => {
  const app = new Hono<AuthEnv>();

  /** The agent publishes its self-signed glyph. Unauthenticated (it has no identity yet), rate-limited. */
  app.post("/codes", rateLimit({ capacity: 10, refillPerSec: 0.1, now: deps.now }), async (c) => {
    const body = CreatePairingCodeRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const { glyph, kind, platform } = body.data;
    if (glyph.body.purpose !== "pair_device") fail(400, "wrong_purpose");
    const check = await verifyGlyph(glyph, deps.now(), deps.config.skewMs);
    if (!check.ok) return fail(400, check.reason);
    const agentDeviceId = await deriveDeviceId(await fromB64url(glyph.body.issuerPubSign));
    const shortCode = await generateShortCode();
    const doc: PairingCodeDoc = {
      v: 1,
      codeId: glyph.body.codeId,
      shortCodeHash: await hashShortCode(shortCode),
      glyph,
      agentDeviceId,
      kind,
      platform,
      claimed: false,
      owner: null,
      claimedByDeviceId: null,
      claimerPubSign: null,
      claimerPubBox: null,
      claimerWebauthnBinding: null,
      expiresAt: glyph.body.expiresAt,
    };
    if ((await deps.repo.createPairingCode(doc)) === "exists") return fail(409, "code_exists");
    // A credential that can only read this one pairing code: the agent waits on a listener, not a poll.
    const watchToken = await deps.identity.mintPairingWatch(glyph.body.codeId);
    await deps.audit.record({
      action: "pairing.code_created",
      owner: null,
      actor: agentDeviceId,
      target: glyph.body.codeId,
    });
    return c.json({ shortCode, watchToken, expiresAt: glyph.body.expiresAt }, 201);
  });

  /** Accessibility fallback: the phone types the short code and gets the same signed payload. */
  app.post(
    "/resolve",
    requireAuth(deps, ["client"]),
    rateLimit({ capacity: 10, refillPerSec: 0.05, now: deps.now }),
    async (c) => {
      const body = ResolveShortCodeRequest.safeParse(await c.req.json().catch(() => null));
      const code = body.success ? normalizeShortCode(body.data.shortCode) : null;
      if (!code) return fail(400, "bad_request");
      const doc = await deps.repo.findPairingCodeByShortHash(await hashShortCode(code));
      if (!doc || doc.claimed || doc.expiresAt <= deps.now()) return fail(404, "not_found");
      return c.json({ glyph: doc.glyph });
    },
  );

  /** The phone, after the user checked the fingerprint and confirmed, signs the claim. */
  app.post("/claim", requireAuth(deps, ["client"]), async (c) => {
    const p = principal(c);
    const body = ClaimPairingRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const claim = body.data.claim;
    const b = claim.body;
    if (b.owner !== p.owner || b.claimerDeviceId !== p.deviceId || claim.signerDeviceId !== p.deviceId)
      fail(403, "claimer_mismatch");
    if (Math.abs(deps.now() - b.issuedAt) > deps.config.skewMs * 5) fail(400, "stale_request");
    const claimer = await deps.repo.getDevice(p.owner, p.deviceId!);
    if (!claimer) return fail(403, "device_revoked");
    const claimerPubSign = claimer.pubSign;
    const sig = await verifyEnvelope(
      claim,
      "chalito.pairing-claim.v1",
      new Map([[p.deviceId!, await fromB64url(claimerPubSign)]]),
    );
    if (!sig.ok) fail(400, "bad_signature");

    // The claimer's passkey binding (signed by its device key) goes to the agent with the claim;
    // the agent verifies it against the phone key it confirms at the reverse check.
    const claimerWebauthnBinding = (await deps.repo.getDeviceWebAuthn(p.owner, p.deviceId!))?.binding ?? null;
    const res = await deps.repo.claimPairingCode(
      b.codeId,
      {
        owner: p.owner,
        claimedByDeviceId: p.deviceId!,
        claimerPubSign,
        claimerPubBox: claimer.pubBox,
        claimerWebauthnBinding,
        claimedAt: deps.now(),
        agentLimitFor: deviceLimitFor,
      },
      async (code) => {
        if (code.expiresAt <= deps.now()) fail(410, "expired");
        if (code.agentDeviceId !== b.agentDeviceId) fail(400, "device_mismatch");
        const fp = await fingerprint(await fromB64url(code.glyph.body.issuerPubSign));
        if (fp !== b.agentFingerprint) fail(400, "fingerprint_mismatch");
        const agentDoc = await buildDeviceDoc(deps, {
          owner: p.owner,
          deviceId: code.agentDeviceId,
          kind: code.kind,
          platform: code.platform,
          name: code.glyph.body.label || "Escritorio",
          role: "agent",
          pubSign: code.glyph.body.issuerPubSign,
          pubBox: code.glyph.body.issuerPubBox ?? "",
          enrolledVia: "pairing",
          endorsedBy: p.deviceId,
        });
        if (!agentDoc.pubBox) fail(400, "agent_box_key_missing");
        return agentDoc;
      },
    );
    if (!res.ok && res.reason === "device_limit")
      return fail(403, "device_limit", `Your plan allows ${res.limit ?? 0} computer(s). Remove one or upgrade.`);
    if (!res.ok) return fail(res.reason === "not_found" ? 404 : 409, res.reason);
    const agentId = res.agentDeviceId;
    await deps.audit.record({ action: "pairing.claimed", owner: p.owner, actor: p.uid, target: agentId });
    return c.json({ ok: true, agentDeviceId: agentId });
  });

  return app;
};
