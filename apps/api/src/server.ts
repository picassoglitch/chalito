import { serve } from "@hono/node-server";
import { PubSub } from "@google-cloud/pubsub";
import { createClient } from "@supabase/supabase-js";
import { createApp } from "./app.js";
import type { AuditSink } from "./deps.js";
import { PostgresRepo, chalitoSql } from "./postgres/repo.js";
import { PostgresRoomsRepo, type RoomsRepo } from "./rooms/repo.js";
import type { ApiRepo, IdentityIssuer } from "./repo.js";
import { SupabaseIssuer, chalitoAuthUserId } from "./supabase/identity.js";

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
const backend = (): { repo: ApiRepo; identity: IdentityIssuer; rooms: RoomsRepo } => {
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
    rooms: new PostgresRoomsRepo(sql),
  };
};

// Production publishes to Pub/Sub `audit` (→ BigQuery). Locally, without the Pub/Sub
// emulator, audit goes to stdout so a dev machine with ADC never publishes to real GCP.
const usePubSub = process.env.K_SERVICE !== undefined || process.env.PUBSUB_EMULATOR_HOST !== undefined;
const topic = usePubSub ? new PubSub().topic(process.env.AUDIT_TOPIC ?? "audit") : null;

const audit: AuditSink = {
  async record(e) {
    const entry = { ...e, t: new Date().toISOString() };
    if (topic) await topic.publishMessage({ json: entry });
    else process.stdout.write(`${JSON.stringify({ audit: entry })}\n`);
  },
};

const app = createApp({
  ...backend(),
  audit,
  config: {
    ssoSecret: env("CHALITO_SSO_SECRET"),
    adminToken: env("CHALITO_ADMIN_TOKEN"),
    recoveryCooldownMs: Number(process.env.RECOVERY_COOLDOWN_MS ?? 60 * 60 * 1000),
    skewMs: 60_000,
  },
  now: Date.now,
});

// Cloud Run sets PORT; locally 8787 (the Supabase stack uses 543xx).
const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) });
process.on("SIGTERM", () => server.close(() => process.exit(0)));
