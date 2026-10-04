import { describe, expect, it } from "vitest";
import { PairingCodeDoc, type AgentEvent, type ApprovalRequest, type CallLine } from "@chalito/protocol";
import {
  SUPABASE_REFRESH_MS,
  apiTokenSource,
  pairingRowToDoc,
  supabaseCloud,
  supabasePairingWatcher,
} from "../src/cloud.js";
import { SupabaseError, SupabaseStore } from "../src/supabase-store.js";
import { FakeSupabase, tick } from "./fake-supabase.js";

const OWNER = "hub-user-1";
const DEV = `dev_${"a".repeat(22)}`;
const T = 1_790_000_000_000;

const setup = () => {
  const db = new FakeSupabase();
  const store = new SupabaseStore(db, OWNER, DEV);
  return { db, store };
};

const command = (db: FakeSupabase, id: string) =>
  db.seed("commands", {
    owner: OWNER,
    target_device_id: DEV,
    id,
    env: { ctx: "chalito.command.v1", body: { cid: id } },
    from_device_id: "dev_phone",
  });

describe("SupabaseStore: realtime (one private channel per device)", () => {
  it("joins chalito:device:<id> privately once, shared by commands and approvals", async () => {
    const { db, store } = setup();
    store.watchCommands(() => undefined);
    store.watchApproval("a1", () => undefined);
    store.watchApproval("a2", () => undefined);
    await tick();
    expect(db.channels).toHaveLength(1);
    expect(db.channels[0]).toMatchObject({ topic: `chalito:device:${DEV}`, opts: { config: { private: true } } });
  });

  it("a command pointer is read back under RLS and delivered once (no content in the broadcast)", async () => {
    const { db, store } = setup();
    const got: [string, Record<string, unknown>][] = [];
    store.watchCommands((id, doc) => got.push([id, doc]));
    await tick();
    command(db, "c1");
    const pointer = { table: "commands", op: "insert", key: { target_device_id: DEV, id: "c1" }, cursor: 1 };
    db.broadcast(`chalito:device:${DEV}`, pointer);
    db.broadcast(`chalito:device:${DEV}`, pointer);
    await tick();
    expect(got).toEqual([
      ["c1", { env: { ctx: "chalito.command.v1", body: { cid: "c1" } }, fromDeviceId: "dev_phone" }],
    ]);
    const read = db.ops.filter((o) => o.table === "commands" && o.op === "select").at(-1)!;
    expect(read.filters).toEqual([
      ["owner", OWNER],
      ["target_device_id", DEV],
      ["id", "c1"],
    ]);
  });

  it("on every (re)SUBSCRIBED, commands that arrived while disconnected are delivered in order", async () => {
    const { db, store } = setup();
    const got: string[] = [];
    store.watchCommands((id) => got.push(id));
    command(db, "early");
    await tick();
    expect(got).toEqual(["early"]);
    // Offline: two commands land, no broadcast reaches us.
    command(db, "c2");
    command(db, "c3");
    db.rejoin(`chalito:device:${DEV}`);
    await tick();
    expect(got).toEqual(["early", "c2", "c3"]);
    // A handled (deleted) command isn't redelivered by the next resync.
    await store.deleteCommand("c2");
    db.rejoin(`chalito:device:${DEV}`);
    await tick();
    expect(got).toEqual(["early", "c2", "c3"]);
    expect(db.rows("commands").map((r) => r.id)).toEqual(["early", "c3"]);
  });

  const decide = (db: FakeSupabase, aid: string, signer: string, decision: unknown) =>
    db.seed("approval_decisions", { owner: OWNER, aid, signer_device_id: signer, decision });
  const pointer = (aid: string, signer: string) => ({
    table: "approval_decisions",
    op: "insert",
    key: { aid, signer_device_id: signer },
  });

  it("decision rows (insert-only, one per signer) reach the watcher once each, in rev order", async () => {
    const { db, store } = setup();
    const got: [string, unknown][] = [];
    store.watchApproval("a1", (d) => got.push(["a1", d]));
    await tick();

    decide(db, "a1", "dev_phone", { sig: "d1" });
    db.broadcast(`chalito:device:${DEV}`, pointer("a1", "dev_phone"));
    db.broadcast(`chalito:device:${DEV}`, pointer("a1", "dev_phone"));
    await tick();
    // A second signer (e.g. the web client): passed on too; the agent verifies and picks the first valid.
    decide(db, "a1", "dev_web", { sig: "d2" });
    db.broadcast(`chalito:device:${DEV}`, pointer("a1", "dev_web"));
    await tick();
    expect(got).toEqual([
      ["a1", { sig: "d1" }],
      ["a1", { sig: "d2" }],
    ]);
    const read = db.ops.filter((o) => o.table === "approval_decisions").at(-1)!;
    expect(read.filters).toEqual([
      ["owner", OWNER],
      ["aid", "a1"],
    ]);
  });

  it("decisions inserted while offline arrive on rejoin via rev > last; unwatching stops delivery", async () => {
    const { db, store } = setup();
    const got: [string, unknown][] = [];
    const stop1 = store.watchApproval("a1", (d) => got.push(["a1", d]));
    store.watchApproval("a2", (d) => got.push(["a2", d]));
    await tick();
    decide(db, "a2", "dev_phone", { sig: "offline" });
    decide(db, "other", "dev_phone", { sig: "not watched" });
    db.rejoin(`chalito:device:${DEV}`);
    await tick();
    expect(got).toEqual([["a2", { sig: "offline" }]]);
    const resync = db.ops.find((o) => o.table === "approval_decisions" && o.filters.length === 1);
    expect(resync?.filters).toEqual([["owner", OWNER]]);

    stop1();
    decide(db, "a1", "dev_phone", { sig: "late" });
    db.broadcast(`chalito:device:${DEV}`, pointer("a1", "dev_phone"));
    await tick();
    expect(got).toHaveLength(1);
  });

  it("a decision row that exists when the watch starts is delivered", async () => {
    const { db, store } = setup();
    decide(db, "a9", "dev_phone", { sig: "early" });
    const got: unknown[] = [];
    store.watchApproval("a9", (d) => got.push(d));
    await tick();
    expect(got).toEqual([{ sig: "early" }]);
  });

  it("command resync asks only for rev above the last one seen", async () => {
    const { db, store } = setup();
    const got: string[] = [];
    store.watchCommands((id) => got.push(id));
    command(db, "c1");
    await tick();
    command(db, "c2");
    db.rejoin(`chalito:device:${DEV}`);
    await tick();
    expect(got).toEqual(["c1", "c2"]);
    const resyncs = db.ops.filter((o) => o.table === "commands" && o.op === "select" && o.filters.length === 2);
    expect(resyncs.length).toBeGreaterThanOrEqual(2);
  });

  it("ignores malformed pointers and other tables", async () => {
    const { db, store } = setup();
    const got: string[] = [];
    store.watchCommands((id) => got.push(id));
    await tick();
    for (const p of [
      null,
      "x",
      { table: "devices", op: "update", key: {} },
      { table: "commands", op: "insert", key: {} },
    ])
      db.broadcast(`chalito:device:${DEV}`, p);
    await tick();
    expect(got).toEqual([]);
  });
});

