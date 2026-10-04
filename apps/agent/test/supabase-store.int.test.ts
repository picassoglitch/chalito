/**
 * SupabaseStore against the LOCAL Supabase stack (`supabase start`), run by the `supabase`
 * CI job: `eval "$(supabase status -o env)"` provides API_URL, ANON_KEY (publishable) and
 * SERVICE_ROLE_KEY. Device JWTs are minted with `supabase gen bearer-jwt` (custom claims,
 * iss = chalito), as supabase/scripts/smoke-data-api.sh does. Refuses any non-local URL.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient as createSupabase, type SupabaseClient } from "@supabase/supabase-js";
import type { AgentEvent, ApprovalRequest } from "@chalito/protocol";
import { apiTokenSource, supabaseCloud, type Cloud, type TokenSource } from "../src/cloud.js";
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
const ANON = process.env.PUBLISHABLE_KEY ?? process.env.ANON_KEY ?? "";
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

const agentSecrets = new MemorySecretStore();

const mint = (device: string, role: "agent" | "client") =>
  execFileSync(
    "supabase",
    [
      "gen",
      "bearer-jwt",
      "--role",
      "authenticated",
      "--sub",
      `${role}:${device}`,
      "--valid-for",
      "5m",
      "--payload",
      JSON.stringify({ iss: "chalito", aud: "authenticated", owner: OWNER, device_id: device, chalito_role: role }),
    ],
    { encoding: "utf8" },
  ).trim();

const waitFor = async (cond: () => boolean, ms = 10_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe.skipIf(!LOCAL)("SupabaseStore on the local stack (ADR 0017)", () => {
  let admin: Db;
  // claim_source() decides how device tokens look: custom JWTs (iss = chalito) or a Supabase
  // Auth user per device (app_metadata.chalito, the owner's choice). Probe which one this DB has.
  let mode = "custom" as "custom" | "app_metadata";
  const email = (device: string) => `${device}@devices.chalito.invalid`;
  const tokenHash = async (device: string) => {
    const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: email(device) });
    if (error) throw new Error(error.message);
    return data.properties.hashed_token;
  };
  let phoneToken = "";
  const phone = () => createClient(API_URL, ANON, { db: { schema: "chalito" }, accessToken: async () => phoneToken });
  let cloud: Cloud;
  let store: SupabaseStore;

  beforeAll(async () => {
    admin = createClient(API_URL, SERVICE, { db: { schema: "chalito" } });
    const ok = async (q: PromiseLike<{ error: unknown }>) => {
      const { error } = await q;
      if (error) throw new Error(JSON.stringify(error));
    };
    await ok(admin.from("tenants").insert({ id: OWNER }));
    await ok(admin.from("users").insert({ id: OWNER, tenant_id: OWNER, call_briefing: { enabled: true } }));
    const dev = (device_id: string, role: string, kind: string, platform: string) => ({
      owner: OWNER,
      device_id,
      role,
      kind,
      platform,
      name: device_id.slice(0, 40),
      pub_sign: "p",
      pub_box: "p",
      fingerprint: "f",
      enrolled_via: role === "agent" ? "pairing" : "first_client",
    });
    await ok(admin.from("devices").insert(dev(AGENT, "agent", "desktop", "linux")));
    await ok(admin.from("devices").insert(dev(PHONE, "client", "phone", "ios")));

    phoneToken = mint(PHONE, "client");
    const probe = await phone().from("devices").select("device_id");
    mode = (probe.data ?? []).length > 0 ? "custom" : "app_metadata";

    let tokens: TokenSource;
    if (mode === "custom") {
      tokens = apiTokenSource(async () => mint(AGENT, "agent"));
    } else {
      for (const [device, role] of [
        [AGENT, "agent"],
        [PHONE, "client"],
      ] as const) {
        const { error } = await admin.auth.admin.createUser({
          email: email(device),
          email_confirm: true,
          app_metadata: { chalito: { owner: OWNER, device_id: device, chalito_role: role } },
        });
        if (error) throw new Error(error.message);
      }
      phoneToken = await exchangeTokenHash(createEphemeralAuth(API_URL, ANON), await tokenHash(PHONE));
      // The real device path: magic-link exchange, session kept in the (in-memory) keychain.
      tokens = new SupabaseAuthTokenSource(createDeviceAuth(API_URL, ANON, agentSecrets), () => tokenHash(AGENT));
    }
    cloud = supabaseCloud({ url: API_URL, publishableKey: ANON }, tokens);
    await cloud.refresh();
    store = cloud.store(OWNER, AGENT) as SupabaseStore;
  });

  afterAll(async () => {
    await cloud?.close();
    if (mode === "app_metadata") {
      const { data } = await admin.auth.admin.listUsers();
      for (const u of data?.users ?? [])
        if (u.email?.endsWith(`-${run}@devices.chalito.invalid`)) await admin.auth.admin.deleteUser(u.id);
    }
    await admin.from("users").delete().eq("id", OWNER);
    await admin.from("tenants").delete().eq("id", OWNER);
  });

  it("in device-user mode the agent's session is kept in the keychain (SecretStore), not on disk", async (ctx) => {
    if (mode !== "app_metadata") ctx.skip();
    expect(await agentSecrets.get(SUPABASE_SESSION_SECRET)).toContain("refresh_token");
  });

  it("a phone's signed command reaches the agent over device:<id> and is deleted when handled", async () => {
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
    const { data } = await admin.from("commands").select("id").eq("id", `c-${run}`);
    expect(data).toEqual([]);
  });

  it("an approval the agent creates gets the phone's decision through the channel", async () => {
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
      .from("approvals")
      .update({ decision: { sig: "x" } })
      .eq("owner", OWNER)
      .eq("aid", aid);
    expect(error).toBeNull();
    await waitFor(() => got.length === 1);
    expect(got[0]).toEqual({ sig: "x" });
    await store.resolveApproval(aid, "approved", "signed", Date.now());
    const { data } = await admin.from("approvals").select("status").eq("aid", aid).single();
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
    const { data: dev } = await admin.from("devices").select("policy_hash, last_event").eq("device_id", AGENT).single();
    expect(dev).toMatchObject({ policy_hash: "a".repeat(64), last_event: { type: "policy.changed" } });
    const { data: audit } = await admin.from("audit").select("type, source").eq("device_id", AGENT);
    expect(audit).toContainEqual({ type: "policy.changed", source: "deviceEvent" });
  });

  it("upsertSession merges via chalito.session_merge (skipped until that migration lands)", async (ctx) => {
    const { error: probe } = await admin.rpc("session_merge", { p_sid: "probe", p_patch: {} });
    if (probe?.code === "PGRST202") ctx.skip();
    await store.upsertSession(`s-${run}`, { state: "starting", label: "int" });
    await store.upsertSession(`s-${run}`, { state: "running" });
    const { data } = await admin.from("sessions").select("doc").eq("sid", `s-${run}`).single();
    expect(data?.doc).toMatchObject({ state: "running", label: "int" });
  });

  it("a revoked agent is denied on its next write (RLS filters the update to zero rows)", async () => {
    await admin.from("devices").update({ revoked: true }).eq("device_id", AGENT);
    const before = (await admin.from("devices").select("last_seen_at").eq("device_id", AGENT).single()).data;
    await store.updateDevice({ lastSeenAt: Date.now() + 60_000 });
    const after = (await admin.from("devices").select("last_seen_at").eq("device_id", AGENT).single()).data;
    expect(after).toEqual(before);
    await expect(
      store.audit({ eid: `x-${run}`, t: Date.now(), type: "t", meta: {}, source: "agent" }),
    ).rejects.toThrow();
  });
});
