// Realtime delivery check against the LOCAL stack only (`supabase start`), with supabase-js.
//
//   1. latency: an agent subscribed to its private `device:<id>` channel receives the pointer for a
//      command a phone inserts through the Data API in under 2 s (20 runs; p50/p95/max reported);
//   2. isolation: another owner's device never receives it, and can't join the agent's topic;
//   3. pairing: a pairing-watch token receives on `pairing:<code>` when the code is claimed;
//   4. revocation: once the agent is revoked and its token is refreshed, nothing reaches it,
//      neither database broadcasts nor direct REST broadcasts to its topic.
//
// Devices are real Supabase Auth users of the local stack (Option C): created through the GoTrue
// admin API with app_metadata.chalito, signed in the way the apps do it (magic-link token_hash →
// verifyOtp), so Realtime sees genuine GoTrue sessions. Server writes go through Postgres as
// chalito_server, as the API does; the service key is used only for GoTrue admin and REST
// broadcasts. Needs Node >= 22.
// Run: npm install --no-save --prefix supabase/scripts @supabase/supabase-js@2.117.2 postgres@3.4.9
//      node supabase/scripts/realtime-latency.mjs
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

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

const opts = { db: { schema: "chalito" }, auth: { persistSession: false, autoRefreshToken: false } };
// REST broadcasts (the revocation probe) only; the hub's service_role has no access to chalito tables.
const admin = createClient(env.API_URL, env.SERVICE_ROLE_KEY, opts);
const db = postgres(env.DB_URL, { max: 1, onnotice: () => {} });
const gotrue = createClient(env.API_URL, env.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const authIds = [];
/** A device (or pairing watcher) as a GoTrue user; app_metadata is server-set only. */
const createAuthUser = async (email, chalito) => {
  const { data, error } = await gotrue.auth.admin.createUser({
    email,
    email_confirm: true,
    app_metadata: { provider: "chalito", chalito },
  });
  if (error || !data.user) fail(`createUser ${email}: ${error?.message ?? "no user"}`);
  authIds.push(data.user.id);
  return data.user.id;
};
/** A fresh session for that user: magic-link token_hash → verifyOtp (what the API hands devices). */
const sessionToken = async (email) => {
  const link = await gotrue.auth.admin.generateLink({ type: "magiclink", email });
  if (link.error) fail(`generateLink ${email}: ${link.error.message}`);
  const anon = createClient(env.API_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await anon.auth.verifyOtp({
    token_hash: link.data.properties.hashed_token,
    type: "magiclink",
  });
  if (error || !data.session) fail(`verifyOtp ${email}: ${error?.message ?? "no session"}`);
  return data.session.access_token;
};
const deviceEmail = (id) => `${id}@devices.chalito.invalid`;
const watchEmail = (code) => `${code}@pairing.chalito.invalid`;
/** Runs server-side SQL as chalito_server, as the API does. */
const server = (fn) =>
  db.begin(async (tx) => {
    await tx`set local role chalito_server`;
    return fn(tx);
  });
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
  let reason = "";
  const channel = client
    .channel(topic, { config: { private: true } })
    .on("broadcast", { event: "*" }, (msg) => inbox.push({ at: performance.now(), msg }))
    .subscribe((s, err) => {
      status = s;
      if (err) reason = err.message;
    });
  await waitFor(() => status !== "PENDING" && status !== "CLOSED", 10_000);
  return { channel, inbox, status: () => (reason ? `${status}: ${reason}` : status) };
};
/**
 * When a join is refused: evaluate, as `authenticated` with the token's real claims, every
 * predicate the realtime.messages policies use, so the log says which one failed.
 */
const diagnose = async (token, topic) => {
  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  const code = topic.startsWith("chalito:pairing:") ? topic.slice("chalito:pairing:".length) : null;
  const [row] = code
    ? await db`select code_id, expires_at > now() as live, claimed, watch_auth_user_id::text as watch_user
               from chalito.pairing_codes where code_id = ${code}`
    : [null];
  const [checks] = await db.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true),
                    set_config('realtime.topic', ${topic}, true)`;
    await tx`set local role authenticated`;
    return tx`select chalito.jwt_claims() as claims, chalito.jwt_role() as role,
                     chalito.jwt_device_id() as device_id, chalito.jwt_pairing_code() as pairing_code,
                     chalito_private.device_ok() as device_ok,
                     chalito_private.pairing_watch_ok(chalito.jwt_pairing_code()) as pairing_watch_ok,
                     chalito_private.realtime_topic_ok(${topic}) as topic_ok, realtime.topic() as realtime_topic`;
  });
  log(
    `diagnose ${topic}: token=${JSON.stringify({ sub: claims.sub, aud: claims.aud, role: claims.role, app_metadata: claims.app_metadata })}`,
  );
  log(`diagnose ${topic}: row=${JSON.stringify(row)} checks=${JSON.stringify(checks)}`);
  log(`diagnose ${topic}: probes=${JSON.stringify(await realtimeProbes(claims, topic))}`);
};

/**
 * Realtime's own join check, replicated: in one transaction (rolled back) the admin connection
 * inserts a broadcast and a presence message for the topic, then switches to the token's role,
 * claims and topic and reads them back through RLS (can_read), and tries an insert as the user
 * (can_write). Each probe runs in a savepoint so one error doesn't hide the others.
 */
const realtimeProbes = async (claims, topic) => {
  const out = {};
  await db
    .begin(async (tx) => {
      await tx`insert into realtime.messages (topic, extension, payload, event, private)
               values (${topic}, 'broadcast', '{}', 'probe', true), (${topic}, 'presence', '{}', 'probe', true)`;
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true),
                      set_config('realtime.topic', ${topic}, true),
                      set_config('request.jwt.claim.sub', ${claims.sub ?? ""}, true),
                      set_config('request.jwt.claim.role', ${claims.role ?? ""}, true)`;
      await tx`set local role authenticated`;
      const probe = async (name, fn) => {
        try {
          out[name] = await tx.savepoint(fn);
        } catch (err) {
          out[name] = `error: ${err.message}`;
        }
      };
      await probe(
        "read_broadcast",
        async (sp) =>
          (
            await sp`select count(*)::int as n from realtime.messages where topic = realtime.topic() and extension = 'broadcast'`
          )[0].n,
      );
      await probe(
        "read_presence",
        async (sp) =>
          (
            await sp`select count(*)::int as n from realtime.messages where topic = realtime.topic() and extension = 'presence'`
          )[0].n,
      );
      await probe(
        "read_any",
        async (sp) =>
          (
            await sp`select count(*)::int as n from realtime.messages where topic = realtime.topic()
                  and extension in ('broadcast', 'presence')`
          )[0].n,
      );
      await probe("write_broadcast", async (sp) => {
        await sp`insert into realtime.messages (topic, extension, payload, event, private)
                 values (realtime.topic(), 'broadcast', '{}', 'probe', true)`;
        return "allowed";
      });
      throw Object.assign(new Error("rollback"), { rollback: true });
    })
    .catch((err) => {
      if (!err.rollback) out.setup_error = err.message;
    });
  return out;
};
const must = (res, what) => {
  if (res.error) fail(`${what}: ${res.error.message}`);
  return res;
};

