import { installConsoleRedaction } from "@chalito/redact";
import { CodingMeter, HubClient, PostgresCodingStore, parseReserveBasis } from "@chalito/billing";
import { checkRole, loadPrices, loadProviders, pgOptions } from "@chalito/config";
import { serve } from "@hono/node-server";
import postgres from "postgres";
import { createGateway, type Upstreams } from "./app.js";

// Every stray console call is redacted (R-M9); the gateway itself only ever logs credential ids.
installConsoleRedaction();
const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

// DATABASE_URL: a login that acts as chalito_ai_gateway (migration 20261021002000).
const role = process.env.DATABASE_ROLE ?? "chalito_ai_gateway";
const url = env("DATABASE_URL");
const sql = postgres(url, pgOptions(url, { role, max: 10 }));
await checkRole(sql, role);

const providers = loadProviders();
const hub = new HubClient({ baseUrl: env("CHALYB_BASE_URL"), token: env("CHALITO_ADMIN_TOKEN") });
const store = new PostgresCodingStore(sql);
const meter = new CodingMeter({
  store,
  hub,
  prices: loadPrices(),
  cfg: providers.codingManaged,
  reserveBasis: parseReserveBasis(process.env.HUB_RESERVE_BASIS),
  now: Date.now,
  log: (msg, meta) => console.error(`[ai-gateway] ${msg}`, JSON.stringify(meta)),
});
// Our keys, from projects used for nothing else (docs/OPS.md, managed coding agents). A missing key pauses that agent.
const upstream = (key: string | undefined, base: string) => (key ? { baseUrl: base, apiKey: key } : null);
const upstreams: Upstreams = {
  openai: upstream(
    process.env.CODING_OPENAI_API_KEY,
    process.env.CODING_OPENAI_BASE_URL ?? "https://api.openai.com/v1",
  ),
  xai: upstream(process.env.CODING_XAI_API_KEY, process.env.CODING_XAI_BASE_URL ?? "https://api.x.ai/v1"),
  google: upstream(
    process.env.CODING_GEMINI_API_KEY,
    process.env.CODING_GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com",
  ),
};

const app = createGateway({
  store,
  meter,
  providers,
  upstreams,
  enabled: () => process.env.CODING_MANAGED_ENABLED === "1",
  now: Date.now,
  ...(process.env.TRUSTED_PROXIES ? { trustedProxies: Number(process.env.TRUSTED_PROXIES) } : {}),
});

// Every minute: replay usage the database refused, then close the hub holds of ended and expired sessions.
setInterval(() => {
  void (async () => {
    if (!(await app.retryPending())) console.error("[ai-gateway] usage still unrecorded", app.pendingCount());
    await meter.sweep();
  })().catch((err: unknown) => console.error("[ai-gateway] tick failed", err instanceof Error ? err.message : "error"));
}, 60_000).unref();

const port = Number(process.env.PORT ?? 8790);
const server = serve({ fetch: app.fetch, port });
process.stdout.write(`[ai-gateway] listening on :${port}\n`);

// Cloud Run gives 10 s after SIGTERM: stop reading live streams, bill them (usage or estimate), then exit.
process.once("SIGTERM", () => {
  server.close();
  void (async () => {
    await app.shutdown(6_000);
    if (!(await app.retryPending())) console.error("[ai-gateway] usage lost at shutdown", app.pendingCount());
    process.exit(0);
  })();
});
