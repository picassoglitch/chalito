import { createHash } from "node:crypto";
import { Hono } from "hono";
import { deriveDeviceId, fingerprint, fromB64url, verifyEnvelope } from "@chalito/crypto";
import { generateShortCode, hashShortCode, normalizeShortCode, verifyGlyph } from "@chalito/glyph";
import { MemoryBuckets, clientIp } from "@chalito/guard";
import {
  ClaimPairingRequest,
  CreatePairingCodeRequest,
  DeclinePairingRequest,
  PairingHandoffRequest,
  ResolveShortCodeRequest,
  type PairingCodeDoc,
  type PairingHandoffResponse,
} from "@chalito/protocol";
import type { Context } from "hono";
import type { Deps } from "../deps.js";
import { principal, requireAuth, type AuthEnv } from "../lib/auth.js";
import { buildDeviceDoc } from "../lib/devices.js";
import { fail } from "../lib/errors.js";
import { compareNetworks, pairingApproval, pairingNet, type PairingNet } from "../lib/pairing-network.js";
import { rateLimit } from "../lib/rate-limit.js";
import { deviceLimitFor } from "../rooms/limits.js";

/** Phone-first pairing (ADR 0006). The cloud relays and records; humans confirm fingerprints. */
export const pairingRoutes = (deps: Deps) => {
  const app = new Hono<AuthEnv>();
  // The network key: derived from the SSO secret, so a dump of the table alone can't be brute-forced.
  const netKey = `chalito.pairing-net.v1:${deps.config.ssoSecret}`;
  const proxies = deps.config.trustedProxies ?? 0;
  // The city header is only believed behind a load balancer that sets it (TRUSTED_PROXIES > 0).
  const netOf = (c: Context): PairingNet | null =>
    pairingNet(clientIp(c, proxies), netKey, proxies > 0 ? (h) => c.req.header(h) : undefined);
  /**
   * A code id is a capability: whoever has it (the hand-off link) can see the code. It never goes
   * to the audit log or anywhere else in clear, only this short hash.
   */
  const codeRef = (codeId: string) =>
    createHash("sha256").update(`chalito.pairing-code:${codeId}`).digest("hex").slice(0, 16);
  const declineBuckets = deps.rateBuckets ?? new MemoryBuckets();
  /** An open code by id (unclaimed, not declined, not expired), or null. */
  const openCode = async (codeId: string) => {
    const found = await deps.repo.getPairingCode(codeId);
    if (!found || found.doc.claimed || found.doc.cancelled || found.doc.expiresAt <= deps.now()) return null;
    return found;
  };
  /** What the approving browser sees: never the short code, its hash, or anyone's keys but the computer's glyph. */
  const handoffView = (found: { doc: PairingCodeDoc; net: PairingNet | null }, c: Context): PairingHandoffResponse => {
    const network = compareNetworks(found.net, netOf(c));
    return {
      glyph: found.doc.glyph,
      kind: found.doc.kind,
      platform: found.doc.platform,
      expiresAt: found.doc.expiresAt,
      network,
      approval: pairingApproval(network),
      city: network === "same" ? null : (found.net?.city ?? null),
    };
  };

  /** The agent publishes its self-signed glyph. Unauthenticated (it has no identity yet), rate-limited. */
  app.post("/codes", rateLimit({ capacity: 10, refillPerSec: 0.1, now: deps.now }), async (c) => {
    const body = CreatePairingCodeRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const { glyph, kind, platform } = body.data;
    if (glyph.body.purpose !== "pair_device") fail(400, "wrong_purpose");
    // The code id doubles as the hand-off capability: at least 128 random bits (22 base64url chars).
    if (glyph.body.codeId.length < 22) fail(400, "weak_code_id");
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
      cancelled: false,
      expiresAt: glyph.body.expiresAt,
    };
    if ((await deps.repo.createPairingCode(doc, netOf(c))) === "exists") return fail(409, "code_exists");
    // A credential that can only read this one pairing code: the agent waits on a listener, not a poll.
    const watchToken = await deps.identity.mintPairingWatch(glyph.body.codeId);
    await deps.audit.record({
      action: "pairing.code_created",
      owner: null,
      actor: agentDeviceId,
      target: codeRef(glyph.body.codeId),
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
      const found = doc ? await openCode(doc.codeId) : null;
      if (!found) return fail(404, "not_found");
      const p = principal(c);
      await deps.repo.recordPairingViewer(found.doc.codeId, p.owner, p.deviceId!);
      return c.json(handoffView(found, c));
    },
  );

  /**
   * Hand-off link (ADR 0028 §3): the browser opened `/computadoras/aprobar#c=<codeId>` and asks
   * what it would approve. Same rule as /resolve: any signed-in client (the code has no owner
   * yet), rate-limited, open codes only.
   */
  app.post(
    "/handoff",
    requireAuth(deps, ["client"]),
    rateLimit({ capacity: 10, refillPerSec: 0.05, now: deps.now }),
    async (c) => {
      const body = PairingHandoffRequest.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return fail(400, "bad_request");
      const found = await openCode(body.data.codeId);
      if (!found) return fail(404, "not_found");
      const p = principal(c);
      await deps.repo.recordPairingViewer(found.doc.codeId, p.owner, p.deviceId!);
      return c.json(handoffView(found, c));
    },
  );

  /** "No estoy frente a esa computadora": the code stops working and the computer says so. */
  app.post(
    "/decline",
    requireAuth(deps, ["client"]),
    rateLimit({ capacity: 5, refillPerSec: 0.02, now: deps.now }),
    async (c) => {
      const p = principal(c);
      const body = DeclinePairingRequest.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return fail(400, "bad_request");
      const { codeId } = body.data;
      // Per code too, not only per client: a code can't be hammered from many clients.
      if (!(await declineBuckets.take(`pairing-decline:${codeRef(codeId)}`, 3, 1 / 60, deps.now())))
        return fail(429, "rate_limited");
      const found = await openCode(codeId);
      if (!found) return fail(404, "not_found");
      // Only a client that opened this code (link or typed code) may decline it.
      if (!(await deps.repo.isPairingViewer(codeId, p.owner, p.deviceId!))) return fail(403, "not_opened");
      const res = await deps.repo.cancelPairingCode(codeId);
      if (res !== "cancelled") return fail(res === "not_found" ? 404 : 409, res);
      await deps.audit.record({
        action: "pairing.declined",
        owner: p.owner,
        actor: p.uid,
        target: codeRef(codeId),
        meta: { agentDeviceId: found.doc.agentDeviceId },
      });
      return c.json({ ok: true });
    },
  );

  /** The phone, after the user checked the fingerprint and confirmed, signs the claim. */
  app.post("/claim", requireAuth(deps, ["client"]), async (c) => {
    const p = principal(c);
    const body = ClaimPairingRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const claim = body.data.claim;
    // The network check is enforced here, not only on the screen (ADR 0028 §4): from another
    // network the claim must carry the short code shown on the computer.
    const found = await deps.repo.getPairingCode(claim.body.codeId);
    if (!found) return fail(404, "not_found");
    if (found.doc.cancelled) return fail(410, "cancelled");
    const approval = pairingApproval(compareNetworks(found.net, netOf(c)));
    if (approval === "blocked") return fail(403, "network_mismatch");
    if (approval === "code_required") {
      const typed = body.data.shortCode ? normalizeShortCode(body.data.shortCode) : null;
      if (!typed || (await hashShortCode(typed)) !== found.doc.shortCodeHash) return fail(403, "code_required");
    }
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
    await deps.audit.record({
      action: "pairing.claimed",
      owner: p.owner,
      actor: p.uid,
      target: agentId,
      meta: { approval },
    });
    // Every device of the account hears about a new computer (ADR 0028 §4), with revoke one tap away.
    const nid = `pairing_${agentId}_${deps.now()}`;
    await deps.repo.createNotification(p.owner, nid, {
      v: 1,
      nid,
      uid: p.owner,
      level: "L2",
      source: "security",
      urgency: "high",
      counts: { approvals: 0, questions: 0, messages: 0, mesas: 0 },
      deepLink: "/dispositivos",
      coalesceKey: `security:pairing:${agentId}`,
      state: "pending",
      step: 0,
      nextAt: null,
      channels: ["desktop", "push"],
      createdAt: deps.now(),
      ackedAt: null,
      ackedVia: null,
    });
    return c.json({ ok: true, agentDeviceId: agentId });
  });

  return app;
};
