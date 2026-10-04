import { randomUUID } from "node:crypto";
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, signInWithCustomToken, type Auth } from "firebase/auth";
import { connectFirestoreEmulator, doc, getFirestore, onSnapshot, type Firestore } from "firebase/firestore";
import { randomNonce, signEnvelope } from "@chalito/crypto";
import { ApiError, DeviceTokenResponse } from "@chalito/protocol";
import type { AgentConfig, PairedConfig } from "./config.js";
import { FirestoreStore } from "./firestore-store.js";
import type { Identity } from "./identity.js";
import type { AgentStore } from "./store.js";

export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export class ApiRequestError extends Error {
  override name = "ApiRequestError";
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ? `${code}: ${message}` : code);
  }
}

/** POST JSON to the control plane; non-2xx becomes an ApiRequestError with the API's error code. */
export const postJson = async (fetchFn: FetchFn, url: string, body: unknown): Promise<unknown> => {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = ApiError.safeParse(json);
    throw new ApiRequestError(res.status, err.success ? err.data.error : `http_${res.status}`, err.data?.message);
  }
  return json;
};

/**
 * Device credential: a fresh signature over a one-time challenge, exchanged for a
 * Firebase custom token. Nothing bearer-like is stored on disk.
 */
export const fetchDeviceToken = async (
  fetchFn: FetchFn,
  cfg: PairedConfig,
  id: Identity,
  now: number,
): Promise<string> => {
  const challenge = await signEnvelope(
    "chalito.refresh-challenge.v1",
    { v: 1 as const, owner: cfg.owner, deviceId: id.deviceId, nonce: await randomNonce(), issuedAt: now },
    id.deviceId,
    id.sign.secretKey,
  );
  const res = DeviceTokenResponse.parse(await postJson(fetchFn, `${cfg.apiBase}/v1/devices/token`, challenge));
  if (res.deviceId !== id.deviceId) throw new Error("device token was issued for another device");
  return res.customToken;
};

/** The daemon's view of the cloud: sign in (again on refresh), then read/write through a store. */
export interface Cloud {
  signIn(customToken: string): Promise<void>;
  store(owner: string, deviceId: string): AgentStore;
  close(): Promise<void>;
}

type Env = Record<string, string | undefined>;

/**
 * A private Firebase app. With FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST set
 * (local e2e, scripts/e2e-claude.md) it talks to the emulators instead of production.
 */
const firebaseClient = (cfg: AgentConfig["firebase"], env: Env): { app: FirebaseApp; auth: Auth; db: Firestore } => {
  const app = initializeApp({ apiKey: cfg.apiKey, projectId: cfg.projectId }, `chalito-${randomUUID()}`);
  const auth = getAuth(app);
  const db = getFirestore(app, cfg.databaseId);
  if (env.FIREBASE_AUTH_EMULATOR_HOST)
    connectAuthEmulator(auth, `http://${env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  if (env.FIRESTORE_EMULATOR_HOST) {
    const [host, port] = env.FIRESTORE_EMULATOR_HOST.split(":");
    connectFirestoreEmulator(db, host || "127.0.0.1", Number(port || 8080));
  }
  return { app, auth, db };
};

export const firebaseCloud = (cfg: AgentConfig["firebase"], env: Env = process.env): Cloud => {
  const { app, auth, db } = firebaseClient(cfg, env);
  return {
    signIn: async (token) => void (await signInWithCustomToken(auth, token)),
    store: (owner, deviceId) => new FirestoreStore(db, owner, deviceId),
    close: () => deleteApp(app),
  };
};

/** Waits on pairingCodes/{codeId} with the single-doc watch token. */
export interface PairingWatcher {
  watch(
    watchToken: string,
    codeId: string,
    onDoc: (data: Record<string, unknown>) => void,
  ): Promise<() => Promise<void>>;
}

export const firebasePairingWatcher = (cfg: AgentConfig["firebase"], env: Env = process.env): PairingWatcher => ({
  watch: async (watchToken, codeId, onDoc) => {
    const { app, auth, db } = firebaseClient(cfg, env);
    await signInWithCustomToken(auth, watchToken);
    const unsub = onSnapshot(doc(db, `pairingCodes/${codeId}`), (snap) => {
      const data = snap.data();
      if (data) onDoc(data);
    });
    return async () => {
      unsub();
      await deleteApp(app);
    };
  },
});
