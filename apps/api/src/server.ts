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
const topic = new PubSub().topic(process.env.AUDIT_TOPIC ?? "audit");

const audit: AuditSink = {
  async record(e) {
    await topic.publishMessage({ json: { ...e, t: new Date().toISOString() } });
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

const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) });
process.on("SIGTERM", () => server.close(() => process.exit(0)));
