import { errorMessage } from "@chalito/redact";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { guard } from "@chalito/guard";
import type { Deps } from "./deps.js";
import { API_ROUTES } from "./limits.js";
import { accountRoutes, accountTaskRoutes } from "./account/routes.js";
import { deviceRoutes } from "./routes/devices.js";
import { endorseRoutes } from "./routes/endorse.js";
import { hubRoutes } from "./routes/hub.js";
import { phoneRoutes } from "./phone/routes.js";
import { voiceRoutes } from "./voice/routes.js";
import { pairingRoutes } from "./routes/pairing.js";
import { recoveryRoutes } from "./routes/recovery.js";
import { releasesRoutes } from "./routes/releases.js";
import { webauthnRoutes } from "./routes/webauthn.js";
import { oauthRoutes } from "./routes/oauth.js";
import { storeRoutes } from "./store/routes.js";
import { billingRoutes } from "./billing/routes.js";
import { avatarRoutes } from "./avatar/routes.js";
import { roomsRoutes } from "./routes/rooms.js";
import { recipesRoutes } from "./routes/recipes.js";

/** Browser-facing prefixes. Server-to-server routes (hub /tenants, scheduler /tasks, webhooks) get no CORS. */
export const CORS_PATHS = ["/v1/*", "/sso/*", "/oauth/requests/*", "/releases/*"] as const;

/**
 * CORS for Chalito's own clients only: exact origins (no wildcard), bearer auth (no cookies, so no
 * credentials), a short preflight cache. Any other origin gets no Access-Control-Allow-Origin, so
 * browsers refuse to read the response.
 */
export const apiCors = (origins: readonly string[]) => {
  // http(s) origins are normalised; custom schemes (tauri://localhost) have an opaque URL origin,
  // so they're compared as written, minus a trailing slash.
  const normal = (o: string) => (/^https?:\/\//.test(o) ? new URL(o).origin : o.replace(/\/+$/, ""));
  const allowed = new Set(origins.map(normal));
  return cors({
    origin: (origin) => (allowed.has(origin) ? origin : null),
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
    credentials: false,
    maxAge: 600,
  });
};

export const createApp = (deps: Deps) => {
  const app = new Hono();
  // First: per-IP rate limits and body caps for every route (src/limits.ts).
  app.use(
    "*",
    guard(API_ROUTES, {
      now: deps.now,
      ...(deps.rateBuckets ? { shared: deps.rateBuckets } : {}),
      ...(deps.config.trustedProxies !== undefined ? { trustedProxies: deps.config.trustedProxies } : {}),
    }),
  );
  // Before the routes: a preflight carries no Authorization header and must not reach auth.
  const origins = deps.config.corsOrigins ?? [];
  if (origins.length > 0) for (const path of CORS_PATHS) app.use(path, apiCors(origins));
  app.get("/healthz", (c) => c.json({ ok: true }));
  // Chalyb engine contract: {admin_api_base}/tenants…, plus the SSO exchange.
  app.route("/", hubRoutes(deps));
  app.route("/v1/devices", deviceRoutes(deps));
  app.route("/v1/pairing", pairingRoutes(deps));
  app.route("/v1/endorse", endorseRoutes(deps));
  app.route("/v1/recovery", recoveryRoutes(deps));
  app.route("/v1/webauthn", webauthnRoutes(deps));
  app.route("/", oauthRoutes(deps));
  if (deps.phone) app.route("/v1/phone", phoneRoutes(deps, deps.phone));
  if (deps.voice) app.route("/v1/voice", voiceRoutes(deps, deps.voice));
  if (deps.store) app.route("/v1/store", storeRoutes(deps, deps.store));
  if (deps.billing) app.route("/v1/billing", billingRoutes(deps, deps.billing));
  if (deps.avatar) app.route("/v1/avatar", avatarRoutes(deps, deps.avatar));
  app.route("/v1/rooms", roomsRoutes(deps));
  app.route("/v1/recipes", recipesRoutes(deps));
  if (deps.releases) app.route("/releases", releasesRoutes(deps, deps.releases));
  if (deps.account) {
    app.route("/v1/account", accountRoutes(deps, deps.account));
    app.route("/tasks", accountTaskRoutes(deps, deps.account));
  }
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error("[api] unhandled", errorMessage(err));
    return c.json({ error: "internal" }, 500);
  });
  return app;
};
