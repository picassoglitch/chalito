import { installConsoleRedaction, redact, redactDeep } from "@chalito/redact";
import { serve } from "@hono/node-server";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { HubClient, compedFrom } from "@chalito/billing";
import { loadModels, loadPlans, loadPrices } from "@chalito/config";
import { createOrchestrator } from "./app.js";
import { SupabaseAuthn } from "./auth.js";
import { AnthropicBrain } from "./brains/anthropic.js";
import type { Brain, BrainProviderId } from "./brains/brain.js";
import { GeminiBrain } from "./brains/gemini.js";
import { ResponsesBrain } from "./brains/responses.js";
import { byoBrains } from "./byo.js";
import { CloudKmsWrapper } from "./kms.js";
import { googleOidcVerifier } from "./oidc.js";
import { hubEntitlements } from "./entitlements.js";
import { PostgresMesaStore } from "./postgres-store.js";

// Every log line and stray console call is redacted (R-M9).
installConsoleRedaction();
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
// Managed brains: one per provider whose key is configured (others are skipped, never faked).
const managed: Partial<Record<BrainProviderId, Brain>> = {
  anthropic: new AnthropicBrain({ apiKey: env("ANTHROPIC_API_KEY") }),
  ...(process.env.OPENAI_API_KEY
    ? { openai: new ResponsesBrain("openai", { apiKey: process.env.OPENAI_API_KEY }) }
    : {}),
  ...(process.env.XAI_API_KEY ? { xai: new ResponsesBrain("xai", { apiKey: process.env.XAI_API_KEY }) } : {}),
  // Vertex AI, global endpoint (D-012), with the service account's ADC.
  ...(process.env.GOOGLE_CLOUD_PROJECT
    ? { google: GeminiBrain.vertex(process.env.GOOGLE_CLOUD_PROJECT, "global") }
    : {}),
};
const store = new PostgresMesaStore(sql);
const wrapper = new CloudKmsWrapper(env("BRAIN_KEYS_KMS_KEY"));
const hub = new HubClient({ baseUrl: env("CHALYB_BASE_URL"), token: env("CHALITO_ADMIN_TOKEN") });

const app = createOrchestrator({
  authn: new SupabaseAuthn(supabase.auth),
  store,
  wrapper,
  ...(process.env.CHALITO_WEB_ORIGIN ? { webOrigin: process.env.CHALITO_WEB_ORIGIN } : {}),
  // Audit to stdout (Cloud Logging): decision.resolved / decision.invalid_signature.
  audit: (e) => process.stdout.write(`${JSON.stringify({ audit: { ...e, t: new Date().toISOString() } })}\n`),
  ...(process.env.SCHEDULER_SA_EMAIL && process.env.ORCHESTRATOR_BASE_URL
    ? {
        sweep: {
          verify: googleOidcVerifier(),
          expect: {
            audience: `${process.env.ORCHESTRATOR_BASE_URL}/tasks/sweep-decisions`,
            email: process.env.SCHEDULER_SA_EMAIL,
          },
        },
      }
    : {}),
  hub,
  brains: { managed, byo: byoBrains({ store, wrapper }) },
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
  log: (msg, meta) => console.error(JSON.stringify({ msg: redact(msg), ...(redactDeep(meta ?? {}) as object) })),
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port });
process.stdout.write(`[orchestrator] listening on :${port}\n`);
