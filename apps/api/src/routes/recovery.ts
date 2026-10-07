import { Hono } from "hono";
import { CompleteRecoveryRequest, StartRecoveryRequest } from "@chalito/protocol";
import type { Deps } from "../deps.js";
import { principal, requireAuth, type AuthEnv } from "../lib/auth.js";
import { buildDeviceDoc, checkRegistration, mintDeviceToken } from "../lib/devices.js";
import { fail } from "../lib/errors.js";
import { rateLimit } from "../lib/rate-limit.js";
import { hashRecoveryCode, verifyRecoveryCode } from "../lib/recovery.js";

/**
 * Only-client-lost recovery: hub sign-in + recovery code + cool-down + alerts to every
 * device. The new phone is enrolled with enrolledVia="recovery"; each agent still has to
 * confirm it locally before it can approve anything (ADR 0006).
 */
export const recoveryRoutes = (deps: Deps) => {
  const app = new Hono<AuthEnv>();
  const limiter = rateLimit({ capacity: 5, refillPerSec: 1 / 60, now: deps.now });

  const loadRecovery = async (owner: string) => {
    const rec = await deps.repo.getRecovery(owner);
    if (!rec) return fail(404, "no_recovery_code");
    return rec;
  };

  app.post("/start", requireAuth(deps, ["user"]), limiter, async (c) => {
    const p = principal(c);
    const body = StartRecoveryRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const rec = await loadRecovery(p.owner);
    if (!(await verifyRecoveryCode(body.data.recoveryCode, rec))) {
      await deps.audit.record({ action: "recovery.failed", owner: p.owner, actor: p.uid });
      return fail(401, "bad_code");
    }
    // Already waiting out the cool-down: same end time, and no new alert to every device (a retry
    // from the recovery screen is not a new event). Still audited, as a retry.
    if (rec.cooldownUntil !== null && deps.now() < rec.cooldownUntil) {
      await deps.audit.record({
        action: "recovery.retried",
        owner: p.owner,
        actor: p.uid,
        meta: { cooldownUntil: rec.cooldownUntil },
      });
      return c.json({ cooldownUntil: rec.cooldownUntil });
    }
    const cooldownUntil = rec.cooldownUntil ?? deps.now() + deps.config.recoveryCooldownMs;
    await deps.repo.startRecovery(p.owner, cooldownUntil, deps.now());
    // Alert every device of the account (metadata only; escalation picks it up in M6).
    const nid = `recovery_${deps.now()}`;
    await deps.repo.createNotification(p.owner, nid, {
      v: 1,
      nid,
      uid: p.owner,
      level: "L3",
      source: "security",
      urgency: "critical",
      counts: { approvals: 0, questions: 0, messages: 0, mesas: 0 },
      deepLink: "/",
      coalesceKey: "security:recovery",
      state: "pending",
      step: 0,
      nextAt: null,
      channels: ["desktop", "push", "whatsapp"],
      createdAt: deps.now(),
      ackedAt: null,
      ackedVia: null,
    });
    await deps.audit.record({ action: "recovery.started", owner: p.owner, actor: p.uid, meta: { cooldownUntil } });
    return c.json({ cooldownUntil });
  });

  app.post("/complete", requireAuth(deps, ["user"]), limiter, async (c) => {
    const p = principal(c);
    const body = CompleteRecoveryRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const rec = await loadRecovery(p.owner);
    if (!(await verifyRecoveryCode(body.data.recoveryCode, rec))) return fail(401, "bad_code");
    if (rec.cooldownUntil === null) return fail(409, "recovery_not_started");
    if (deps.now() < rec.cooldownUntil) return fail(425, "cooldown", `Available at ${rec.cooldownUntil}`);
    const reg = body.data.registration;
    await checkRegistration(deps, reg, p.owner, ["phone", "web"]);
    const doc = await buildDeviceDoc(deps, {
      owner: p.owner,
      deviceId: reg.body.deviceId,
      kind: reg.body.kind,
      platform: reg.body.platform,
      name: reg.body.name,
      role: "client",
      pubSign: reg.body.pubSign,
      pubBox: reg.body.pubBox,
      enrolledVia: "recovery",
      endorsedBy: null,
    });
    const next = await hashRecoveryCode(body.data.newRecoveryCode);
    const done = await deps.repo.completeRecovery(p.owner, doc, {
      ...next,
      cooldownUntil: null,
      createdAt: deps.now(),
    });
    if (done === "device_exists") fail(409, "device_exists");
    await deps.audit.record({ action: "recovery.completed", owner: p.owner, actor: p.uid, target: doc.deviceId });
    return c.json(
      { customToken: await mintDeviceToken(deps, p.owner, doc.deviceId, "client"), deviceId: doc.deviceId },
      201,
    );
  });

  return app;
};