describe("SupabaseStore: writes through the Data API", () => {
  it("createApproval / resolveApproval map to snake_case columns and ISO times", async () => {
    const { db, store } = setup();
    const req = {
      v: 1,
      aid: "a1",
      uid: OWNER,
      deviceId: DEV,
      sid: "s1",
      requestId: "r1",
      kind: "tool",
      risk: "HIGH",
      origin: "client:dev_phone",
      stepUpRequired: true,
      detailsCt: { v: 1 },
      status: "pending",
      createdAt: T,
      expiresAt: T + 600_000,
      recommendations: [],
    } as unknown as ApprovalRequest;
    await store.createApproval(req);
    expect(db.rows("approvals")[0]).toMatchObject({
      owner: OWNER,
      aid: "a1",
      device_id: DEV,
      request_id: "r1",
      step_up_required: true,
      details_ct: { v: 1 },
      status: "pending",
      expires_at: new Date(T + 600_000).toISOString(),
    });
    await store.resolveApproval("a1", "approved", "signed", T + 5000);
    expect(db.rows("approvals")[0]).toMatchObject({
      status: "approved",
      reason: "signed",
      resolved_at: new Date(T + 5000).toISOString(),
    });
  });

  it("writeEvent keeps the whole event as doc and expires 7 days after the event time", async () => {
    const { db, store } = setup();
    const e = {
      v: 1,
      eid: "e1",
      sid: "s1",
      deviceId: DEV,
      seq: 3,
      t: T,
      urgency: "low",
      type: "session.state",
      state: "running",
    };
    await store.writeEvent(e as unknown as AgentEvent);
    expect(db.rows("session_events")[0]).toMatchObject({
      owner: OWNER,
      sid: "s1",
      eid: "e1",
      device_id: DEV,
      seq: 3,
      t: new Date(T).toISOString(),
      type: "session.state",
      doc: e,
      expires_at: new Date(T + 7 * 86_400_000).toISOString(),
    });
  });

  it("upsertSession merges through chalito.session_merge", async () => {
    const { db, store } = setup();
    await store.upsertSession("s1", { state: "starting", label: "chalito" });
    await store.upsertSession("s1", { state: "running", card: undefined });
    expect(db.rpcs.map((r) => r.fn)).toEqual(["session_merge", "session_merge"]);
    expect(db.rpcs[1]!.args).toEqual({ p_sid: "s1", p_patch: { state: "running", deviceId: DEV } });
    expect(db.rows("sessions")[0]!.doc).toEqual({ state: "running", label: "chalito", deviceId: DEV });
  });

  it("updateDevice writes only the given fields", async () => {
    const { db, store } = setup();
    db.seed("devices", { owner: OWNER, device_id: DEV });
    await store.updateDevice({ lastSeenAt: T });
    expect(db.ops.at(-1)!.body).toEqual({ last_seen_at: new Date(T).toISOString() });
    await store.updateDevice({ policyHash: "h".repeat(64), devMode: { on: false, toggles: [], since: null } });
    expect(db.ops.at(-1)!.body).toEqual({
      policy_hash: "h".repeat(64),
      dev_mode: { on: false, toggles: [], since: null },
    });
    const n = db.ops.length;
    await store.updateDevice({});
    expect(db.ops.length).toBe(n);
  });

  it("publishDeviceEvent sets devices.last_event and appends an audit row (source deviceEvent)", async () => {
    const { db, store } = setup();
    db.seed("devices", { owner: OWNER, device_id: DEV });
    await store.publishDeviceEvent({ v: 1, type: "devmode.changed", deviceId: DEV, on: false, toggles: [], t: T });
    expect(db.rows("devices")[0]!.last_event).toMatchObject({ type: "devmode.changed", on: false });
    expect(db.rows("audit")[0]).toMatchObject({
      owner: OWNER,
      device_id: DEV,
      type: "devmode.changed",
      source: "deviceEvent",
      meta: { type: "devmode.changed" },
    });
  });

  it("audit redacts meta", async () => {
    const { db, store } = setup();
    await store.audit({
      eid: "x1",
      t: T,
      type: "command.rejected",
      meta: { note: "key sk-ant-abcdefghijklmnop" },
      source: "agent",
    });
    expect(JSON.stringify(db.rows("audit")[0]!.meta)).not.toContain("abcdefghijklmnop");
  });

  it("callBriefingEnabled reads users.call_briefing.enabled", async () => {
    const { db, store } = setup();
    expect(await store.callBriefingEnabled()).toBe(false);
    db.seed("users", { id: OWNER, call_briefing: { enabled: true } });
    expect(await store.callBriefingEnabled()).toBe(true);
  });

  it("call lines: insert with the line text and expiry; delete by key (errors swallowed)", async () => {
    const { db, store } = setup();
    const line: CallLine = {
      v: 1,
      notificationId: "n1",
      deviceId: DEV,
      sid: "s1",
      line: "¿Apruebo el cambio?",
      expireAt: T + 60_000,
    };
    await store.writeCallLine("l1", line);
    expect(db.rows("call_lines")[0]).toMatchObject({
      lid: "l1",
      notification_id: "n1",
      sid: "s1",
      line: "¿Apruebo el cambio?",
      expires_at: new Date(T + 60_000).toISOString(),
    });
    db.failNext("gone");
    await store.deleteCallLine("l1");
    await store.deleteCallLine("l1");
    expect(db.rows("call_lines")).toHaveLength(0);
  });

  it("rate-limited writes (PT429) back off exponentially and succeed; exhausting retries throws", async () => {
    const db = new FakeSupabase();
    const sleeps: number[] = [];
    const store = new SupabaseStore(db, OWNER, DEV, {
      retry: { baseMs: 100, attempts: 3 },
      sleep: async (ms) => void sleeps.push(ms),
    });
    db.failNext("chalito: rate limit for dev on audit", "PT429", 2);
    await store.audit({ eid: "r1", t: T, type: "x", meta: {}, source: "agent" });
    expect(db.rows("audit")).toHaveLength(1);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(75);
    expect(sleeps[1]).toBeGreaterThanOrEqual(150);

    db.failNext("chalito: rate limit", "PT429", 10);
    await expect(store.audit({ eid: "r2", t: T, type: "x", meta: {}, source: "agent" })).rejects.toMatchObject({
      code: "PT429",
    });
    expect(sleeps).toHaveLength(5);
  });

  it("RLS and constraint errors surface as SupabaseError with the Postgres code", async () => {
    const { db, store } = setup();
    db.failNext("new row violates row-level security policy", "42501");
    await expect(store.resolveApproval("a1", "approved", "x", T)).rejects.toMatchObject({
      name: "SupabaseError",
      code: "42501",
    });
    db.failNext("boom");
    await expect(
      store.writeEvent({ sid: "s", eid: "e", seq: 0, t: T, type: "x" } as unknown as AgentEvent),
    ).rejects.toBeInstanceOf(SupabaseError);
  });
});