// ---------------------------------------------------------------- fixtures (chalito_server)
const run = Date.now().toString(36);
const U1 = `rtu1${run}`;
const U2 = `rtu2${run}`;
const AGENT = `rtagent${run}`;
const PHONE = `rtphone${run}`;
const XAGENT = `rtxagent${run}`;
const CODE = `rtcode${run}`;
// Each device (and the pairing watcher) is its own auth user.
const agentClaims = { owner: U1, device_id: AGENT, role: "agent" };
const SUB = {
  [AGENT]: await createAuthUser(deviceEmail(AGENT), agentClaims),
  [PHONE]: await createAuthUser(deviceEmail(PHONE), { owner: U1, device_id: PHONE, role: "client" }),
  [XAGENT]: await createAuthUser(deviceEmail(XAGENT), { owner: U2, device_id: XAGENT, role: "agent" }),
  watch: await createAuthUser(watchEmail(CODE), { role: "pairing", pairing_code: CODE }),
};
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
  auth_user_id: SUB[device_id],
});
await server(async (tx) => {
  await tx`insert into chalito.tenants ${tx([{ id: U1 }, { id: U2 }])}`;
  await tx`insert into chalito.users ${tx([
    { id: U1, tenant_id: U1 },
    { id: U2, tenant_id: U2 },
  ])}`;
  await tx`insert into chalito.devices ${tx([device(U1, AGENT, "agent"), device(U1, PHONE, "client"), device(U2, XAGENT, "agent")])}`;
  await tx`insert into chalito.pairing_codes ${tx({
    code_id: CODE,
    short_code_hash: "e".repeat(64),
    glyph: {},
    agent_device_id: `rtnew${run}`,
    kind: "desktop",
    platform: "linux",
    expires_at: new Date(Date.now() + 5 * 60_000),
    watch_auth_user_id: SUB.watch,
  })}`;
});

