import { serve } from "@hono/node-server";
import { PubSub } from "@google-cloud/pubsub";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { createApp } from "./app.js";
import type { AuditSink } from "./deps.js";

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};

const firebase = initializeApp({ projectId: env("GOOGLE_CLOUD_PROJECT") });
const db = getFirestore(firebase, process.env.FIRESTORE_DATABASE ?? "chalito");
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
  db,
  auth: getAuth(firebase),
  audit,
  config: {
    ssoSecret: env("CHALITO_SSO_SECRET"),
    adminToken: env("CHALITO_ADMIN_TOKEN"),
    recoveryCooldownMs: Number(process.env.RECOVERY_COOLDOWN_MS ?? 60 * 60 * 1000),
    skewMs: 60_000,
  },
  now: Date.now,
});

// Cloud Run sets PORT; the local default avoids the Firestore emulator's 8080.
const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8787) });
process.on("SIGTERM", () => server.close(() => process.exit(0)));
