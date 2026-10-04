/**
 * The browser client against the LOCAL Supabase stack (`supabase start`), run by the
 * `supabase` CI job (`eval "$(supabase status -o env)"` → API_URL, ANON_KEY,
 * SERVICE_ROLE_KEY). Two devices, both Supabase Auth users with app_metadata.chalito:
 *   agent  writes a session and an approval sealed to the browser (ADR 0019: the details plus
 *          its signed request, which the browser verifies against the agent key it trusts);
 *   client (this package) sees it live, opens it, and inserts a signed Decision that the
 *          agent's local TrustedClientList verifies.
 * Rows are seeded as chalito_server through one DO block per `supabase db query` call.
 * Refuses any non-local URL.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient as createSupabase, type SupabaseClient } from "@supabase/supabase-js";
import {
  MemoryNonceStore,
  TrustedClientList,
  canonicalize,
  fromB64url,
  openJson,
  sealJson,
  sha256,
  signEnvelope,
  utf8,
} from "@chalito/crypto";
import type { CommandBody, CommandPayload } from "@chalito/protocol";
import { connect, memoryStorage, type ChalitoClient } from "../src/auth.js";
import { newDevice, testKeys, type Device } from "./helpers.js";

const API_URL = process.env.API_URL ?? process.env.SUPABASE_URL ?? "";
const ANON = process.env.PUBLISHABLE_KEY || process.env.ANON_KEY || "";
const SERVICE = process.env.SERVICE_ROLE_KEY ?? "";
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(API_URL) && !!ANON && !!SERVICE;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = SupabaseClient<any, any, any>;
const createClient = (url: string, key: string, opts: Record<string, unknown>): Db =>
  createSupabase(url, key, opts) as unknown as Db;

const run = randomUUID().replace(/-/g, "").slice(0, 10);
const OWNER = `int-owner-${run}`;
const email = (id: string) => `${id.toLowerCase()}@devices.chalito.invalid`;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** One statement per `supabase db query` call: role switch + seeds inside one DO block. */
const serverSql = (sql: string) =>
  execFileSync(
    "supabase",
    ["db", "query", "--local", `do $srv$ begin set local role chalito_server; ${sql} end $srv$`],
    { stdio: "pipe" },
  );

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 15_000) => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe.skipIf(!LOCAL)("browser client ⇄ agent on the local stack", () => {
  let gotrue: Db;
  let agentDb: Db;
  let agent: Device;
  let browser: Device;
  let client: ChalitoClient;
  const authIds: string[] = [];
  const tokenHash = async (id: string) => {
    const { data, error } = await gotrue.auth.admin.generateLink({ type: "magiclink", email: email(id) });
    if (error) throw new Error(error.message);
    return data.properties.hashed_token;
  };

  beforeAll(async () => {
    gotrue = createClient(API_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
    agent = await newDevice();
    browser = await newDevice();
    const users: Record<string, string> = {};
    for (const [d, role] of [
      [agent, "agent"],
      [browser, "client"],
    ] as const) {
      const { data, error } = await gotrue.auth.admin.createUser({
        email: email(d.deviceId),
        email_confirm: true,
        app_metadata: { chalito: { owner: OWNER, device_id: d.deviceId, role } },
      });
      if (error || !data.user) throw new Error(error?.message ?? "no user");
      users[d.deviceId] = data.user.id;
      authIds.push(data.user.id);
    }
    const row = (d: Device, role: string, kind: string, platform: string, via: string) =>
      `(${q(OWNER)}, ${q(d.deviceId)}, ${q(role)}, ${q(kind)}, ${q(platform)}, ${q(role)}, ${q(d.pubSign)}, ${q(d.pubBox)}, 'f', ${q(via)}, ${q(users[d.deviceId]!)})`;
    serverSql(`insert into chalito.tenants (id) values (${q(OWNER)});
      insert into chalito.users (id, tenant_id) values (${q(OWNER)}, ${q(OWNER)});
      insert into chalito.devices (owner, device_id, role, kind, platform, name, pub_sign, pub_box, fingerprint,
        enrolled_via, auth_user_id)
      values ${row(agent, "agent", "desktop", "linux", "pairing")}, ${row(browser, "client", "web", "web", "first_client")};`);

    // The agent: its own Supabase Auth session (magic link), as the daemon does.
    const agentAuth = createClient(API_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await agentAuth.auth.verifyOtp({
      token_hash: await tokenHash(agent.deviceId),
      type: "magiclink",
    });
    if (error || !data.session) throw new Error(error?.message ?? "no session");
    const agentToken = data.session.access_token;
    agentDb = createClient(API_URL, ANON, { db: { schema: "chalito" }, accessToken: async () => agentToken });

    // The browser: this package, signing in as its device user.
    client = await connect({
      url: API_URL,
      publishableKey: ANON,
      keys: testKeys(browser, { [agent.deviceId]: agent.pubBox }, { [agent.deviceId]: agent.pubSign }),
      owner: OWNER,
      signIn: { kind: "device", deviceId: browser.deviceId, login: () => tokenHash(browser.deviceId) },
      stepUp: async () => ({ method: "platform_biometric", at: Date.now() }),
      storage: memoryStorage(),
    });
    await waitFor(() => client.live.getSnapshot().status === "live");
  });

  afterAll(async () => {
    await client?.close();
    for (const id of authIds) await gotrue?.auth.admin.deleteUser(id).catch(() => undefined);
  });

  it("sees the agent's devices and session live", async () => {
    const { error } = await agentDb.rpc("session_merge", { p_sid: `s-${run}`, p_patch: { state: "running" } });
    expect(error).toBeNull();
    await waitFor(() => client.live.getSnapshot().devices.length === 2);
    await client.live.resync(); // sessions broadcast to clients; resync covers a join race
    await waitFor(() => !!client.live.session(`s-${run}`));
    expect(client.live.session(`s-${run}`)).toMatchObject({ agentDeviceId: agent.deviceId, state: "running" });
  });

  it("opens an approval sealed to it and sends a Decision the agent verifies", async () => {
    const aid = `a-${run}`;
    // What a real agent seals (ADR 0019): the details plus its signed request over their hash.
    const details = { v: 1, toolName: "Bash", summary: "pnpm install", reasons: [], origin: "local" };
    const detailsHash = [...(await sha256(utf8(canonicalize(details))))]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    const now = Date.now();
    const request = await signEnvelope(
      "chalito.approval.v1",
      {
        v: 1,
        aid,
        requestId: `r-${run}`,
        sid: `s-${run}`,
        deviceId: agent.deviceId,
        kind: "tool",
        risk: "MED",
        stepUpRequired: false,
        origin: "local",
        createdAt: now,
        expiresAt: now + 5 * 60_000,
        detailsHash,
      },
      agent.deviceId,
      agent.sign.secretKey,
    );
    const details_ct = await sealJson(
      { details, request },
      { [browser.deviceId]: await fromB64url(browser.pubBox), [agent.deviceId]: await fromB64url(agent.pubBox) },
      `approval:${aid}`,
    );
    const { error } = await agentDb.from("approvals").insert({
      owner: OWNER,
      aid,
      device_id: agent.deviceId,
      sid: `s-${run}`,
      request_id: `r-${run}`,
      kind: "tool",
      risk: "MED",
      origin: "local",
      step_up_required: false,
      details_ct,
      status: "pending",
      expires_at: new Date(now + 5 * 60_000).toISOString(),
    });
    expect(error).toBeNull();
    await waitFor(() => !!client.live.approval(aid));
    expect(client.live.approval(aid)).toMatchObject({ verified: true, detailsHash, details });

    await client.actions.decide(aid, true);
    let decision: unknown;
    await waitFor(async () => {
      const { data } = await agentDb.from("approval_decisions").select("decision, signer_device_id").eq("aid", aid);
      decision = data?.[0]?.decision;
      return !!decision;
    });
    const trust = new TrustedClientList(agent.deviceId);
    await trust.addConfirmed(
      { deviceId: browser.deviceId, pubSign: browser.pubSign, pubBox: browser.pubBox },
      Date.now(),
    );
    const check = await trust.verifyDecision(
      decision as Parameters<TrustedClientList["verifyDecision"]>[0],
      { aid, requestId: `r-${run}` },
      Date.now(),
      new MemoryNonceStore(),
    );
    expect(check).toEqual({ ok: true, signerDeviceId: browser.deviceId });
  });

  it("sends a signed command whose prompt only the agent (and this device) can open", async () => {
    const cid = await client.actions.prompt(`s-${run}`, "y ahora los tests");
    const { data, error } = await agentDb.from("commands").select("env").eq("id", cid).single();
    expect(error).toBeNull();
    const env = data!.env as { body: CommandBody };
    const p = env.body.payload as Extract<CommandPayload, { type: "session.prompt" }>;
    expect(await openJson(p.promptCt, agent.deviceId, agent.box, `command:${cid}`)).toBe("y ahora los tests");
  });
});
