import { deleteApp, initializeApp as initClientApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth as getClientAuth, signInWithCustomToken } from "firebase/auth";
import {
  addDoc,
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getFirestore,
  updateDoc,
  type Firestore,
} from "firebase/firestore";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore as getAdminFirestore } from "firebase-admin/firestore";
import { afterAll, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, fakeClaudeCode } from "@chalito/adapters/claude-code";
import { loadLiabilityText } from "@chalito/config";
import {
  MemoryNonceStore,
  TrustedClientList,
  generateBoxKeyPair,
  generateSigningKeyPair,
  randomNonce,
  sealJson,
  signEnvelope,
  toB64url,
} from "@chalito/crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCore } from "../src/agent-core.js";
import { DevMode, DevModeStore } from "../src/devmode.js";
import { FirestoreStore } from "../src/firestore-store.js";
import { DEFAULT_POLICY, type Policy } from "../src/policy/index.js";
import { createLogger } from "../src/redact.js";

const PROJECT = "demo-chalito";
const OWNER = `agent-emu-${Date.now()}`;
const WS = "/home/aldo/code/chalito";
const admin = getApps()[0] ?? initializeApp({ projectId: PROJECT });
const apps: FirebaseApp[] = [];

const signIn = async (uid: string, claims: object): Promise<Firestore> => {
  const token = await getAuth(admin).createCustomToken(uid, claims);
  const app = initClientApp({ projectId: PROJECT, apiKey: "demo" }, uid + Math.random());
  apps.push(app);
  const auth = getClientAuth(app);
  connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
  const db = getFirestore(app);
  const [h, p] = process.env.FIRESTORE_EMULATOR_HOST!.split(":");
  connectFirestoreEmulator(db, h!, Number(p));
  await signInWithCustomToken(auth, token);
  return db;
};

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 5000) => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
};

afterAll(async () => Promise.all(apps.map((a) => deleteApp(a))));

