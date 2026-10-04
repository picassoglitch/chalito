// Load-test harness (M15): simulated devices with listener churn, plus room fan-out, against
// Supabase Realtime with supabase-js. docs/LOAD_TEST.md has the scenarios and how to read results.
//
//   Local stack (CI, `supabase start`), the default, small scale:
//     node supabase/scripts/load-test.mjs
//   Knobs (env): OWNERS (25 → 50 devices: an agent and a phone each), FAMILY_ROOMS (2, 5 members),
//   OFFICE_ROOMS (1, 20 members), COMMANDS (5 per agent), ROOM_POSTS (5 per room), CHURN (0.2),
//   P95_LIMIT_MS (2000), LOADTEST_OUT (a JSON results file).
//
//   A real dev project (the 1k-device run) costs money and is an owner-approved item. It needs
//   LOADTEST_TARGET=remote, CHALITO_LOADTEST_APPROVED=yes, and LOADTEST_API_URL, LOADTEST_DB_URL,
//   LOADTEST_ANON_KEY and LOADTEST_SERVICE_ROLE_KEY for that project. It refuses anything else.
//
// Devices are real GoTrue users (app_metadata.chalito), signed in the way the apps do (magic-link
// token_hash → verifyOtp), so Realtime authorizes genuine sessions. Phones send commands through
// the Data API (RLS + per-device rate buckets apply), the server posts room events as
// chalito_server through chalito_private.room_post (as the api does). Fixtures are removed at the end.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

const num = (name, dflt) => {
  const v = Number(process.env[name] ?? dflt);
  if (!Number.isFinite(v) || v < 0) throw new Error(`${name} must be a non-negative number`);
  return v;
};
const OWNERS = num("OWNERS", 25);
const FAMILY_ROOMS = num("FAMILY_ROOMS", 2);
const OFFICE_ROOMS = num("OFFICE_ROOMS", 1);
const FAMILY_SIZE = num("FAMILY_SIZE", 5);
const OFFICE_SIZE = num("OFFICE_SIZE", 20);
const COMMANDS = num("COMMANDS", 5);
const ROOM_POSTS = num("ROOM_POSTS", 5);
const CHURN = num("CHURN", 0.2);
const P95_LIMIT_MS = num("P95_LIMIT_MS", 2000);
const DELIVERY_WAIT_MS = num("DELIVERY_WAIT_MS", 10_000);
// The per-device bucket on chalito.commands is 30 with 1/s refill (migration 000800): stay under it.
const COMMAND_GAP_MS = num("COMMAND_GAP_MS", 1100);
const CONCURRENCY = num("CONCURRENCY", 10);

const log = (...parts) => process.stdout.write(`${parts.join(" ")}\n`);
const fail = (msg) => {
  process.stderr.write(`load-test: FAIL ${msg}\n`);
  process.exitCode = 1;
  throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred, ms) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
};
/** Runs `fn` over `items`, at most `n` at a time. */
const pool = async (items, n, fn) => {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
};
const percentiles = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const p = (q) => (s.length ? s[Math.min(s.length - 1, Math.ceil((q / 100) * s.length) - 1)] : NaN);
  return { n: s.length, p50: p(50), p95: p(95), p99: p(99), max: s.at(-1) ?? NaN };
};
const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Number.isFinite(v) ? Math.round(v) : v]));

// ---------------------------------------------------------------- target
const target = () => {
  if ((process.env.LOADTEST_TARGET ?? "local") === "remote") {
    if (process.env.CHALITO_LOADTEST_APPROVED !== "yes")
      fail("a remote run costs money: it needs the owner's approval (CHALITO_LOADTEST_APPROVED=yes)");
    const t = {
      API_URL: process.env.LOADTEST_API_URL,
      DB_URL: process.env.LOADTEST_DB_URL,
      ANON_KEY: process.env.LOADTEST_ANON_KEY,
      SERVICE_ROLE_KEY: process.env.LOADTEST_SERVICE_ROLE_KEY,
    };
    for (const [k, v] of Object.entries(t)) if (!v) fail(`LOADTEST_${k} is required for a remote run`);
    return t;
  }
  const env = Object.fromEntries(
    execFileSync("supabase", ["status", "-o", "env"], { encoding: "utf8" })
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]),
  );
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(env.API_URL ?? "")) fail(`local stack only, got ${env.API_URL}`);
  return env;
};
const env = target();

