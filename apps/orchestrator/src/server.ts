import { serve } from "@hono/node-server";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { HubClient, compedFrom } from "@chalito/billing";
import { loadModels, loadPlans, loadPrices } from "@chalito/config";
import { createOrchestrator } from "./app.js";
import { SupabaseAuthn } from "./auth.js";
import { AnthropicBrain } from "./brains/anthropic.js";
import { hubEntitlements } from "./entitlements.js";
import { PostgresMesaStore } from "./postgres-store.js";

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

// DATABASE_ROLE=chalito_server when the login only holds it with SET (local); unset on deploy.
const sql = postgres(env("DATABASE_URL"), {
  max: 10,
  onnotice: () => {},
  ...(process.env.DATABASE_ROLE ? { connection: { role: process.env.DATABASE_ROLE } } : {}),
});
const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});
const hub = new HubClient({ baseUrl: env("CHALYB_BASE_URL"), token: env("CHALITO_ADMIN_TOKEN") });

const app = createOrchestrator({
  authn: new SupabaseAuthn(supabase.auth),
  store: new PostgresMesaStore(sql),
  hub,
  brain: new AnthropicBrain({ apiKey: env("ANTHROPIC_API_KEY") }),
  models: loadModels(),
  prices: loadPrices(),
  entitlements: hubEntitlements({
    sql,
    hub,
    plans: loadPlans(),
    comped: compedFrom(process.env.OWNER_UIDS),
    now: Date.now,
  }),
  now: Date.now,
  log: (msg, meta) => console.error(JSON.stringify({ msg, ...meta })),
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port });
process.stdout.write(`[orchestrator] listening on :${port}\n`);
