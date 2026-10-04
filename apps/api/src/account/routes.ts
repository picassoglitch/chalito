import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Deps } from "../deps.js";
import { principal, requireAuth, type AuthEnv } from "../lib/auth.js";
import { fail } from "../lib/errors.js";
import type { OidcExpectation, OidcVerifier } from "../lib/oidc.js";
import { verifyStepUp } from "../lib/step-up.js";
import { webauthnConfigFromEnv, type WebAuthnConfig } from "../routes/webauthn.js";
import type { AccountFiles } from "./files.js";
import type { AccountStore } from "./store.js";

export interface AccountDeps {
  store: AccountStore;
  files: AccountFiles;
  /** Cloud Scheduler's OIDC token on POST /tasks/account-deletions. */
  scheduler: OidcExpectation;
  verifyOidc: OidcVerifier;
}

/** The owner can cancel for 7 days (ARCO / GDPR erasure, docs/LEGAL_CHECKLIST.md 1.3). */
export const DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Account deletion. Requesting it needs a trusted client and a passkey step-up; an export of
 * everything Chalito holds is written first and stays downloadable during the grace period; every
 * device gets a security notification; the owner can cancel until the deletion is due. Only
 * Chalito's data is deleted: the hub account is the hub's.
 */
export const accountRoutes = (deps: Deps, account: AccountDeps, wa: WebAuthnConfig = webauthnConfigFromEnv()) => {
  const app = new Hono<AuthEnv>();

  app.get("/deletion", requireAuth(deps, ["user", "client"]), async (c) => {
    const s = await account.store.status(principal(c).owner);
    return c.json(s ? { status: s.status, requestedAt: s.requestedAt, dueAt: s.dueAt } : { status: "none" });
  });

  app.post("/deletion", requireAuth(deps, ["client"]), async (c) => {
    const p = principal(c);
    const body = (await c.req.json().catch(() => ({}))) as { stepUp?: unknown };
    if (!(await deps.repo.getDeviceWebAuthn(p.owner, p.deviceId!))) return fail(403, "passkey_required");
    const step = await verifyStepUp(deps, wa, {
      owner: p.owner,
      uid: p.uid,
      deviceId: p.deviceId!,
      stepUp: body.stepUp,
      during: "account.deletion",
    });
    if (!step.ok) return fail(step.status, step.error);
    const existing = await account.store.status(p.owner);
    if (existing?.status === "scheduled") return fail(409, "already_scheduled");

    const now = deps.now();
    // The export first: everything Chalito holds, downloadable until the deletion runs.
    const data = await account.store.export(p.owner);
    const exportPath = await account.files.putExport(
      p.owner,
      `${now}-${randomUUID().slice(0, 8)}`,
      Buffer.from(JSON.stringify(data)),
    );
    const dueAt = now + DELETION_GRACE_MS;
    if ((await account.store.schedule(p.owner, p.deviceId!, now, dueAt, exportPath)) === "exists")
      return fail(409, "already_scheduled");
    const nid = `account_deletion_${now}`;
    await deps.repo.createNotification(p.owner, nid, {
      v: 1,
      nid,
      uid: p.owner,
      level: "L3",
      source: "security",
      urgency: "critical",
      counts: { approvals: 0, questions: 0, messages: 0, mesas: 0 },
      deepLink: "/ajustes",
      coalesceKey: "security:account_deletion",
      state: "pending",
      step: 0,
      nextAt: null,
      channels: ["desktop", "push", "whatsapp"],
      createdAt: now,
    });
    await deps.audit.record({
      action: "account.deletion_requested",
      owner: p.owner,
      actor: p.uid,
      target: p.deviceId!,
      meta: { dueAt },
    });
    return c.json({ status: "scheduled", dueAt, exportReady: true }, 202);
  });

  // Cancelling only makes the account safer, so any of the owner's sessions may do it.
  app.delete("/deletion", requireAuth(deps, ["user", "client"]), async (c) => {
    const p = principal(c);
    if (!(await account.store.cancel(p.owner, deps.now()))) return fail(404, "nothing_scheduled");
    await deps.audit.record({ action: "account.deletion_cancelled", owner: p.owner, actor: p.uid });
    return c.json({ status: "cancelled" });
  });

  app.get("/export", requireAuth(deps, ["user", "client"]), async (c) => {
    const p = principal(c);
    const s = await account.store.status(p.owner);
    if (!s) return fail(404, "no_export");
    const bytes = await account.files.getExport(s.exportPath);
    if (!bytes) return fail(404, "no_export");
    await deps.audit.record({ action: "account.export_downloaded", owner: p.owner, actor: p.uid });
    return c.body(new Uint8Array(bytes), 200, {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="chalito-export.json"`,
      "cache-control": "private, no-store",
    });
  });

  return app;
};

/**
 * Runs the deletions that are due: device Auth users, the owner's storage prefixes, then the
 * database (chalito_private.delete_account). Each step is idempotent, so a failed run is retried
 * whole by the next one.
 */
export const runDueDeletions = async (deps: Deps, account: AccountDeps) => {
  const done: string[] = [];
  const failed: string[] = [];
  for (const owner of await account.store.due(deps.now())) {
    try {
      for (const id of await account.store.deviceIds(owner)) await deps.identity.deleteDevice(id);
      const files = await account.files.deleteOwner(owner);
      // Recorded before the rows go (server_audit cascades with the user); the stream keeps it.
      await deps.audit.record({ action: "account.deleted", owner, actor: "system", meta: { files } });
      await account.store.deleteAccount(owner);
      done.push(owner);
    } catch (err) {
      console.error("[api] account deletion failed", owner, err instanceof Error ? err.message : "error");
      failed.push(owner);
    }
  }
  return { deleted: done.length, failed: failed.length };
};

/** POST /tasks/account-deletions: Cloud Scheduler (OIDC), e.g. hourly. */
export const accountTaskRoutes = (deps: Deps, account: AccountDeps) => {
  const app = new Hono();
  app.post("/account-deletions", async (c) => {
    if (!(await account.verifyOidc(c.req.header("authorization"), account.scheduler)))
      return c.json({ error: "unauthorized" }, 401);
    return c.json(await runDueDeletions(deps, account));
  });
  return app;
};
