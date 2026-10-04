import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Deps } from "./deps.js";
import { deviceRoutes } from "./routes/devices.js";
import { hubRoutes } from "./routes/hub.js";
import { phoneRoutes } from "./phone/routes.js";
import { pairingRoutes } from "./routes/pairing.js";
import { recoveryRoutes } from "./routes/recovery.js";

export const createApp = (deps: Deps) => {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  // Chalyb engine contract: {admin_api_base}/tenants…, plus the SSO exchange.
  app.route("/", hubRoutes(deps));
  app.route("/v1/devices", deviceRoutes(deps));
  app.route("/v1/pairing", pairingRoutes(deps));
  app.route("/v1/recovery", recoveryRoutes(deps));
  if (deps.phone) app.route("/v1/phone", phoneRoutes(deps, deps.phone));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error("[api] unhandled", err instanceof Error ? err.message : "error");
    return c.json({ error: "internal" }, 500);
  });
  return app;
};
