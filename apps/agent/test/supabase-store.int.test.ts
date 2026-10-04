/**
 * SupabaseStore against the LOCAL Supabase stack (`supabase start`), run by the `supabase` CI
 * job: `eval "$(supabase status -o env)"` provides API_URL, ANON_KEY (publishable) and
 * SERVICE_ROLE_KEY. Refuses any non-local URL.
 *
 * Devices are Supabase Auth users (claim_source() = 'app_metadata', the default since the
 * security review): each has app_metadata.chalito = {owner, device_id, role}, and its
 * devices row carries auth_user_id = that user's id. The agent signs in through the real
 * path (magic-link token_hash → verifyOtp, session in a SecretStore). Chalito rows are
 * seeded as `chalito_server` through `supabase db query --local`, as the smoke script
 * does (the hub's service_role has no access to Chalito's schemas); the service key is used
 * only for the GoTrue admin API. Assertions read back through each device's own RLS.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient as createSupabase, type SupabaseClient } from "@supabase/supabase-js";
import type { AgentEvent, ApprovalRequest } from "@chalito/protocol";
import { supabaseCloud, type Cloud } from "../src/cloud.js";
import {
  SUPABASE_SESSION_SECRET,
  SupabaseAuthTokenSource,
  createDeviceAuth,
  createEphemeralAuth,
  exchangeTokenHash,
} from "../src/device-auth.js";
import { MemorySecretStore } from "../src/secrets.js";
import type { SupabaseStore } from "../src/supabase-store.js";

const API_URL = process.env.API_URL ?? process.env.SUPABASE_URL ?? "";
const ANON = process.env.PUBLISHABLE_KEY || process.env.ANON_KEY || "";
const SERVICE = process.env.SERVICE_ROLE_KEY ?? "";
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(API_URL) && !!ANON && !!SERVICE;

// No generated types for the chalito schema in this test: a deliberately loose client.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;
const createClient = (url: string, key: string, opts: Record<string, unknown>): Db =>
  createSupabase(url, key, opts) as unknown as Db;

const run = randomUUID().replace(/-/g, "").slice(0, 12);
const OWNER = `int-user-${run}`;
const AGENT = `int-agent-${run}`;
const PHONE = `int-phone-${run}`;
const email = (device: string) => `${device}@devices.chalito.invalid`;

/** Server-side SQL as chalito_server (what the API does), against the local stack only. */
const serverSql = (sql: string) =>
  execFileSync("supabase", ["db", "query", "--local", `set role chalito_server; ${sql}`], { stdio: "pipe" });
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

