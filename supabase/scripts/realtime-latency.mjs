// Realtime delivery check against the LOCAL stack only (`supabase start`), with supabase-js.
//
//   1. latency: an agent subscribed to its private `device:<id>` channel receives the pointer for a
//      command a phone inserts through the Data API in under 2 s (20 runs; p50/p95/max reported);
//   2. isolation: another owner's device never receives it, and can't join the agent's topic;
//   3. pairing: a pairing-watch token receives on `pairing:<code>` when the code is claimed;
//   4. revocation: once the agent is revoked and its token is refreshed, nothing reaches it,
//      neither database broadcasts nor direct REST broadcasts to its topic.
//
// Tokens come from `supabase gen bearer-jwt` (the local stack's signing key). Needs Node >= 22.
// Run: npm install --no-save --prefix supabase/scripts @supabase/supabase-js@2.117.2
//      node supabase/scripts/realtime-latency.mjs
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createClient } from "@supabase/supabase-js";

const LIMIT_MS = 2000;
const RUNS = 20;

const log = (...parts) => process.stdout.write(`${parts.join(" ")}\n`);
const fail = (msg) => {
  process.stderr.write(`realtime: FAIL ${msg}\n`);
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(5);
  }
  return pred();
};

const env = Object.fromEntries(
  execFileSync("supabase", ["status", "-o", "env"], { encoding: "utf8" })
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]),
);
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(env.API_URL ?? "")) fail(`local stack only, got ${env.API_URL}`);

const mint = (sub, claims) =>
  execFileSync(
    "supabase",
    [
      "gen",
      "bearer-jwt",
      "--role",
      "authenticated",
      "--sub",
      sub,
      "--valid-for",
      "5m",
      "--payload",
      JSON.stringify({ iss: "chalito", aud: "authenticated", ...claims }),
    ],
    { encoding: "utf8" },
  ).trim();