describe("SupabaseCloud and token sources", () => {
  it("refresh() gets a token, hands it to Realtime, and the Data API uses the latest one", async () => {
    let n = 0;
    let fake: FakeSupabase | undefined;
    const cloud = supabaseCloud(
      { url: "http://127.0.0.1:54321", publishableKey: "sb_publishable_x" },
      apiTokenSource(async () => `jwt-${++n}`),
      { create: (_u, _k, accessToken) => (fake = new FakeSupabase(accessToken)) },
    );
    expect(cloud.refreshIntervalMs).toBe(SUPABASE_REFRESH_MS);
    expect(SUPABASE_REFRESH_MS).toBeLessThan(5 * 60 * 1000);
    await cloud.refresh();
    expect(await fake!.accessToken!()).toBe("jwt-1");
    await cloud.refresh();
    expect(await fake!.accessToken!()).toBe("jwt-2");
    expect(fake!.authTokens).toEqual(["jwt-1", "jwt-2"]);

    const store = cloud.store(OWNER, DEV);
    store.watchCommands(() => undefined);
    await tick();
    await cloud.close();
    expect(fake!.channels.every((c) => c.removed)).toBe(true);
  });
});

describe("supabasePairingWatcher", () => {
  const row = {
    code_id: "code_123456789",
    short_code_hash: "0".repeat(64),
    glyph: {
      body: {
        v: 1,
        purpose: "pair_device",
        codeId: "code_123456789",
        issuerPubSign: "A".repeat(43),
        label: "pc",
        issuedAt: T,
        expiresAt: T + 60_000,
        nonce: "A".repeat(22),
      },
      sig: "A".repeat(86),
    },
    agent_device_id: DEV,
    kind: "desktop",
    platform: "linux",
    claimed: true,
    owner: OWNER,
    claimed_by_device_id: "dev_phone",
    claimer_pub_sign: "B".repeat(43),
    claimer_pub_box: "C".repeat(43),
    expires_at: new Date(T + 60_000).toISOString(),
  };

  it("joins chalito:pairing:<code> with the watch token and maps the row to PairingCodeDoc", async () => {
    let fake: FakeSupabase | undefined;
    const w = supabasePairingWatcher(
      { url: "http://127.0.0.1:54321", publishableKey: "k" },
      { create: (_u, _k, at) => (fake = new FakeSupabase(at)) },
    );
    const docs: Record<string, unknown>[] = [];
    const stop = await w.watch("watch-jwt", "code_123456789", (d) => docs.push(d));
    expect(await fake!.accessToken!()).toBe("watch-jwt");
    expect(fake!.channels[0]).toMatchObject({
      topic: "chalito:pairing:code_123456789",
      opts: { config: { private: true } },
    });
    fake!.seed("pairing_codes", row);
    fake!.broadcast("chalito:pairing:code_123456789", {
      table: "pairing_codes",
      op: "update",
      key: { code_id: row.code_id },
    });
    await tick();
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.at(-1)).toMatchObject({ codeId: row.code_id, claimed: true, owner: OWNER, expiresAt: T + 60_000 });
    expect(PairingCodeDoc.safeParse(pairingRowToDoc(row)).success).toBe(true);
    await stop();
    expect(fake!.channels[0]!.removed).toBe(true);
  });
});

