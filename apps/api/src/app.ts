import { errorMessage } from "@chalito/redact";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { guard } from "@chalito/guard";
import type { Deps } from "./deps.js";
import { API_ROUTES } from "./limits.js";
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
import { roomsRoutes } from "./routes/rooms.js";

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
  app.route("/v1/rooms", roomsRoutes(deps));
  if (deps.releases) app.route("/releases", releasesRoutes(deps, deps.releases));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error("[api] unhandled", errorMessage(err));
    return c.json({ error: "internal" }, 500);
  });
  return app;
};
