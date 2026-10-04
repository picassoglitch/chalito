import { serve } from "@hono/node-server";
import { PubSub } from "@google-cloud/pubsub";
import { createClient } from "@supabase/supabase-js";
import { PostgresBuckets } from "@chalito/guard";
import { createApp } from "./app.js";
import { GcsReleaseStore } from "./releases/gcs.js";
import { PostgresAuditSink, teeAudit } from "./postgres/audit.js";
import type { AuditSink } from "./deps.js";
import { openaiRealtime } from "@chalito/adapters/voice";
import { HubClient, HubStreamUsage, compedFrom, enqueueUsage } from "@chalito/billing";
import { loadCatalog, loadModels, loadPlans, loadPrices } from "@chalito/config";
import { PostgresPhoneStore } from "./phone/postgres.js";
import type { PhoneDeps } from "./phone/routes.js";
import { twilioPhoneVerifier } from "./phone/twilio.js";
import { PostgresRepo, chalitoSql } from "./postgres/repo.js";
import type { McpStore } from "./oauth/model.js";
import { PostgresMcpStore } from "./oauth/postgres-store.js";
import { PostgresRoomsRepo, type RoomsRepo } from "./rooms/repo.js";
import type { ApiRepo, IdentityIssuer } from "./repo.js";
import { SupabaseIssuer, chalitoAuthUserId } from "./supabase/identity.js";
import { PostgresStoreRepo } from "./store/repo.js";
import type { StoreDeps } from "./store/routes.js";
import { pgVoiceCap } from "./voice/caps.js";
import type { VoiceDeps } from "./voice/routes.js";

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

/**
 * Data backend (ADR 0017): the hub's Postgres through a server connection (DATABASE_URL,
 * acting as chalito_server) and Supabase Auth device users (SUPABASE_URL + the secret key,
 * server only). CHALITO_DATA_BACKEND defaults to `supabase`, the only backend since the
 * Firestore cut-over.
 */
const backend = (): {
  repo: ApiRepo;
  identity: IdentityIssuer;
  mcp: McpStore;
  rooms: RoomsRepo;
  phone?: PhoneDeps;
  voice?: VoiceDeps;
  store?: StoreDeps;
  rateBuckets: PostgresBuckets;
  serverAudit: PostgresAuditSink;
} => {
  const kind = process.env.CHALITO_DATA_BACKEND ?? "supabase";
  if (kind !== "supabase")
    throw new Error(`CHALITO_DATA_BACKEND=${kind} is not supported (Firestore was removed, ADR 0017)`);
  const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SECRET_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  // DATABASE_ROLE: `chalito_server` when the login only holds it with SET (local, tests);
  // unset when the login is a member that inherits it (deploy).
  const sql = chalitoSql(env("DATABASE_URL"), process.env.DATABASE_ROLE ? { role: process.env.DATABASE_ROLE } : {});
  return {
    repo: new PostgresRepo(sql, { authUserId: chalitoAuthUserId }),
    identity: new SupabaseIssuer(supabase.auth),
    mcp: new PostgresMcpStore(sql),
    // Desktop push-to-talk when OpenAI is configured, admitted and metered through the hub.
    ...(process.env.OPENAI_API_KEY
      ? {
          voice: {
            provider: openaiRealtime({ apiKey: env("OPENAI_API_KEY") }),
            hub: new HubStreamUsage({
              hub: new HubClient({ baseUrl: env("CHALYB_BASE_URL"), token: env("CHALITO_ADMIN_TOKEN") }),
              enqueue: (owner, events) => enqueueUsage(sql, owner, events),
              prices: loadPrices(),
              model: loadModels().voice.desktop.model,
              now: Date.now,
            }),
            model: loadModels().voice.desktop.model,
            voiceName: process.env.REALTIME_VOICE ?? "marin",
            tokenSecret: env("VOICE_TOKEN_SECRET"),
            cap: pgVoiceCap(sql, loadPlans(), compedFrom(process.env.OWNER_UIDS)),
          },
        }
      : {}),
    // The store buys from the hub balance, so it needs the hub.
    ...(process.env.CHALYB_BASE_URL
      ? {
          store: {
            repo: new PostgresStoreRepo(sql),
            catalog: loadCatalog(),
            hub: new HubClient({ baseUrl: env("CHALYB_BASE_URL"), token: env("CHALITO_ADMIN_TOKEN") }),
          },
        }
      : {}),
    // Phone verification (Twilio Verify + Geo Permissions) when configured.
    ...(process.env.TWILIO_VERIFY_SERVICE_SID
      ? {
          phone: {
            store: new PostgresPhoneStore(sql),
            verifier: twilioPhoneVerifier({
              accountSid: env("TWILIO_ACCOUNT_SID"),
              authToken: env("TWILIO_AUTH_TOKEN"),
              verifyServiceSid: env("TWILIO_VERIFY_SERVICE_SID"),
            }),
          },
        }
      : {}),
    rooms: new PostgresRoomsRepo(sql),
    rateBuckets: new PostgresBuckets(sql),
    serverAudit: new PostgresAuditSink(sql),
  };
};

// Production publishes to Pub/Sub `audit` (→ BigQuery). Locally, without the Pub/Sub
// emulator, audit goes to stdout so a dev machine with ADC never publishes to real GCP.
const usePubSub = process.env.K_SERVICE !== undefined || process.env.PUBSUB_EMULATOR_HOST !== undefined;
const topic = usePubSub ? new PubSub().topic(process.env.AUDIT_TOPIC ?? "audit") : null;

const streamAudit: AuditSink = {
  async record(e) {
    const entry = { ...e, t: new Date().toISOString() };
    if (topic) await topic.publishMessage({ json: entry });
    else process.stdout.write(`${JSON.stringify({ audit: entry })}\n`);
  },
};

const { serverAudit, ...data } = backend();
// Every event goes to the stream; owner-scoped ones also to chalito.server_audit (the audit views).
const audit = teeAudit(streamAudit, serverAudit);

const app = createApp({
  ...data,
  audit,
  config: {
    ssoSecret: env("CHALITO_SSO_SECRET"),
    adminToken: env("CHALITO_ADMIN_TOKEN"),
    recoveryCooldownMs: Number(process.env.RECOVERY_COOLDOWN_MS ?? 60 * 60 * 1000),
    skewMs: 60_000,
    trustedProxies: Number(process.env.TRUSTED_PROXIES ?? 0),
  },
  now: Date.now,
  // ADR 0014: signed download URLs from the private releases bucket, signed as the release signer.
  ...(process.env.CHALITO_RELEASES_BUCKET && process.env.CHALITO_RELEASES_SIGNER
    ? { releases: new GcsReleaseStore(process.env.CHALITO_RELEASES_BUCKET, process.env.CHALITO_RELEASES_SIGNER) }
    : {}),
});

// Cloud Run sets PORT; locally 8787 (the Supabase stack uses 543xx).
const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) });
process.on("SIGTERM", () => server.close(() => process.exit(0)));