describe("Realtime auth before join (realtime-js 2.117: setAuth is async)", () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  it("the store doesn't subscribe its channel until setAuth has resolved", async () => {
    const db = new FakeSupabase();
    const gate = deferred();
    const calls: string[] = [];
    db.realtime = {
      setAuth: (t?: string | null) => {
        calls.push(`setAuth:${t ?? "(callback)"}`);
        return gate.promise;
      },
    } as unknown as FakeSupabase["realtime"];
    const store = new SupabaseStore(db, OWNER, DEV);
    store.watchCommands(() => undefined);
    store.watchApproval("a1", () => undefined);
    await tick();
    expect(calls).toEqual(["setAuth:(callback)"]);
    expect(db.channels).toHaveLength(0);
    gate.resolve();
    await store.joined();
    expect(db.channels).toHaveLength(1);
  });

  it("the pairing watcher awaits setAuth(watch token) before joining", async () => {
    const gate = deferred();
    let fake: FakeSupabase | undefined;
    const w = supabasePairingWatcher(
      { url: "http://127.0.0.1:54321", publishableKey: "k" },
      {
        create: (_u, _k, at) => {
          fake = new FakeSupabase(at);
          fake.realtime = { setAuth: () => gate.promise } as unknown as FakeSupabase["realtime"];
          return fake;
        },
      },
    );
    const watching = w.watch("watch-jwt", "code_123456789", () => undefined);
    await tick();
    expect(fake!.channels).toHaveLength(0);
    gate.resolve();
    const stop = await watching;
    expect(fake!.channels).toHaveLength(1);
    await stop();
  });

  it("the cloud awaits setAuth on every refresh", async () => {
    let n = 0;
    const order: string[] = [];
    const cloud = supabaseCloud(
      { url: "http://127.0.0.1:54321", publishableKey: "k" },
      apiTokenSource(async () => `jwt-${++n}`),
      {
        create: (_u, _k, at) => {
          const f = new FakeSupabase(at);
          f.realtime = {
            setAuth: async (t?: string | null) => {
              await tick();
              order.push(`setAuth:${t}`);
            },
          } as unknown as FakeSupabase["realtime"];
          return f;
        },
      },
    );
    await cloud.refresh();
    order.push("refreshed");
    expect(order).toEqual(["setAuth:jwt-1", "refreshed"]);
  });
});