const opts = { db: { schema: "chalito" }, auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(env.API_URL, env.SERVICE_ROLE_KEY, opts);
/** A client whose token can be swapped, as the agent's 5-minute refresh does. */
const deviceClient = (token) => {
  const holder = { token };
  const client = createClient(env.API_URL, env.ANON_KEY, { ...opts, accessToken: async () => holder.token });
  return { client, holder };
};
/** Joins a private topic and records every broadcast on it. */
const join = async (client, topic) => {
  const inbox = [];
  let status = "PENDING";
  const channel = client
    .channel(topic, { config: { private: true } })
    .on("broadcast", { event: "*" }, (msg) => inbox.push({ at: performance.now(), msg }))
    .subscribe((s) => (status = s));
  await waitFor(() => status !== "PENDING" && status !== "CLOSED", 10_000);
  return { channel, inbox, status: () => status };
};
const must = (res, what) => {
  if (res.error) fail(`${what}: ${res.error.message}`);
  return res;
};

// ---------------------------------------------------------------- fixtures (service_role)
const run = Date.now().toString(36);
const U1 = `rtu1${run}`;
const U2 = `rtu2${run}`;
const AGENT = `rtagent${run}`;
const PHONE = `rtphone${run}`;
const XAGENT = `rtxagent${run}`;
const CODE = `rtcode${run}`;
const device = (owner, device_id, role) => ({
  owner,
  device_id,
  role,
  kind: role === "agent" ? "desktop" : "phone",
  platform: role === "agent" ? "linux" : "ios",
  name: device_id.slice(0, 40),
  pub_sign: "p",
  pub_box: "p",
  fingerprint: "f",
  enrolled_via: role === "agent" ? "pairing" : "first_client",
});
must(await admin.from("tenants").insert([{ id: U1 }, { id: U2 }]), "seed tenants");
must(
  await admin.from("users").insert([
    { id: U1, tenant_id: U1 },
    { id: U2, tenant_id: U2 },
  ]),
  "seed users",
);
must(
  await admin
    .from("devices")
    .insert([device(U1, AGENT, "agent"), device(U1, PHONE, "client"), device(U2, XAGENT, "agent")]),
  "seed devices",
);
must(
  await admin.from("pairing_codes").insert({
    code_id: CODE,
    short_code_hash: "e".repeat(64),
    glyph: {},
    agent_device_id: `rtnew${run}`,
    kind: "desktop",
    platform: "linux",
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  }),
  "seed pairing code",
);

const agentClaims = { owner: U1, device_id: AGENT, chalito_role: "agent" };
const agent = deviceClient(mint(U1, agentClaims));
const phone = deviceClient(mint(U1, { owner: U1, device_id: PHONE, chalito_role: "client" }));
const other = deviceClient(mint(U2, { owner: U2, device_id: XAGENT, chalito_role: "agent" }));

const agentCh = await join(agent.client, `device:${AGENT}`);
if (agentCh.status() !== "SUBSCRIBED") fail(`agent could not join its own topic (${agentCh.status()})`);
const otherOwn = await join(other.client, `device:${XAGENT}`);
if (otherOwn.status() !== "SUBSCRIBED") fail(`other owner's agent could not join its own topic (${otherOwn.status()})`);
const otherSpy = await join(other.client, `device:${AGENT}`);
log(`isolation: another owner joining device:${AGENT} -> ${otherSpy.status()}`);

// ---------------------------------------------------------------- 1. latency
const latencies = [];
for (let i = 0; i < RUNS; i++) {
  const id = `cmd${i}`;
  const t0 = performance.now();
  must(
    await phone.client.from("commands").insert({
      owner: U1,
      target_device_id: AGENT,
      id,
      env: { ctx: "chalito.command.v1" },
      from_device_id: PHONE,
    }),
    `phone insert ${id}`,
  );
  const got = () => agentCh.inbox.find((m) => m.msg.payload?.table === "commands" && m.msg.payload?.key?.id === id);
  if (!(await waitFor(got, LIMIT_MS + 1000))) fail(`agent never received ${id}`);
  latencies.push(got().at - t0);
}
const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const stats = { runs: RUNS, p50: pct(50), p95: pct(95), max: sorted.at(-1) };
log(
  `latency: p50 ${stats.p50.toFixed(1)} ms, p95 ${stats.p95.toFixed(1)} ms, max ${stats.max.toFixed(1)} ms over ${RUNS} runs`,
);
if (stats.max >= LIMIT_MS) fail(`a command took ${stats.max.toFixed(0)} ms (limit ${LIMIT_MS} ms)`);

// ---------------------------------------------------------------- 2. isolation
const leaked = [...otherOwn.inbox, ...otherSpy.inbox].filter((m) => m.msg.payload?.table === "commands");
if (leaked.length) fail(`another owner's device received ${leaked.length} command pointer(s)`);
if (otherSpy.status() === "SUBSCRIBED") fail(`another owner joined device:${AGENT}`);
log("isolation: another owner's device received nothing");

// ---------------------------------------------------------------- 3. pairing topic
const watch = deviceClient(mint(`p_${CODE}`, { owner: "pairing", chalito_role: "pairing", pairing_code: CODE }));
const watchCh = await join(watch.client, `pairing:${CODE}`);
if (watchCh.status() !== "SUBSCRIBED") fail(`pairing watcher could not join pairing:${CODE} (${watchCh.status()})`);
const watchSpy = await join(watch.client, `device:${AGENT}`);
if (watchSpy.status() === "SUBSCRIBED") fail("a pairing token joined a device topic");
const tClaim = performance.now();
must(await admin.from("pairing_codes").update({ claimed: true, owner: U1 }).eq("code_id", CODE), "claim code");
const claimed = () => watchCh.inbox.find((m) => m.msg.payload?.table === "pairing_codes");
if (!(await waitFor(claimed, LIMIT_MS))) fail("pairing watcher was not told its code was claimed");
log(`pairing: watcher told in ${(claimed().at - tClaim).toFixed(1)} ms`);

// ---------------------------------------------------------------- 4. revocation
// Control first: a direct REST broadcast to the agent's topic does reach it while it is active,
// so the negative check below can't pass vacuously.
const probe = async (n) => {
  const ch = admin.channel(`device:${AGENT}`, { config: { private: true } });
  const res = await ch.httpSend("probe", { probe: n });
  await admin.removeChannel(ch);
  if (!res.success) fail(`REST broadcast failed: ${res.status} ${res.error}`);
};
const probed = (n) => () => agentCh.inbox.find((m) => m.msg.event === "probe" && m.msg.payload?.probe === n);
await probe(1);
if (!(await waitFor(probed(1), LIMIT_MS))) fail("control: an active agent did not receive a REST broadcast");

must(
  await admin.from("devices").update({ revoked: true, revoked_at: new Date().toISOString() }).eq("device_id", AGENT),
  "revoke agent",
);
// The agent's next token refresh (same claims, fresh expiry) re-runs join authorization.
agent.holder.token = mint(U1, agentClaims);
await agent.client.realtime.setAuth();
await sleep(1000);
const before = agentCh.inbox.length;
await probe(2);
must(
  await admin.from("notifications").insert({
    owner: U1,
    nid: `rtn${run}`,
    level: "L1",
    source: "approval",
    urgency: "normal",
    counts: {},
    deep_link: "/",
    coalesce_key: "rt",
  }),
  "notification after revoke",
);
await sleep(3000);
const after = agentCh.inbox.slice(before);
if (after.length) fail(`a revoked agent still received ${after.length} message(s) after its token refresh`);
log(`revocation: nothing reached the agent after revoke + refresh (channel ${agentCh.status()})`);

for (const c of [agent, phone, other, watch]) await c.client.removeAllChannels();
log(`realtime: ok ${JSON.stringify(Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Math.round(v)])))}`);
process.exit(0);
