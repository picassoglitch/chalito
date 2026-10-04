import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { HubTenantCreate, HubTenantStatus, SsoExchangeRequest } from "@chalito/protocol";
import type { Deps } from "../deps.js";
import { fail } from "../lib/errors.js";
import { tenantApiToken, verifySsoToken } from "../hub/sso.js";

const bearerOk = (header: string | undefined, token: string) => {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const expected = Buffer.from(token);
  return token.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
};

/** Chalyb engine contract (ADR 0016): tenant provisioning + SSO exchange. */
export const hubRoutes = (deps: Deps) => {
  const app = new Hono();

  app.use("/tenants/*", async (c, next) => {
    if (!bearerOk(c.req.header("authorization"), deps.config.adminToken)) fail(401, "unauthorized");
    await next();
  });
  app.use("/tenants", async (c, next) => {
    if (!bearerOk(c.req.header("authorization"), deps.config.adminToken)) fail(401, "unauthorized");
    await next();
  });

  app.post("/tenants", async (c) => {
    const body = HubTenantCreate.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const id = body.data.external_user_id;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail(400, "bad_tenant_id");
    const ref = deps.db.doc(`users/${id}`);
    const tokenOut = { tenant_id: id, api_token: tenantApiToken(deps.config.adminToken, id) };
    try {
      await ref.create({
        v: 1,
        tenantId: id,
        email: body.data.email,
        displayName: body.data.display_name ?? null,
        tier: body.data.tier,
        status: "active",
        locale: "es",
        createdAt: deps.now(),
      });
    } catch (err) {
      if ((err as { code?: number }).code === 6) return c.json({ error: "duplicate", ...tokenOut }, 409);
      throw err;
    }
    await deps.audit.record({ action: "tenant.created", owner: id, actor: "hub", meta: { tier: body.data.tier } });
    return c.json(tokenOut, 201);
  });

  app.post("/tenants/:id/status", async (c) => {
    const body = HubTenantStatus.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const ref = deps.db.doc(`users/${c.req.param("id")}`);
    if (!(await ref.get()).exists) fail(404, "not_found");
    await ref.update({ status: body.data.status, statusAt: deps.now() });
    await deps.audit.record({ action: `tenant.${body.data.status}`, owner: c.req.param("id"), actor: "hub" });
    return c.body(null, 204);
  });

  /** Web (`/auth/sso` on chalito.chalyb.com) forwards the hub's launch token here. */
  app.post("/sso/exchange", async (c) => {
    const body = SsoExchangeRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    const res = verifySsoToken(body.data.token, deps.config.ssoSecret, deps.now());
    if (!res.ok) return fail(401, res.reason);
    const { payload, sigHash } = res;
    // Single use: a second exchange of the same token fails.
    try {
      await deps.db.doc(`ssoTokens/${sigHash}`).create({ expireAt: new Date(payload.exp * 1000 + 60_000) });
    } catch (err) {
      if ((err as { code?: number }).code === 6) return fail(409, "token_replayed");
      throw err;
    }
    await deps.db
      .doc(`users/${payload.user_id}`)
      .set(
        { v: 1, tenantId: payload.tenant_id, email: payload.email, tier: payload.tier, lastSsoAt: deps.now() },
        { merge: true },
      );
    const customToken = await deps.auth.createCustomToken(payload.user_id, {
      role: "user",
      owner: payload.user_id,
      tier: payload.tier,
    });
    await deps.audit.record({ action: "sso.exchange", owner: payload.user_id, actor: "hub" });
    return c.json({ customToken, owner: payload.user_id });
  });

  return app;
};
