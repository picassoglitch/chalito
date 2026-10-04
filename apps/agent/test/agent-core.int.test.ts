/**
 * The Supabase counterpart of the old firestore-store.emu.test.ts: AgentCore over
 * SupabaseStore on the LOCAL stack, real RLS, devices as Supabase Auth users. Run by the
 * `supabase` CI job (`pnpm --filter @chalito/agent test:supabase`).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter, fakeClaudeCode } from "@chalito/adapters/claude-code";
import { loadLiabilityText } from "@chalito/config";
import {
  MemoryNonceStore,
  TrustedClientList,
  deriveDeviceId,
  generateBoxKeyPair,
  generateSigningKeyPair,
  openJson,
  randomNonce,
  sealJson,
  signEnvelope,
  toB64url,
} from "@chalito/crypto";
import { AgentCore } from "../src/agent-core.js";
import { DevMode, DevModeStore } from "../src/devmode.js";
import { DEFAULT_POLICY, type Policy } from "../src/policy/index.js";
import { createLogger } from "../src/redact.js";
import { SupabaseStore, type SupaClient } from "../src/supabase-store.js";
import { LOCAL, createDeviceUser, deviceDb, gotrue, seedOwner, waitFor, type Db } from "./supabase-local.js";

const run = randomUUID().replace(/-/g, "").slice(0, 10);
const OWNER = `agent-int-${run}`;
const WS = "/home/aldo/code/chalito";

describe.skipIf(!LOCAL)("AgentCore over Supabase (local stack, real RLS)", () => {
  let admin: Db;
  const authIds: string[] = [];
  const cleanups: (() => unknown)[] = [];

  beforeAll(() => {
    admin = gotrue();
  });
  afterAll(async () => {
    for (const c of cleanups.reverse()) await Promise.resolve(c()).catch(() => undefined);
    for (const id of authIds) await admin?.auth.admin.deleteUser(id).catch(() => undefined);
  });

  it("receives a signed command, requests an approval and runs the tool after the phone's signed decision", async () => {
    const agentSign = await generateSigningKeyPair();
    const agentBox = await generateBoxKeyPair();
    const phoneSign = await generateSigningKeyPair();
    const phoneBox = await generateBoxKeyPair();
    const agentId = await deriveDeviceId(agentSign.publicKey);
    const phoneId = await deriveDeviceId(phoneSign.publicKey);
    const agentUser = await createDeviceUser(admin, OWNER, agentId, "agent");
    const phoneUser = await createDeviceUser(admin, OWNER, phoneId, "client");
    authIds.push(agentUser, phoneUser);
    seedOwner(
      OWNER,
      [
        { deviceId: agentId, role: "agent", authUserId: agentUser, pubBox: await toB64url(agentBox.publicKey) },
        { deviceId: phoneId, role: "client", authUserId: phoneUser, pubBox: await toB64url(phoneBox.publicKey) },
      ],
      { callBriefing: true },
    );
    const agentDb = await deviceDb(admin, agentId);
    const phoneDb = await deviceDb(admin, phoneId);

    const trust = new TrustedClientList(agentId);
    await trust.addConfirmed(
      { deviceId: phoneId, pubSign: await toB64url(phoneSign.publicKey), pubBox: await toB64url(phoneBox.publicKey) },
      Date.now(),
    );
    const policy: Policy = { ...DEFAULT_POLICY, workspaces: [{ label: "chalito", path: WS }] };
    const fake = fakeClaudeCode([[{ tool: "Edit", input: { file_path: `${WS}/src/a.ts` } }]]);
    // Every channel status (and any Realtime error) goes into the failure message of each wait.
    const realtimeLog: string[] = [];
    const log = createLogger((l) => {
      const j = JSON.parse(l) as { msg: string; status?: string; error?: string | null };
      if (j.msg.startsWith("realtime.")) realtimeLog.push(`${j.msg} ${j.status ?? ""} ${j.error ?? ""}`.trim());
    });
    const explain = () => `realtime (agent channel): ${realtimeLog.join(" | ") || "no status yet"}`;
    const store = new SupabaseStore(agentDb as unknown as SupaClient, OWNER, agentId, { log });
    const core = new AgentCore({
      store,
      adapters: { "claude-code": new ClaudeCodeAdapter({ apiKey: "sk-ant-test", queryFn: fake.queryFn, env: {} }) },
      policy: { get: () => policy, set: async () => undefined },
      devMode: new DevMode({
        store: new DevModeStore(mkdtempSync(join(tmpdir(), "dm-")), agentSign, agentId),
        osAuth: { verify: async () => false },
        prompter: {
          first: async () => false,
          second: async () => false,
          liability: async () => ({ checked: false, typed: "" }),
        },
        liability: loadLiabilityText("es"),
        deviceId: agentId,
        now: Date.now,
        emit: async () => undefined,
      }),
      trust: () => trust,
      saveTrust: async () => undefined,
      nonces: new MemoryNonceStore(),
      owner: OWNER,
      self: { deviceId: agentId, pubBox: await toB64url(agentBox.publicKey), box: agentBox, sign: agentSign },
      home: "/home/aldo",
      locale: () => "es",
      now: Date.now,
      log: createLogger(() => undefined),
    });
    const handled: string[] = [];
    const stopCommands = store.watchCommands(
      (id, d) => void core.handleCommand(id, d).then((r) => handled.push(`${id}:${r.ok}`)),
    );
    cleanups.push(async () => {
      stopCommands();
      for (const s of core.sessions.values()) {
        s.handle.close();
        await s.handle.done.catch(() => undefined);
      }
      await store.close();
    });
    await store.joined();
    await waitFor(() => realtimeLog.some((l) => l.startsWith("realtime.subscribed")), 15_000, explain);

    // The phone sends a signed session.start.
    const cid = `cmd-${run}`;
    const body = {
      v: 1 as const,
      cid,
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
        promptCt: await sealJson("arregla el login", { [agentId]: agentBox.publicKey }, `command:${cid}`),
        permissionMode: "default" as const,
      },
    };
    const env = await signEnvelope("chalito.command.v1", body, phoneId, phoneSign.secretKey);
    const sent = await phoneDb
      .from("commands")
      .insert({ owner: OWNER, target_device_id: agentId, id: cid, env, from_device_id: phoneId });
    expect(sent.error).toBeNull();
    await waitFor(() => handled.length === 1, 15_000, explain);
    expect(handled[0]).toMatch(/:true$/);

    // The approval appears; the phone inserts its signed decision row.
    let aid = "";
    let requestId = "";
    let detailsCt: unknown = null;
    await waitFor(
      async () => {
        const { data } = await phoneDb
          .from("approvals")
          .select("aid, request_id, status, details_ct")
          .eq("owner", OWNER);
        const a = data?.[0];
        if (!a) return false;
        aid = a.aid;
        requestId = a.request_id;
        detailsCt = a.details_ct;
        return true;
      },
      15_000,
      explain,
    );
    expect(fake.run.ran).toHaveLength(0);
    // ADR 0019: answer for exactly the hash the agent signed (inside the sealed details).
    const opened = await openJson<{ request: { body: { detailsHash: string } } }>(
      detailsCt as never,
      phoneId,
      phoneBox,
      `approval:${aid}`,
    );
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
        detailsHash: opened.request.body.detailsHash,
      },
      phoneId,
      phoneSign.secretKey,
    );
    const decided = await phoneDb
      .from("approval_decisions")
      .insert({ owner: OWNER, aid, signer_device_id: phoneId, decision });
    expect(decided.error).toBeNull();
    await waitFor(() => fake.run.ran.length === 1, 15_000, explain);
    await waitFor(
      async () => {
        const { data } = await phoneDb.from("approvals").select("status").eq("aid", aid).single();
        return data?.status === "approved";
      },
      15_000,
      explain,
    );

    // The command was consumed; the call line published for the waiting approval is gone.
    const { data: left } = await agentDb.from("commands").select("id").eq("id", cid);
    expect(left).toEqual([]);
    await waitFor(
      async () => {
        const { data } = await agentDb.from("call_lines").select("lid").eq("owner", OWNER);
        return (data ?? []).length === 0;
      },
      15_000,
      explain,
    );
  });

  it("writes the durable audit trail (agent entries and device events), redacted", async () => {
    const sign = await generateSigningKeyPair();
    const agentId = await deriveDeviceId(sign.publicKey);
    const user = await createDeviceUser(admin, `${OWNER}-a`, agentId, "agent");
    authIds.push(user);
    seedOwner(`${OWNER}-a`, [{ deviceId: agentId, role: "agent", authUserId: user }]);
    const db = await deviceDb(admin, agentId);
    const store = new SupabaseStore(db as unknown as SupaClient, `${OWNER}-a`, agentId);
    await store.audit({
      eid: `e1-${run}`,
      t: 1,
      type: "command.rejected",
      meta: { reason: "Bearer abcdefghijklmnop", missing: undefined },
      source: "agent",
    });
    await store.publishDeviceEvent({
      v: 1,
      type: "remote_enable.rejected",
      deviceId: agentId,
      attempted: "devmode.on Bearer abcdefghijklmnopqrstuvwxyz",
      origin: "local",
      t: 2,
    });
    const { data: rows } = await db.from("audit").select("type, source, meta, t").eq("device_id", agentId);
    expect(rows).toHaveLength(2);
    expect(rows!.find((d) => d.source === "agent")).toMatchObject({
      type: "command.rejected",
      meta: { reason: "Bearer …" },
    });
    // `t` is server time (trigger), not the client's 2.
    expect(Date.parse(rows!.find((d) => d.source === "deviceEvent")!.t)).toBeGreaterThan(Date.now() - 60_000);
    const { data: dev } = await db.from("devices").select("last_event").eq("device_id", agentId).single();
    expect(dev?.last_event).toMatchObject({ type: "remote_enable.rejected", attempted: "devmode.on Bearer …" });
    expect(JSON.stringify(rows)).not.toContain("abcdefghijklmnop");
  });
});
