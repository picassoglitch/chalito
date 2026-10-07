import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { HubTenantCreate, HubTenantStatus, SsoExchangeRequest } from "@chalito/protocol";
import type { Deps } from "../deps.js";
import { fail } from "../lib/errors.js";
import { tenantApiToken, verifySsoToken } from "../hub/sso.js";
import { dropLapsedSkins } from "../store/included.js";

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
    const tokenOut = { tenant_id: id, api_token: tenantApiToken(deps.config.adminToken, id) };
    const res = await deps.repo.createTenant({
      tenantId: id,
      email: body.data.email,
      displayName: body.data.display_name ?? null,
      tier: body.data.tier,
      createdAt: deps.now(),
    });
    if (res === "exists") return c.json({ error: "duplicate", ...tokenOut }, 409);
    await deps.audit.record({ action: "tenant.created", owner: id, actor: "hub", meta: { tier: body.data.tier } });
    return c.json(tokenOut, 201);
  });

  app.post("/tenants/:id/status", async (c) => {
    const body = HubTenantStatus.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return fail(400, "bad_request");
    if (!(await deps.repo.setTenantStatus(c.req.param("id"), body.data.status, deps.now()))) fail(404, "not_found");
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
    if (!(await deps.repo.claimSsoToken(sigHash, payload.exp * 1000 + 60_000))) return fail(409, "token_replayed");
    await deps.repo.upsertUserFromSso(payload.user_id, {
      tenantId: payload.tenant_id,
      email: payload.email,
      tier: payload.tier,
      lastSsoAt: deps.now(),
    });
    // The tier may have just changed: a skin only the old plan included comes off. Never blocks sign-in.
    if (deps.store)
      await dropLapsedSkins(deps.store, payload.user_id, payload.tier.toLowerCase()).catch((err: unknown) =>
        console.error("[sso] lapsed skins", err instanceof Error ? err.message : "error"),
      );
    const customToken = await deps.identity.mintUser(payload.user_id, payload.tier);
    await deps.audit.record({ action: "sso.exchange", owner: payload.user_id, actor: "hub" });
    return c.json({ customToken, owner: payload.user_id });
  });

  return app;
};
