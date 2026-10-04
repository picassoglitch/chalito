import { describe, expect, it } from "vitest";
import { fromB64url, sealJson } from "@chalito/crypto";
import { LiveStore } from "../src/live.js";
import { FakeSupabase, newDevice, testKeys, tick, type Device } from "./helpers.js";

const OWNER = "hub-user-1";
const T = Date.now();

const sealTo = async (value: unknown, devices: Device[], aad: string) => {
  const r: Record<string, Uint8Array> = {};
  for (const d of devices) r[d.deviceId] = await fromB64url(d.pubBox);
  return sealJson(value, r, aad);
};

const setup = async (opts: ConstructorParameters<typeof LiveStore>[3] = {}) => {
  const me = await newDevice();
  const agent = await newDevice();
  const db = new FakeSupabase();
  const live = new LiveStore(db, testKeys(me), OWNER, opts);
  return { me, agent, db, live, topic: `chalito:device:${me.deviceId}` };
};

const approvalRow = async (aid: string, agent: Device, to: Device[], extra: Record<string, unknown> = {}) => ({
  owner: OWNER,
  aid,
  device_id: agent.deviceId,
  sid: "s1",
  request_id: `r-${aid}`,
  kind: "tool",
  risk: "MED",
  origin: "local",
  step_up_required: false,
  details_ct: await sealTo({ toolName: "Bash", summary: "pnpm install" }, to, `approval:${aid}`),
  status: "pending",
  created_at: new Date(T).toISOString(),
  expires_at: new Date(T + 600_000).toISOString(),
  ...extra,
});