const waitFor = async (cond: () => boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe.skipIf(!LOCAL)("SupabaseStore on the local stack (ADR 0017, devices as Auth users)", () => {
  let gotrue: Db;
  const agentSecrets = new MemorySecretStore();
  const authIds: string[] = [];
  let phoneToken = "";
  let cloud: Cloud;
  let store: SupabaseStore;
  const phone = () => createClient(API_URL, ANON, { db: { schema: "chalito" }, accessToken: async () => phoneToken });
  const tokenHash = async (device: string) => {
    const { data, error } = await gotrue.auth.admin.generateLink({ type: "magiclink", email: email(device) });
    if (error) throw new Error(error.message);
    return data.properties.hashed_token;
  };

  beforeAll(async () => {
    gotrue = createClient(API_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
    const users: Record<string, string> = {};
    for (const [device, role] of [
      [AGENT, "agent"],
      [PHONE, "client"],
    ] as const) {
      const { data, error } = await gotrue.auth.admin.createUser({
        email: email(device),
        email_confirm: true,
        app_metadata: { chalito: { owner: OWNER, device_id: device, role } },
      });
      if (error || !data.user) throw new Error(error?.message ?? "no user");
      users[device] = data.user.id;
      authIds.push(data.user.id);
    }
    const dev = (id: string, role: string, kind: string, platform: string, via: string) =>
      `(${q(OWNER)}, ${q(id)}, ${q(role)}, ${q(kind)}, ${q(platform)}, ${q(id.slice(0, 40))}, 'p', 'p', 'f', ${q(via)}, ${q(users[id]!)})`;
    serverSql(`insert into chalito.tenants (id) values (${q(OWNER)});
      insert into chalito.users (id, tenant_id, call_briefing) values (${q(OWNER)}, ${q(OWNER)}, '{"enabled": true}');
      insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint,
        enrolled_via, auth_user_id)
      values ${dev(AGENT, "agent", "desktop", "linux", "pairing")}, ${dev(PHONE, "client", "phone", "ios", "first_client")};`);

    phoneToken = await exchangeTokenHash(createEphemeralAuth(API_URL, ANON), await tokenHash(PHONE));
    // The agent's real path: magic-link exchange, session kept in the (in-memory) keychain.
    const tokens = new SupabaseAuthTokenSource(createDeviceAuth(API_URL, ANON, agentSecrets), () => tokenHash(AGENT));
    cloud = supabaseCloud({ url: API_URL, publishableKey: ANON }, tokens);
    await cloud.refresh();
    store = cloud.store(OWNER, AGENT) as SupabaseStore;
  });

  afterAll(async () => {
    await cloud?.close();
    for (const id of authIds) await gotrue?.auth.admin.deleteUser(id).catch(() => undefined);
  });

  it("the agent's Supabase Auth session is kept in the SecretStore (keychain), not on disk", async () => {
    expect(await agentSecrets.get(SUPABASE_SESSION_SECRET)).toContain("refresh_token");
  });

  it("upsertSession merges through chalito.session_merge (and creates the session the next writes need)", async () => {
    await store.upsertSession(`s-${run}`, { state: "starting", label: "int" });
    await store.upsertSession(`s-${run}`, { state: "running" });
    const { data, error } = await phone().from("sessions").select("doc").eq("sid", `s-${run}`).single();
    expect(error).toBeNull();
    expect(data?.doc).toMatchObject({ state: "running", label: "int" });
  });

  it("a phone's command reaches the agent over chalito:device:<id> and is deleted when handled", async () => {
    const got: string[] = [];
    store.watchCommands((id) => got.push(id));
    await new Promise((r) => setTimeout(r, 1500)); // join
    const { error } = await phone()
      .from("commands")
      .insert({
        owner: OWNER,
        target_device_id: AGENT,
        id: `c-${run}`,
        env: { ctx: "chalito.command.v1", body: {} },
        from_device_id: PHONE,
      });
    expect(error).toBeNull();
    await waitFor(() => got.includes(`c-${run}`));
    await store.deleteCommand(`c-${run}`);
    // The agent itself can read its commands: none left.
    await store.resync();
    expect(got.filter((id) => id === `c-${run}`)).toHaveLength(1);
  });

  it("the phone's decision row (approval_decisions) reaches the agent's watcher", async () => {
    const now = Date.now();
    const aid = `a-${run}`;
    await store.createApproval({
      v: 1,
      aid,
      uid: OWNER,
      deviceId: AGENT,
      sid: `s-${run}`,
      requestId: `r-${run}`,
      kind: "tool",
      risk: "MED",
      origin: `client:${PHONE}`,
      stepUpRequired: false,
      detailsCt: { v: 1 },
      status: "pending",
      createdAt: now,
      expiresAt: now + 5 * 60_000,
      recommendations: [],
    } as unknown as ApprovalRequest);
    const got: unknown[] = [];
    store.watchApproval(aid, (d) => got.push(d));
    const { error } = await phone()
      .from("approval_decisions")
      .insert({ owner: OWNER, aid, signer_device_id: PHONE, decision: { sig: "x" } });
    expect(error).toBeNull();
    await waitFor(() => got.length === 1);
    expect(got[0]).toEqual({ sig: "x" });
    await store.resolveApproval(aid, "approved", "signed", Date.now());
    const { data } = await phone().from("approvals").select("status").eq("aid", aid).single();
    expect(data).toEqual({ status: "approved" });
  });

  it("device, event, audit and call-line writes pass RLS", async () => {
    await store.updateDevice({ policyHash: "a".repeat(64), lastSeenAt: Date.now() });
    await store.publishDeviceEvent({
      v: 1,
      type: "policy.changed",
      deviceId: AGENT,
      policyHash: "a".repeat(64),
      t: Date.now(),
    });
    await store.writeEvent({
      v: 1,
      eid: `e-${run}`,
      sid: `s-${run}`,
      deviceId: AGENT,
      seq: 0,
      t: Date.now(),
      urgency: "low",
      type: "session.state",
      state: "running",
    } as unknown as AgentEvent);
    expect(await store.callBriefingEnabled()).toBe(true);
    await store.writeCallLine(`l-${run}`, {
      v: 1,
      notificationId: `n-${run}`,
      deviceId: AGENT,
      sid: `s-${run}`,
      line: "¿Apruebo el cambio?",
      expireAt: Date.now() + 60_000,
    });
    await store.deleteCallLine(`l-${run}`);
    const { data: dev } = await phone()
      .from("devices")
      .select("policy_hash, last_event")
      .eq("device_id", AGENT)
      .single();
    expect(dev).toMatchObject({ policy_hash: "a".repeat(64), last_event: { type: "policy.changed" } });
    const { data: audit } = await phone().from("audit").select("type, source").eq("device_id", AGENT);
    expect(audit).toContainEqual({ type: "policy.changed", source: "deviceEvent" });
    const { data: events } = await phone().from("session_events").select("eid").eq("sid", `s-${run}`);
    expect(events).toContainEqual({ eid: `e-${run}` });
  });

  it("a revoked agent is denied on its next write", async () => {
    serverSql(`update chalito.devices set revoked = true, revoked_at = now() where device_id = ${q(AGENT)};`);
    await expect(
      store.audit({ eid: `x-${run}`, t: Date.now(), type: "t", meta: {}, source: "agent" }),
    ).rejects.toThrow();
    const { data } = await phone().from("devices").select("last_seen_at").eq("device_id", AGENT).single();
    await store.updateDevice({ lastSeenAt: Date.now() + 60_000 });
    const { data: after } = await phone().from("devices").select("last_seen_at").eq("device_id", AGENT).single();
    expect(after).toEqual(data);
  });
});