describe("agent over Firestore (emulator, real rules)", () => {
  it("receives a signed command, requests an approval and runs the tool after the phone's signed decision", async () => {
    const agentBox = await generateBoxKeyPair();
    const phoneSign = await generateSigningKeyPair();
    const phoneBox = await generateBoxKeyPair();
    const agentId = "dev_agentEmu";
    const phoneId = "dev_phoneEmu";
    const adb = getAdminFirestore(admin);
    for (const [id, role] of [
      [agentId, "agent"],
      [phoneId, "client"],
    ] as const) {
      await adb.doc(`users/${OWNER}/devices/${id}`).set({
        v: 1,
        deviceId: id,
        owner: OWNER,
        role,
        revoked: false,
        devMode: { on: false, toggles: [], since: null },
        policyHash: null,
        lastSeenAt: null,
      });
    }
    await adb.doc(`users/${OWNER}`).set({ v: 1, callBriefing: { enabled: true } });

    const agentDb = await signIn(`d_${agentId}`, { role: "agent", owner: OWNER, deviceId: agentId });
    const phoneDb = await signIn(`d_${phoneId}`, { role: "client", owner: OWNER, deviceId: phoneId });

    const trust = new TrustedClientList(agentId);
    await trust.addConfirmed(
      { deviceId: phoneId, pubSign: await toB64url(phoneSign.publicKey), pubBox: await toB64url(phoneBox.publicKey) },
      Date.now(),
    );
    const policy: Policy = { ...DEFAULT_POLICY, workspaces: [{ label: "chalito", path: WS }] };
    const fake = fakeClaudeCode([[{ tool: "Edit", input: { file_path: `${WS}/src/a.ts` } }]]);
    const store = new FirestoreStore(agentDb, OWNER, agentId);
    const liability = loadLiabilityText("es");
    const core = new AgentCore({
      store,
      adapters: { "claude-code": new ClaudeCodeAdapter({ apiKey: "sk-ant-test", queryFn: fake.queryFn, env: {} }) },
      policy: { get: () => policy, set: async () => undefined },
      devMode: new DevMode({
        store: new DevModeStore(mkdtempSync(join(tmpdir(), "dm-")), await generateSigningKeyPair(), agentId),
        osAuth: { verify: async () => false },
        prompter: {
          first: async () => false,
          second: async () => false,
          liability: async () => ({ checked: false, typed: "" }),
        },
        liability,
        deviceId: agentId,
        now: Date.now,
        emit: async () => undefined,
      }),
      trust: () => trust,
      saveTrust: async () => undefined,
      nonces: new MemoryNonceStore(),
      owner: OWNER,
      self: { deviceId: agentId, pubBox: await toB64url(agentBox.publicKey), box: agentBox },
      home: "/home/aldo",
      locale: () => "es",
      now: Date.now,
      log: createLogger(() => undefined),
    });
    const handled: string[] = [];
    store.watchCommands((id, d) => void core.handleCommand(id, d).then((r) => handled.push(`${id}:${r.ok}`)));

    // The phone sends a signed session.start through Firestore.
    const body = {
      v: 1 as const,
      cid: "cmd1",
      uid: OWNER,
      targetDeviceId: agentId,
      origin: `client:${phoneId}`,
      nonce: await randomNonce(),
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      payload: {
        type: "session.start" as const,
        adapter: "claude-code" as const,
        workspaceLabel: "chalito",
        promptCt: await sealJson("arregla el login", { [agentId]: agentBox.publicKey }, "command:cmd1"),
        permissionMode: "default" as const,
      },
    };
    const env = await signEnvelope("chalito.command.v1", body, phoneId, phoneSign.secretKey);
    await addDoc(collection(phoneDb, `users/${OWNER}/devices/${agentId}/commands`), {
      env,
      createdAt: Date.now(),
      fromDeviceId: phoneId,
    });
    await waitFor(() => handled.length === 1);
    expect(handled[0]).toMatch(/:true$/);

    // The approval appears in Firestore; the phone attaches a signed decision.
    let aid = "";
    let requestId = "";
    await waitFor(async () => {
      const q = (await adb.collection(`users/${OWNER}/approvals`).get()).docs[0];
      if (!q) return false;
      aid = q.id;
      requestId = q.get("requestId");
      return true;
    });
    expect(fake.run.ran).toHaveLength(0);
    const decision = await signEnvelope(
      "chalito.decision.v1",
      {
        v: 1 as const,
        aid,
        requestId,
        uid: OWNER,
        targetDeviceId: agentId,
        allow: true,
        nonce: await randomNonce(),
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
      phoneId,
      phoneSign.secretKey,
    );
    await updateDoc(doc(phoneDb, `users/${OWNER}/approvals/${aid}`), { decision });
    await waitFor(() => fake.run.ran.length === 1);
    await waitFor(
      async () => (await getDoc(doc(phoneDb, `users/${OWNER}/approvals/${aid}`))).get("status") === "approved",
    );
    // Command doc was consumed; a call line was published for the waiting approval, then removed.
    expect((await adb.collection(`users/${OWNER}/devices/${agentId}/commands`).get()).empty).toBe(true);
    await waitFor(async () => (await adb.collection(`users/${OWNER}/callLines`).get()).empty);
  });

  it("writes the durable audit trail (agent entries and device events), redacted", async () => {
    const agentId = "dev_auditEmu";
    const adb = getAdminFirestore(admin);
    await adb.doc(`users/${OWNER}/devices/${agentId}`).set({
      v: 1,
      deviceId: agentId,
      owner: OWNER,
      role: "agent",
      revoked: false,
      devMode: { on: false, toggles: [], since: null },
      policyHash: null,
      lastSeenAt: null,
    });
    const db = await signIn(`d_${agentId}`, { role: "agent", owner: OWNER, deviceId: agentId });
    const store = new FirestoreStore(db, OWNER, agentId);
    await store.audit({
      eid: "e1",
      t: 1,
      type: "command.rejected",
      meta: { reason: "Bearer abcdefghijklmnop", missing: undefined },
      source: "agent",
    });
    await store.publishDeviceEvent({
      v: 1,
      type: "remote_enable.rejected",
      deviceId: agentId,
      attempted: "devmode.on",
      origin: "local",
      t: 2,
    });
    const docs = (await adb.collection(`users/${OWNER}/devices/${agentId}/audit`).get()).docs.map((d) => d.data());
    expect(docs).toHaveLength(2);
    expect(docs.find((d) => d.source === "agent")).toMatchObject({
      type: "command.rejected",
      meta: { reason: "Bearer …" },
      deviceId: agentId,
    });
    expect(docs.find((d) => d.source === "deviceEvent")).toMatchObject({ type: "remote_enable.rejected", t: 2 });
    expect((await adb.doc(`users/${OWNER}/devices/${agentId}`).get()).get("lastEvent.type")).toBe(
      "remote_enable.rejected",
    );
  });
});