const agent = deviceClient(await sessionToken(deviceEmail(AGENT)));
const phone = deviceClient(await sessionToken(deviceEmail(PHONE)));
const other = deviceClient(await sessionToken(deviceEmail(XAGENT)));

const agentCh = await join(agent.client, `chalito:device:${AGENT}`);
if (agentCh.status() !== "SUBSCRIBED") {
  await diagnose(agent.holder.token, `chalito:device:${AGENT}`);
  fail(`agent could not join its own topic (${agentCh.status()})`);
}
log(
  `probes for the device topic (joined OK): ${JSON.stringify(
    await realtimeProbes(
      JSON.parse(Buffer.from(agent.holder.token.split(".")[1], "base64url").toString("utf8")),
      `chalito:device:${AGENT}`,
    ),
  )}`,
);
const otherOwn = await join(other.client, `chalito:device:${XAGENT}`);
if (otherOwn.status() !== "SUBSCRIBED") fail(`other owner's agent could not join its own topic (${otherOwn.status()})`);
const otherSpy = await join(other.client, `chalito:device:${AGENT}`);
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
const watch = deviceClient(await sessionToken(watchEmail(CODE)));
const watchCh = await join(watch.client, `chalito:pairing:${CODE}`);
if (watchCh.status() !== "SUBSCRIBED") {
  await diagnose(watch.holder.token, `chalito:pairing:${CODE}`);
  fail(`pairing watcher could not join chalito:pairing:${CODE} (${watchCh.status()})`);
}
const watchSpy = await join(watch.client, `chalito:device:${AGENT}`);
if (watchSpy.status() === "SUBSCRIBED") fail("a pairing token joined a device topic");
const tClaim = performance.now();
await server((tx) => tx`update chalito.pairing_codes set claimed = true, owner = ${U1} where code_id = ${CODE}`);
const claimed = () => watchCh.inbox.find((m) => m.msg.payload?.table === "pairing_codes");
if (!(await waitFor(claimed, LIMIT_MS))) fail("pairing watcher was not told its code was claimed");
log(`pairing: watcher told in ${(claimed().at - tClaim).toFixed(1)} ms`);

// ---------------------------------------------------------------- 4. revocation
// Control first: a direct REST broadcast to the agent's topic does reach it while it is active,
// so the negative check below can't pass vacuously.
const probe = async (n) => {
  const ch = admin.channel(`chalito:device:${AGENT}`, { config: { private: true } });
  const res = await ch.httpSend("probe", { probe: n });
  await admin.removeChannel(ch);
  if (!res.success) fail(`REST broadcast failed: ${res.status} ${res.error}`);
};
const probed = (n) => () => agentCh.inbox.find((m) => m.msg.event === "probe" && m.msg.payload?.probe === n);
await probe(1);
if (!(await waitFor(probed(1), LIMIT_MS))) fail("control: an active agent did not receive a REST broadcast");

await server((tx) => tx`update chalito.devices set revoked = true, revoked_at = now() where device_id = ${AGENT}`);
// The agent's next token refresh (a fresh session for the same auth user) re-runs join authorization.
agent.holder.token = await sessionToken(deviceEmail(AGENT));
await agent.client.realtime.setAuth();
await sleep(1000);
const before = agentCh.inbox.length;
await probe(2);
await server(
  (tx) => tx`insert into chalito.notifications (owner, nid, level, source, urgency, counts, deep_link, coalesce_key)
             values (${U1}, ${"rtn" + run}, 'L1', 'approval', 'normal', '{}', '/', 'rt')`,
);
await sleep(3000);
const after = agentCh.inbox.slice(before);
if (after.length) fail(`a revoked agent still received ${after.length} message(s) after its token refresh`);
log(`revocation: nothing reached the agent after revoke + refresh (channel ${agentCh.status()})`);

for (const c of [agent, phone, other, watch]) await c.client.removeAllChannels();
log(`realtime: ok ${JSON.stringify(Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Math.round(v)])))}`);
for (const id of authIds) await gotrue.auth.admin.deleteUser(id).catch(() => undefined);
await db.end();
process.exit(0);