const opts = { db: { schema: "chalito" }, auth: { persistSession: false, autoRefreshToken: false } };
const db = postgres(env.DB_URL, { max: 4, onnotice: () => {} });
const gotrue = createClient(env.API_URL, env.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const authIds = [];
const server = (fn) =>
  db.begin(async (tx) => {
    await tx`set local role chalito_server`;
    return fn(tx);
  });

const run = Date.now().toString(36);
/** 26 base32 characters ([a-z2-7]) from a string, as companion ids need: distinct strings stay distinct. */
const b32 = (str) => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bits = [...Buffer.from(str)].map((b) => b.toString(2).padStart(8, "0")).join("");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  if (out.length > 26) throw new Error(`id source too long: ${str}`);
  return out.padEnd(26, "a");
};
const email = (id) => `${id}@devices.chalito.invalid`;
const createDeviceUser = async (id, chalito) => {
  const { data, error } = await gotrue.auth.admin.createUser({
    email: email(id),
    email_confirm: true,
    app_metadata: { provider: "chalito", chalito },
  });
  if (error || !data.user) fail(`createUser ${id}: ${error?.message ?? "no user"}`);
  authIds.push(data.user.id);
  return data.user.id;
};
const sessionToken = async (id) => {
  const link = await gotrue.auth.admin.generateLink({ type: "magiclink", email: email(id) });
  if (link.error) fail(`generateLink ${id}: ${link.error.message}`);
  const anon = createClient(env.API_URL, env.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await anon.auth.verifyOtp({
    token_hash: link.data.properties.hashed_token,
    type: "magiclink",
  });
  if (error || !data.session) fail(`verifyOtp ${id}: ${error?.message ?? "no session"}`);
  return data.session.access_token;
};
const deviceClient = (token) => createClient(env.API_URL, env.ANON_KEY, { ...opts, accessToken: async () => token });
/** Joins a private topic, recording every broadcast with its arrival time. */
const join = async (client, topic) => {
  await client.realtime.setAuth();
  const inbox = [];
  let status = "PENDING";
  const t0 = performance.now();
  const channel = client
    .channel(topic, { config: { private: true } })
    .on("broadcast", { event: "*" }, (msg) => inbox.push({ at: performance.now(), msg }))
    .subscribe((s) => {
      status = s;
    });
  await waitFor(() => status !== "PENDING" && status !== "CLOSED", 15_000);
  return { channel, inbox, status: () => status, joinMs: performance.now() - t0 };
};

const results = {
  config: { OWNERS, FAMILY_ROOMS, OFFICE_ROOMS, FAMILY_SIZE, OFFICE_SIZE, COMMANDS, ROOM_POSTS, CHURN },
};
const cleanup = async () => {
  await pool(authIds, CONCURRENCY, (id) => gotrue.auth.admin.deleteUser(id).catch(() => undefined));
  await db`delete from chalito.tenants where id like ${`lt${run}%`}`.catch(() => undefined);
  await db.end();
};

try {
  // ---------------------------------------------------------------- fixtures
  const t0 = performance.now();
  const owners = Array.from({ length: OWNERS }, (_, i) => ({
    uid: `lt${run}u${i}`,
    agent: `lt${run}a${i}`,
    phone: `lt${run}p${i}`,
    companion: `chl_${b32(`${run}x${i}`)}`,
  }));
  await pool(owners, CONCURRENCY, async (o) => {
    o.agentSub = await createDeviceUser(o.agent, { owner: o.uid, device_id: o.agent, role: "agent" });
    o.phoneSub = await createDeviceUser(o.phone, { owner: o.uid, device_id: o.phone, role: "client" });
  });
  const dev = (o, id, role, sub) => ({
    owner: o.uid,
    device_id: id,
    role,
    kind: role === "agent" ? "desktop" : "phone",
    platform: role === "agent" ? "linux" : "ios",
    name: id.slice(0, 40),
    pub_sign: "p",
    pub_box: "p",
    fingerprint: "f",
    enrolled_via: role === "agent" ? "pairing" : "first_client",
    auth_user_id: sub,
  });
  const rooms = [
    ...Array.from({ length: FAMILY_ROOMS }, (_, i) => ({ id: `lt${run}rf${i}`, type: "family", size: FAMILY_SIZE })),
    ...Array.from({ length: OFFICE_ROOMS }, (_, i) => ({ id: `lt${run}ro${i}`, type: "business", size: OFFICE_SIZE })),
  ];
  for (const [k, r] of rooms.entries()) {
    if (r.size > OWNERS) fail(`a ${r.type} room of ${r.size} needs at least ${r.size} owners`);
    r.members = Array.from({ length: r.size }, (_, j) => owners[(k * 7 + j) % OWNERS]);
  }
  await server(async (tx) => {
    await tx`insert into chalito.tenants ${tx(owners.map((o) => ({ id: o.uid })))}`;
    await tx`insert into chalito.users ${tx(owners.map((o) => ({ id: o.uid, tenant_id: o.uid })))}`;
    await tx`insert into chalito.devices ${tx(owners.flatMap((o) => [dev(o, o.agent, "agent", o.agentSub), dev(o, o.phone, "client", o.phoneSub)]))}`;
    await tx`insert into chalito.companions ${tx(owners.map((o) => ({ owner: o.uid, companion_id: o.companion, name: "Chalito" })))}`;
    for (const r of rooms) {
      const [first, ...rest] = r.members;
      await tx`insert into chalito.rooms (room_id, type, name, owner_uid, owner_companion_id, ephemeral_ttl)
               values (${r.id}, ${r.type}, ${"load " + r.type}, ${first.uid}, ${first.companion}, 'PT1H')`;
      await tx`insert into chalito.room_members ${tx(
        [first, ...rest].map((m, j) => ({
          room_id: r.id,
          companion_id: m.companion,
          uid: m.uid,
          role: j ? "member" : "owner",
        })),
      )}`;
    }
  });
  await pool(owners, CONCURRENCY, async (o) => {
    o.agentClient = deviceClient(await sessionToken(o.agent));
    o.phoneClient = deviceClient(await sessionToken(o.phone));
  });
  results.setupMs = Math.round(performance.now() - t0);
  log(`fixtures: ${OWNERS * 2} devices, ${rooms.length} rooms in ${results.setupMs} ms`);

  // ---------------------------------------------------------------- subscribe
  await pool(owners, CONCURRENCY, async (o) => {
    o.agentCh = await join(o.agentClient, `chalito:device:${o.agent}`);
    if (o.agentCh.status() !== "SUBSCRIBED") fail(`agent ${o.agent} could not join (${o.agentCh.status()})`);
  });
  const memberships = rooms.flatMap((r) => r.members.map((m) => ({ r, m })));
  await pool(memberships, CONCURRENCY, async (x) => {
    x.ch = await join(x.m.phoneClient, `chalito:room:${x.r.id}`);
    if (x.ch.status() !== "SUBSCRIBED") fail(`phone ${x.m.phone} could not join room ${x.r.id} (${x.ch.status()})`);
  });
  results.join = round(percentiles([...owners.map((o) => o.agentCh.joinMs), ...memberships.map((x) => x.ch.joinMs)]));
  log(`joins: ${JSON.stringify(results.join)}`);

  // ---------------------------------------------------------------- 1. commands with listener churn
  // Churning agents leave and rejoin while the stable ones receive commands; Realtime has no replay
  // (clients resync by rev), so only stable agents count toward delivery and latency.
  const churning = owners.slice(0, Math.round(OWNERS * CHURN));
  const stable = owners.slice(churning.length);
  let churnOn = true;
  const rejoinMs = [];
  const churner = (async () => {
    while (churnOn && churning.length) {
      await pool(churning, CONCURRENCY, async (o) => {
        await o.agentClient.removeChannel(o.agentCh.channel);
        o.agentCh = await join(o.agentClient, `chalito:device:${o.agent}`);
        if (o.agentCh.status() === "SUBSCRIBED") rejoinMs.push(o.agentCh.joinMs);
      });
      await sleep(500);
    }
  })();
  const sent = [];
  await pool(stable, CONCURRENCY * 2, async (o) => {
    for (let i = 0; i < COMMANDS; i++) {
      const id = `${o.agent}c${i}`;
      const at = performance.now();
      const res = await o.phoneClient.from("commands").insert({
        owner: o.uid,
        target_device_id: o.agent,
        id,
        env: { ctx: "chalito.command.v1" },
        from_device_id: o.phone,
      });
      if (res.error) fail(`command ${id}: ${res.error.message}`);
      sent.push({ o, id, at });
      await sleep(COMMAND_GAP_MS);
    }
  });
  const got = (s) =>
    s.o.agentCh.inbox.find((m) => m.msg.payload?.table === "commands" && m.msg.payload?.key?.id === s.id);
  await waitFor(() => sent.every(got), DELIVERY_WAIT_MS);
  churnOn = false;
  await churner;
  const delivered = sent.filter(got);
  results.commands = {
    ...round(percentiles(delivered.map((s) => got(s).at - s.at))),
    sent: sent.length,
    delivered: delivered.length,
    churningAgents: churning.length,
    rejoin: round(percentiles(rejoinMs)),
  };
  log(`commands: ${JSON.stringify(results.commands)}`);

  // ---------------------------------------------------------------- 2. room fan-out
  const posts = [];
  for (const r of rooms)
    for (let i = 0; i < ROOM_POSTS; i++) {
      const from = r.members[i % r.members.length];
      const eid = `${r.id}e${i}`;
      const at = performance.now();
      await server(
        (
          tx,
        ) => tx`select chalito_private.room_post(${from.uid}, ${from.companion}, ${r.id}, ${eid}, ${[]}::text[], 'notice', 'low',
                   ${tx.json({ alg: "xchacha20poly1305", epoch: 1, n: "x", ct: "x" })}, 1)`,
      );
      posts.push({ r, eid, at });
    }
  const roomInbox = (x, eid) =>
    x.ch.inbox.find((m) => m.msg.payload?.table === "room_events" && m.msg.payload?.key?.eid === eid);
  const expected = posts.flatMap((p) => memberships.filter((x) => x.r === p.r).map((x) => ({ p, x })));
  await waitFor(() => expected.every((e) => roomInbox(e.x, e.p.eid)), DELIVERY_WAIT_MS);
  const fan = expected.filter((e) => roomInbox(e.x, e.p.eid));
  results.rooms = {
    ...round(percentiles(fan.map((e) => roomInbox(e.x, e.p.eid).at - e.p.at))),
    expected: expected.length,
    delivered: fan.length,
    family: round(
      percentiles(fan.filter((e) => e.p.r.type === "family").map((e) => roomInbox(e.x, e.p.eid).at - e.p.at)),
    ),
    office: round(
      percentiles(fan.filter((e) => e.p.r.type === "business").map((e) => roomInbox(e.x, e.p.eid).at - e.p.at)),
    ),
  };
  log(`rooms: ${JSON.stringify(results.rooms)}`);

  // ---------------------------------------------------------------- 3. isolation under load
  const leaks = owners.flatMap((o) =>
    o.agentCh.inbox.filter(
      (m) => m.msg.payload?.table === "commands" && !String(m.msg.payload?.key?.id ?? "").startsWith(o.agent),
    ),
  );
  const roomLeaks = memberships.flatMap((x) =>
    x.ch.inbox.filter(
      (m) => m.msg.payload?.table === "room_events" && !String(m.msg.payload?.key?.eid ?? "").startsWith(x.r.id),
    ),
  );
  results.leaks = leaks.length + roomLeaks.length;

  if (results.commands.delivered !== results.commands.sent)
    fail(`${results.commands.sent - results.commands.delivered} command(s) never reached a stable agent`);
  if (results.rooms.delivered !== results.rooms.expected)
    fail(`${results.rooms.expected - results.rooms.delivered} room delivery(ies) missing`);
  if (results.leaks) fail(`${results.leaks} message(s) reached the wrong device or room`);
  if (results.commands.p95 >= P95_LIMIT_MS) fail(`command p95 ${results.commands.p95} ms ≥ ${P95_LIMIT_MS} ms`);
  if (results.rooms.p95 >= P95_LIMIT_MS) fail(`room fan-out p95 ${results.rooms.p95} ms ≥ ${P95_LIMIT_MS} ms`);
  log(`load-test: ok ${JSON.stringify({ commandsP95: results.commands.p95, roomsP95: results.rooms.p95 })}`);

  for (const o of owners) {
    await o.agentClient.removeAllChannels();
    await o.phoneClient.removeAllChannels();
  }
} catch (err) {
  if (!process.exitCode) {
    process.stderr.write(`load-test: ERROR ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
} finally {
  if (process.env.LOADTEST_OUT) writeFileSync(process.env.LOADTEST_OUT, `${JSON.stringify(results, null, 2)}\n`);
  await cleanup();
  process.exit(process.exitCode ?? 0);
}