describe("LiveStore", () => {
  it("joins chalito:device:<this device> privately, goes live and loads every table", async () => {
    const { db, live, topic } = await setup();
    live.start();
    await tick();
    expect(db.channels[0]).toMatchObject({ topic, opts: { config: { private: true } } });
    expect(live.getSnapshot().status).toBe("live");
    const pulled = new Set(db.ops.filter((o) => o.op === "select").map((o) => o.table));
    expect(pulled).toEqual(new Set(["devices", "sessions", "approvals", "notifications", "session_events"]));
    for (const o of db.ops) expect(o.filters).toContainEqual(["owner", OWNER]);
  });

  it("opens approval details sealed to this device (AAD approval:<aid>); others stay null", async () => {
    const { me, agent, db, live } = await setup();
    const stranger = await newDevice();
    db.seed("approvals", await approvalRow("a1", agent, [me, agent]));
    db.seed("approvals", await approvalRow("a2", agent, [stranger]));
    live.start();
    await tick(30);
    const byAid = Object.fromEntries(live.getSnapshot().approvals.map((a) => [a.aid, a]));
    expect(byAid.a1!.details).toEqual({ toolName: "Bash", summary: "pnpm install" });
    expect(byAid.a1).toMatchObject({ agentDeviceId: agent.deviceId, requestId: "r-a1", status: "pending" });
    expect(byAid.a2!.details).toBeNull();
  });

  it("a pointer pulls only that table with rev > last; a burst of pointers is coalesced", async () => {
    const { me, agent, db, live, topic } = await setup();
    live.start();
    await tick();
    const before = db.ops.length;
    db.seed("approvals", await approvalRow("a3", agent, [me]));
    for (let i = 0; i < 5; i++) db.broadcast(topic, { table: "approvals", op: "insert", key: { aid: "a3" }, rev: 1 });
    await tick(30);
    const pulls = db.ops.slice(before).filter((o) => o.op === "select");
    expect(pulls.every((p) => p.table === "approvals")).toBe(true);
    expect(pulls.length).toBeLessThanOrEqual(2);
    expect(pulls.at(-1)!.gts).toEqual([["rev", expect.any(Number)]]);
    expect(live.getSnapshot().approvals.map((a) => a.aid)).toEqual(["a3"]);
  });

  it("an update made while offline (status → approved) arrives on rejoin through rev", async () => {
    const { me, agent, db, live, topic } = await setup();
    db.seed("approvals", await approvalRow("a4", agent, [me]));
    live.start();
    await tick(30);
    db.status(topic, "CHANNEL_ERROR");
    expect(live.getSnapshot().status).toBe("offline");
    db.touch("approvals", (r) => r.aid === "a4", { status: "approved", reason: "signed" });
    db.rejoin(topic);
    await tick(30);
    expect(live.getSnapshot().status).toBe("live");
    expect(live.approval("a4")).toMatchObject({ status: "approved", reason: "signed" });
  });

  it("sessions carry the opened card (AAD card:<sid>); events are opened, ordered and capped", async () => {
    const { me, agent, db, live } = await setup({ maxEventsPerSession: 3 });
    db.seed("sessions", {
      owner: OWNER,
      sid: "s1",
      device_id: agent.deviceId,
      doc: {
        adapter: "claude-code",
        label: "chalito",
        state: "running",
        card: { ct: await sealTo({ v: 1, sid: "s1", goal: "arreglar login" }, [me], "card:s1") },
      },
      updated_at: new Date(T).toISOString(),
    });
    for (let seq = 0; seq < 5; seq++)
      db.seed("session_events", {
        owner: OWNER,
        sid: "s1",
        eid: `e${seq}`,
        device_id: agent.deviceId,
        seq,
        t: new Date(T + seq).toISOString(),
        type: "message.assistant",
        urgency: "low",
        doc: { type: "message.assistant", seq, ct: await sealTo({ text: `hola ${seq}` }, [me], "event:s1") },
      });
    live.start();
    await tick(50);
    const snap = live.getSnapshot();
    expect(snap.sessions[0]).toMatchObject({ sid: "s1", state: "running", card: { goal: "arreglar login" } });
    expect(snap.events.s1!.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(snap.events.s1![2]).toMatchObject({ content: { text: "hola 4" }, meta: { type: "message.assistant" } });
    expect(snap.events.s1![2]!.meta).not.toHaveProperty("ct");
  });

  it("a card sealed under another context doesn't open", async () => {
    const { me, agent, db, live } = await setup();
    db.seed("sessions", {
      owner: OWNER,
      sid: "s2",
      device_id: agent.deviceId,
      doc: { card: { ct: await sealTo({ v: 1 }, [me], "card:OTHER") } },
    });
    live.start();
    await tick(30);
    expect(live.session("s2")!.card).toBeNull();
  });

  it("devices: online window, the Developer-mode badge, and this device's revocation", async () => {
    const now = T;
    const { me, agent, db, live } = await setup({ now: () => now, onlineWindowMs: 60_000 });
    const dev = (d: Device, extra: Record<string, unknown>) => ({
      owner: OWNER,
      device_id: d.deviceId,
      role: d === me ? "client" : "agent",
      kind: "desktop",
      platform: "linux",
      name: d === me ? "phone" : "desk",
      revoked: false,
      dev_mode: { on: false, toggles: [], since: null },
      ...extra,
    });
    db.seed("devices", dev(agent, { last_seen_at: new Date(now - 10_000).toISOString() }));
    db.seed("devices", dev(me, { last_seen_at: new Date(now - 120_000).toISOString() }));
    live.start();
    await tick(30);
    let snap = live.getSnapshot();
    expect(snap.devices.find((d) => d.deviceId === agent.deviceId)!.online).toBe(true);
    expect(snap.devices.find((d) => d.deviceId === me.deviceId)!.online).toBe(false);
    expect(snap.devModeActive).toBe(false);

    db.touch("devices", (r) => r.device_id === agent.deviceId, {
      dev_mode: { on: true, toggles: ["autoApproveHigh"], since: now },
    });
    await live.resync();
    expect(live.getSnapshot().devModeActive).toBe(true);

    db.touch("devices", (r) => r.device_id === me.deviceId, { revoked: true });
    await live.resync();
    snap = live.getSnapshot();
    expect(snap.status).toBe("revoked");
  });

  it("notifications are listed newest first", async () => {
    const { db, live } = await setup();
    for (const [nid, t] of [
      ["n1", T],
      ["n2", T + 1000],
    ] as const)
      db.seed("notifications", {
        owner: OWNER,
        nid,
        level: "L2",
        source: "approval",
        urgency: "high",
        counts: { approvals: 1 },
        deep_link: `/a/${nid}`,
        state: "pending",
        created_at: new Date(t).toISOString(),
      });
    live.start();
    await tick(30);
    expect(live.getSnapshot().notifications.map((n) => n.nid)).toEqual(["n2", "n1"]);
  });

  it("pages through large tables", async () => {
    const { me, agent, db, live } = await setup({ pageSize: 2 });
    for (let i = 0; i < 5; i++) db.seed("approvals", await approvalRow(`p${i}`, agent, [me]));
    live.start();
    await tick(50);
    expect(live.getSnapshot().approvals).toHaveLength(5);
  });

  it("getSnapshot is stable until something changes; subscribers are told once per change", async () => {
    const { me, agent, db, live, topic } = await setup();
    let calls = 0;
    const unsub = live.subscribe(() => calls++);
    live.start();
    await tick(30);
    const a = live.getSnapshot();
    await live.resync();
    expect(live.getSnapshot()).toBe(a);
    const n = calls;
    db.seed("approvals", await approvalRow("a9", agent, [me]));
    db.broadcast(topic, { table: "approvals", op: "insert", key: { aid: "a9" } });
    await tick(30);
    expect(live.getSnapshot()).not.toBe(a);
    expect(calls).toBe(n + 1);
    unsub();
    db.touch("approvals", () => true, { status: "expired" });
    await live.resync();
    expect(calls).toBe(n + 1);
  });

  it("a `revoked` pointer for this device closes the channel at once (review R-L14)", async () => {
    const { db, live, topic, me } = await setup();
    live.start();
    await tick();
    expect(live.getSnapshot().status).toBe("live");
    // Someone else's revocation is not ours.
    db.broadcast(topic, { table: "device_revoked", op: "revoked", key: { device_id: "dev_other" } });
    await tick();
    expect(live.getSnapshot().status).toBe("live");
    db.broadcast(topic, { table: "device_revoked", op: "revoked", key: { device_id: me.deviceId } });
    await tick();
    expect(live.getSnapshot().status).toBe("revoked");
    expect(db.channels[0]!.removed).toBe(true);
  });

  it("ignores unknown and malformed pointers; stop() leaves the channel", async () => {
    const { db, live, topic } = await setup();
    live.start();
    await tick();
    const before = db.ops.length;
    for (const p of [null, "x", { table: "commands" }, { table: "audit" }]) db.broadcast(topic, p);
    await tick();
    expect(db.ops.length).toBe(before);
    await live.stop();
    expect(db.channels[0]!.removed).toBe(true);
    expect(live.getSnapshot().status).toBe("idle");
  });

  it("doesn't subscribe before Realtime has the token (setAuth is async in realtime-js 2.117)", async () => {
    const { db, live } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (db as unknown as { realtime: { setAuth: () => Promise<void> } }).realtime = { setAuth: () => gate };
    live.start();
    await tick();
    expect(db.channels).toHaveLength(0);
    expect(live.getSnapshot().status).toBe("connecting");
    release();
    await live.joined();
    expect(db.channels).toHaveLength(1);
    await tick();
    expect(live.getSnapshot().status).toBe("live");
  });

  it("stop() before the join was issued never joins", async () => {
    const { db, live } = await setup();
    let release!: () => void;
    (db as unknown as { realtime: { setAuth: () => Promise<void> } }).realtime = {
      setAuth: () => new Promise<void>((r) => (release = r)),
    };
    live.start();
    const stopping = live.stop();
    release();
    await stopping;
    expect(db.channels).toHaveLength(0);
  });
});