describe("SupabaseStore: endorsements (ADR 0018)", () => {
  it("lists the account's endorsements with each endorsed device's directory state", async () => {
    const { db, store } = setup();
    db.seed("endorsements", { owner: OWNER, device_id: "dev_desk", endorsement: { e: 1 } });
    db.seed("endorsements", { owner: OWNER, device_id: "dev_gone", endorsement: { e: 2 } });
    db.seed("endorsements", { owner: "someone-else", device_id: "dev_x", endorsement: { e: 3 } });
    db.seed("devices", { owner: OWNER, device_id: "dev_desk", revoked: false, webauthn_binding: { b: 1 } });
    expect(await store.listEndorsements()).toEqual([
      { deviceId: "dev_desk", endorsement: { e: 1 }, revoked: false, webauthnBinding: { b: 1 } },
      // A device missing from the directory counts as revoked.
      { deviceId: "dev_gone", endorsement: { e: 2 }, revoked: true, webauthnBinding: null },
    ]);
  });

  it("an endorsements or devices pointer, and every resync, wakes the watcher", async () => {
    const { db, store } = setup();
    let n = 0;
    store.watchEndorsements(() => n++);
    await tick();
    const after = n; // the initial SUBSCRIBED resync
    expect(after).toBeGreaterThanOrEqual(1);
    db.broadcast(`chalito:device:${DEV}`, { table: "endorsements", op: "insert", key: { device_id: "dev_desk" } });
    db.broadcast(`chalito:device:${DEV}`, { table: "devices", op: "update", key: { device_id: "dev_desk" } });
    await tick();
    expect(n).toBe(after + 2);
  });
});
