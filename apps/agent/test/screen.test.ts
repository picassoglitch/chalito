import { describe, expect, it } from "vitest";
import {
  SCREEN_CHUNK_MAX,
  SCREEN_FRAMES_CHANNEL,
  SCREEN_INPUT_CHANNEL,
  type Origin,
  type ScreenSignalBody,
} from "@chalito/protocol";
import { ComputerUnsupportedError } from "../src/computer/native.js";
import { DEFAULT_POLICY, applyRemoteTighten, isTighterOrEqual, type Policy } from "../src/policy/index.js";
import { FrameAssembler, chunkFrame, encodeFrame } from "../src/screen/frames.js";
import { toDisplay } from "../src/screen/input.js";
import {
  SCREEN_INDICATOR_GRACE_MS,
  SCREEN_MAX_SESSIONS,
  SCREEN_OPEN_LIMIT,
  ScreenManager,
  type ScreenApprovalOutcome,
  type ScreenDeps,
} from "../src/screen/manager.js";
import { DEFAULT_ICE_SERVERS, iceServersFrom } from "../src/screen/peer.js";
import { SCREEN_COPY, disableScreen, enableScreen, screenLevel } from "../src/screen/toggle.js";
import { fakeDriver, fakePeers, manualTimers, tick, type FakePeer } from "./screen-fakes.js";

const VIEW: Policy["screen"] = {
  view: true,
  control: false,
  maxFps: 5,
  maxInputsPerMinute: 600,
  maxSessionMinutes: 60,
};
const CONTROL: Policy["screen"] = { ...VIEW, control: true };
const PHONE: Origin = "client:dev_phone";

const setup = (
  o: {
    policy?: Policy["screen"];
    approve?: () => Promise<ScreenApprovalOutcome>;
    desktop?: boolean;
    driverThrows?: Error;
    apps?: ScreenDeps["apps"];
  } = {},
) => {
  let policy: Policy["screen"] = "policy" in o ? o.policy : VIEW;
  let t = 1_790_000_000_000;
  let indicator = true;
  let desktop = o.desktop ?? true;
  const audits: { type: string; meta: Record<string, unknown> }[] = [];
  const published: unknown[] = [];
  const events: Record<string, unknown>[] = [];
  const sessions = new Map<string, Record<string, unknown>>();
  const asked: { sid: string; kind: string; origin: Origin }[] = [];
  const sealed: { to: string; value: unknown; aad: string }[] = [];
  const { driver, ops } = fakeDriver();
  const { factory, peers } = fakePeers();
  const timers = manualTimers();
  let release: ((o: ScreenApprovalOutcome) => void) | null = null;
  let n = 0;
  const deps: ScreenDeps = {
    policy: () => policy,
    driver: () => {
      if (o.driverThrows) throw o.driverThrows;
      return driver;
    },
    desktopPresent: () => desktop,
    indicatorShown: () => desktop && indicator,
    requestApproval: async (sid, input) => {
      asked.push({ sid, kind: input.kind, origin: input.origin });
      input.onRequested(`aid_${sid}`, t + 600_000);
      if (o.approve) return o.approve();
      return new Promise((r) => (release = r));
    },
    writeEvent: async (e) => void events.push(e as unknown as Record<string, unknown>),
    upsertSession: async (sid, doc) => void sessions.set(sid, { ...sessions.get(sid), ...doc }),
    sealFor: async (to, value, aad) => {
      if (to !== "dev_phone") return null;
      sealed.push({ to, value, aad });
      return { alg: "xchacha20poly1305+sealedbox", nonce: "A".repeat(32), ct: "AAAA", keys: { [to]: "A".repeat(107) } };
    },
    signSignal: async (body: ScreenSignalBody) => ({
      ctx: "chalito.screen-signal.v1",
      body,
      signerDeviceId: "dev_agent",
      sig: "A".repeat(86),
    }),
    peer: factory,
    iceServers: () => DEFAULT_ICE_SERVERS,
    ...(o.apps ? { apps: o.apps } : {}),
    audit: (type, meta) => void audits.push({ type, meta }),
    publish: (s) => void published.push(s),
    deviceId: "dev_agent",
    now: () => t,
    every: timers.every,
    after: timers.after,
    newSid: () => `scr_${++n}`,
  };
  const m = new ScreenManager(deps);
  return {
    m,
    ops,
    peers,
    timers,
    audits,
    published,
    events,
    sessions,
    asked,
    sealed,
    setPolicy: (p: Policy["screen"]) => (policy = p),
    setIndicator: (v: boolean) => (indicator = v),
    setDesktop: (v: boolean) => (desktop = v),
    advance: (ms: number) => (t += ms),
    decide: async (allow = true) => {
      release?.({ allow, reason: allow ? "signed_allow" : "signed_deny", byDeviceId: "dev_phone" });
      await tick();
      await tick();
    },
    types: () => audits.map((a) => a.type),
  };
};

type H = ReturnType<typeof setup>;

/** Opens, approves and brings the session live (the browser's frames channel opens). */
const live = async (h: H, mode: "view" | "control" = "view") => {
  const r = await h.m.open({ origin: PHONE, mode });
  if (!r.ok) throw new Error(r.reason);
  await tick();
  await h.decide(true);
  const peer = h.peers.at(-1)!;
  await h.m.signal(r.sid, PHONE, { kind: "answer", sdp: "v=0 answer" });
  peer.channel(SCREEN_FRAMES_CHANNEL)!.open();
  await tick();
  return { sid: r.sid, peer };
};

describe("remote screen: off unless enabled on the device", () => {
  it("refuses screen.open while off, and control while only view is on", async () => {
    const off = setup({ policy: undefined });
    expect(await off.m.open({ origin: PHONE, mode: "view" })).toEqual({ ok: false, reason: "screen_disabled" });
    expect(DEFAULT_POLICY.screen).toBeUndefined();
    const view = setup({ policy: VIEW });
    expect(await view.m.open({ origin: PHONE, mode: "control" })).toEqual({ ok: false, reason: "screen_disabled" });
    expect(off.asked).toEqual([]);
    expect(view.asked).toEqual([]);
    expect(off.peers).toEqual([]);
  });

  it("only a trusted browser (client:) may open it; never relayed or local origins", async () => {
    const h = setup();
    for (const origin of ["mcp:chatgpt", `call:CA${"a".repeat(32)}`, "local"] as Origin[])
      expect(await h.m.open({ origin, mode: "view" })).toEqual({ ok: false, reason: "screen_needs_client" });
    expect(h.asked).toEqual([]);
  });

  it("needs the desktop app (indicator + kill switch) and a capturable screen", async () => {
    expect(await setup({ desktop: false }).m.open({ origin: PHONE, mode: "view" })).toEqual({
      ok: false,
      reason: "no_desktop",
    });
    const wayland = setup({ driverThrows: new ComputerUnsupportedError("wayland", "no") });
    expect(await wayland.m.open({ origin: PHONE, mode: "view" })).toEqual({
      ok: false,
      reason: "screen_unsupported",
    });
    expect(await setup().m.open({ origin: PHONE, mode: "view", display: "3" })).toEqual({
      ok: false,
      reason: "bad_display",
    });
  });

  it("rate-limits opens and caps concurrent sessions", async () => {
    const h = setup();
    for (let i = 0; i < SCREEN_MAX_SESSIONS; i++)
      expect((await h.m.open({ origin: PHONE, mode: "view" })).ok).toBe(true);
    expect(await h.m.open({ origin: PHONE, mode: "view" })).toEqual({ ok: false, reason: "screen_busy" });
    const r = setup();
    for (let i = 0; i < SCREEN_OPEN_LIMIT; i++) {
      const o = await r.m.open({ origin: PHONE, mode: "view" });
      if (o.ok) await r.m.close(o.sid, PHONE);
    }
    expect(await r.m.open({ origin: PHONE, mode: "view" })).toEqual({ ok: false, reason: "rate_limited" });
    r.advance(10 * 60 * 1000);
    expect((await r.m.open({ origin: PHONE, mode: "view" })).ok).toBe(true);
  });
});

describe("remote screen: per-session approval before anything is captured", () => {
  it("asks remote_view for view and remote_control for control; nothing runs before it", async () => {
    const h = setup({ policy: CONTROL });
    const v = await h.m.open({ origin: PHONE, mode: "view" });
    const c = await h.m.open({ origin: PHONE, mode: "control" });
    await tick();
    expect(v.ok && c.ok).toBe(true);
    expect(h.asked.map((a) => a.kind)).toEqual(["remote_view", "remote_control"]);
    expect(h.asked.every((a) => a.origin === PHONE)).toBe(true);
    expect(h.peers).toEqual([]);
    expect(h.ops).toEqual([]);
    expect(h.m.status().pending.map((p) => p.mode)).toEqual(["view", "control"]);
    expect(h.m.status().active).toEqual([]);
    expect(h.events.some((e) => e.type === "approval.requested")).toBe(true);
  });

  it("a deny ends the session: no peer, no capture", async () => {
    const h = setup({ approve: async () => ({ allow: false, reason: "signed_deny" }) });
    const r = await h.m.open({ origin: PHONE, mode: "view" });
    await tick();
    await tick();
    expect(r.ok).toBe(true);
    expect(h.peers).toEqual([]);
    expect(h.ops).toEqual([]);
    expect(h.types()).toEqual(["screen.requested", "screen.denied", "screen.ended"]);
    expect(h.events.at(-1)).toMatchObject({ type: "screen.state", state: "ended", reason: "denied" });
    expect(h.m.status().pending).toEqual([]);
  });

  it("an approval that arrives after the kill switch grants nothing", async () => {
    const h = setup();
    await h.m.open({ origin: PHONE, mode: "view" });
    await tick();
    expect(await h.m.kill("hotkey")).toBe(1);
    await h.decide(true);
    expect(h.peers).toEqual([]);
    expect(h.types()).not.toContain("screen.granted");
  });

  it("an approval that arrives after remote view was turned off grants nothing", async () => {
    const h = setup();
    await h.m.open({ origin: PHONE, mode: "view" });
    await tick();
    h.setPolicy(undefined);
    await h.decide(true);
    expect(h.peers).toEqual([]);
  });
});

describe("remote screen: sealed, signed signaling; the agent owns the channels", () => {
  it("sends one agent-signed offer, sealed to the requesting browser only", async () => {
    const h = setup();
    const r = await h.m.open({ origin: PHONE, mode: "view" });
    await tick();
    await h.decide(true);
    expect(h.sealed).toHaveLength(1);
    const s = h.sealed[0]!;
    expect(s.to).toBe("dev_phone");
    expect(s.aad).toBe(`screen:${r.ok && r.sid}`);
    expect(s.value).toMatchObject({
      ctx: "chalito.screen-signal.v1",
      body: { v: 1, sid: r.ok && r.sid, deviceId: "dev_agent", seq: 0, signal: { kind: "offer" } },
    });
    // On the session's stream the signal is only ciphertext.
    const ev = h.events.find((e) => e.type === "screen.signal")!;
    expect(ev.ct).toBeTruthy();
    expect(JSON.stringify(ev)).not.toContain("fingerprint");
    // View mode: only the frames channel, unordered and never retransmitted.
    const peer = h.peers[0]!;
    expect(peer.channels.map((c) => [c.label, c.opts])).toEqual([
      [SCREEN_FRAMES_CHANNEL, { ordered: false, maxRetransmits: 0 }],
    ]);
    expect(peer.iceServers).toEqual(DEFAULT_ICE_SERVERS);
  });

  it("accepts the answer and ICE only from the browser that opened it; refuses browser offers", async () => {
    const h = setup();
    const r = await h.m.open({ origin: PHONE, mode: "view" });
    if (!r.ok) throw new Error();
    expect(await h.m.signal(r.sid, PHONE, { kind: "answer", sdp: "x" })).toEqual({ ok: false, reason: "not_ready" });
    await tick();
    await h.decide(true);
    expect(await h.m.signal(r.sid, "client:dev_laptop", { kind: "answer", sdp: "x" })).toEqual({
      ok: false,
      reason: "origin_mismatch",
    });
    expect(await h.m.signal(r.sid, PHONE, { kind: "offer", sdp: "x" })).toEqual({ ok: false, reason: "bad_signal" });
    expect(await h.m.signal(r.sid, PHONE, { kind: "answer", sdp: "v=0 a" })).toEqual({ ok: true });
    expect(await h.m.signal(r.sid, PHONE, { kind: "answer", sdp: "v=0 b" })).toEqual({
      ok: false,
      reason: "duplicate_answer",
    });
    expect(
      await h.m.signal(r.sid, PHONE, { kind: "ice", candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host" }),
    ).toEqual({ ok: true });
    expect(h.peers[0]!.answer).toBe("v=0 a");
    expect(await h.m.signal("nope", PHONE, { kind: "answer", sdp: "x" })).toEqual({
      ok: false,
      reason: "unknown_session",
    });
  });

  it("closes any data channel the browser opens", async () => {
    const h = setup();
    const { peer } = await live(h);
    const rogue = peer.remoteOpens("rogue-input");
    expect(rogue.closed).toBe(true);
    expect(h.types()).toContain("screen.channel_refused");
  });

  it("ends when the client is no longer trusted (nothing to seal to)", async () => {
    const h = setup();
    await h.m.open({ origin: "client:dev_gone", mode: "view" });
    await tick();
    await h.decide(true);
    expect(h.events.at(-1)).toMatchObject({ type: "screen.state", state: "ended", reason: "client_revoked" });
    expect(h.peers[0]!.closed).toBe(true);
  });
});

describe("remote screen: streaming", () => {
  it("streams JPEG frames in chunks only while live and the indicator is on screen", async () => {
    const h = setup();
    const { sid, peer } = await live(h);
    expect(h.m.status().active).toEqual([
      { sid, label: "Pantalla remota (ver)", mode: "view", since: expect.any(Number) },
    ]);
    expect(h.timers.loops).toHaveLength(1);
    expect(h.timers.loops[0]!.ms).toBe(200);
    expect(await h.m.frame(sid)).toBe(true);
    const frames = peer.channel(SCREEN_FRAMES_CHANNEL)!;
    const asm = new FrameAssembler();
    let jpeg: Uint8Array | null = null;
    for (const c of frames.sent) jpeg = asm.push(c as Buffer) ?? jpeg;
    expect(jpeg).not.toBeNull();
    expect([...jpeg!.subarray(0, 2)]).toEqual([0xff, 0xd8]);
    // Indicator gone: no frame; past the grace period the session ends.
    h.setIndicator(false);
    const before = frames.sent.length;
    expect(await h.m.frame(sid)).toBe(false);
    h.advance(SCREEN_INDICATOR_GRACE_MS + 1);
    expect(await h.m.frame(sid)).toBe(false);
    expect(frames.sent.length).toBe(before);
    expect(h.events.at(-1)).toMatchObject({ type: "screen.state", state: "ended", reason: "indicator" });
    expect(peer.closed).toBe(true);
  });

  it("drops frames on a slow link instead of queueing them", async () => {
    const h = setup();
    const { sid, peer } = await live(h);
    peer.channel(SCREEN_FRAMES_CHANNEL)!.buffered = 5 * 1024 * 1024;
    expect(await h.m.frame(sid)).toBe(false);
    expect(h.ops.filter((o) => o[0] === "capture")).toEqual([]);
  });

  it("ends at the session time limit and when the connection doesn't come up", async () => {
    const h = setup();
    const r = await h.m.open({ origin: PHONE, mode: "view" });
    await tick();
    await h.decide(true);
    const connect = h.timers.timeouts.find((t) => t.ms === 60_000)!;
    connect.fn();
    await tick();
    expect(h.events.at(-1)).toMatchObject({ state: "ended", reason: "connect_failed" });
    const g = setup();
    const { sid } = await live(g);
    g.timers.timeouts.find((t) => t.ms === 60 * 60_000)!.fn();
    await tick();
    expect(g.m.status().active).toEqual([]);
    expect(r.ok && sid).toBeTruthy();
  });
});

describe("remote screen: input only in control mode", () => {
  it("view mode has no input channel and ignores input", async () => {
    const h = setup();
    const { sid, peer } = await live(h);
    expect(peer.channel(SCREEN_INPUT_CHANNEL)).toBeUndefined();
    expect(await h.m.input(sid, JSON.stringify({ t: "click", button: "left", x: 0.5, y: 0.5 }))).toBe(false);
    expect(h.ops.filter((o) => o[0] !== "capture")).toEqual([]);
  });

  it("control mode applies validated input mapped to the display; counts only in the audit", async () => {
    const h = setup({ policy: CONTROL });
    const { sid, peer } = await live(h, "control");
    const input = peer.channel(SCREEN_INPUT_CHANNEL)!;
    expect(input.opts).toEqual({ ordered: true });
    expect(await h.m.input(sid, JSON.stringify({ t: "click", button: "left", x: 0.5, y: 1 }))).toBe(true);
    expect(await h.m.input(sid, JSON.stringify({ t: "key", keys: "ctrl+c" }))).toBe(true);
    expect(await h.m.input(sid, JSON.stringify({ t: "text", text: "contraseña secreta" }))).toBe(true);
    expect(await h.m.input(sid, JSON.stringify({ t: "scroll", dx: 0, dy: 3 }))).toBe(true);
    // Invalid, oversized, unknown or binary messages are dropped.
    expect(await h.m.input(sid, JSON.stringify({ t: "exec", cmd: "rm -rf /" }))).toBe(false);
    expect(await h.m.input(sid, JSON.stringify({ t: "key", keys: "ctrl+rm -rf" }))).toBe(false);
    expect(await h.m.input(sid, "x".repeat(5000))).toBe(false);
    expect(await h.m.input(sid, Buffer.from("{}"))).toBe(false);
    expect(h.ops.filter((o) => o[0] !== "capture")).toEqual([
      ["move", 500, 499],
      ["click", "left", false],
      ["key", "c", ["control"]],
      ["type", "contraseña secre"],
      ["type", "ta"],
      ["scroll", 0, -3],
    ]);
    await h.m.close(sid, PHONE);
    const ended = h.audits.find((a) => a.type === "screen.ended")!;
    expect(ended.meta).toMatchObject({ inputs: { click: 1, key: 1, text: 1, scroll: 1 }, dropped: 4 });
    expect(JSON.stringify(h.audits)).not.toContain("secret");
    expect(JSON.stringify(h.audits)).not.toContain("ctrl+c");
  });

  it("drops input while the indicator isn't on screen", async () => {
    const h = setup({ policy: CONTROL });
    const { sid } = await live(h, "control");
    h.setIndicator(false);
    expect(await h.m.input(sid, JSON.stringify({ t: "click", button: "left", x: 0, y: 0 }))).toBe(false);
  });

  it("rate-limits clicks and keys, coalesces pointer moves", async () => {
    const h = setup({ policy: { ...CONTROL, maxInputsPerMinute: 2 } });
    const { sid } = await live(h, "control");
    const key = JSON.stringify({ t: "key", keys: "a" });
    expect(await h.m.input(sid, key)).toBe(true);
    expect(await h.m.input(sid, key)).toBe(true);
    expect(await h.m.input(sid, key)).toBe(false);
    expect(h.types().filter((t) => t === "screen.rate_limited")).toHaveLength(1);
    const move = JSON.stringify({ t: "move", x: 0.1, y: 0.1 });
    expect(await h.m.input(sid, move)).toBe(true);
    expect(await h.m.input(sid, move)).toBe(false);
    h.advance(20);
    expect(await h.m.input(sid, move)).toBe(true);
  });
});

describe("remote screen: the kill switch and turning it off", () => {
  it("the kill switch ends every stream and input and lets go of held buttons", async () => {
    const h = setup({ policy: CONTROL });
    const a = await live(h, "control");
    const b = await live(h, "view");
    expect(await h.m.input(a.sid, JSON.stringify({ t: "button", button: "left", down: true, x: 0, y: 0 }))).toBe(true);
    expect(await h.m.kill("hotkey")).toBe(2);
    for (const p of [a.peer, b.peer] as FakePeer[]) {
      expect(p.closed).toBe(true);
      expect(p.channels.every((c) => c.closed)).toBe(true);
    }
    expect(h.ops).toContainEqual(["button", false, "left"]);
    expect(h.timers.loops.every((l) => l.cleared)).toBe(true);
    expect(await h.m.frame(a.sid)).toBe(false);
    expect(await h.m.input(a.sid, JSON.stringify({ t: "key", keys: "a" }))).toBe(false);
    expect(h.m.status().active).toEqual([]);
    expect(h.types()).toContain("screen.killed");
    expect(h.published.at(-1)).toMatchObject({ activeSessions: 0, by: "hotkey" });
  });

  it("turning control off ends control sessions; turning remote screen off ends all", async () => {
    const h = setup({ policy: CONTROL });
    const c = await live(h, "control");
    const v = await live(h, "view");
    h.setPolicy(VIEW);
    await h.m.onPolicyChange();
    expect(c.peer.closed).toBe(true);
    expect(v.peer.closed).toBe(false);
    h.setPolicy(undefined);
    await h.m.onPolicyChange();
    expect(v.peer.closed).toBe(true);
  });

  it("revoking a client ends its sessions only", async () => {
    const h = setup();
    const mine = await live(h);
    await h.m.endForClient("dev_other");
    expect(mine.peer.closed).toBe(false);
    await h.m.endForClient("dev_phone");
    expect(mine.peer.closed).toBe(true);
  });

  it("a remote bye or close from another browser", async () => {
    const h = setup();
    const { sid, peer } = await live(h);
    expect(await h.m.close(sid, "client:dev_laptop")).toEqual({ ok: false, reason: "origin_mismatch" });
    expect(await h.m.signal(sid, PHONE, { kind: "bye" })).toEqual({ ok: true });
    expect(peer.closed).toBe(true);
  });

  it("focuses or launches the app the browser asked for, after the approval", async () => {
    const launched: string[] = [];
    const h = setup({
      apps: { has: (a) => a === "chatgpt", focusOrLaunch: async (a) => (launched.push(a), { ok: true }) },
    });
    expect(await h.m.open({ origin: PHONE, mode: "view", appId: "notion" })).toEqual({
      ok: false,
      reason: "unknown_app",
    });
    await h.m.open({ origin: PHONE, mode: "view", appId: "chatgpt" });
    await tick();
    expect(launched).toEqual([]);
    await h.decide(true);
    expect(launched).toEqual(["chatgpt"]);
  });
});

describe("remote screen: local-only enable", () => {
  const holder = (initial?: Policy["screen"]) => {
    let p: Policy = { ...DEFAULT_POLICY, ...(initial ? { screen: initial } : {}) };
    return { get: () => p, set: async (n: Policy) => void (p = n) };
  };

  it("OS auth first, then two confirmations and the typed phrase; control implies view", async () => {
    const policy = holder();
    const emitted: string[] = [];
    const prompter = { first: async () => true, second: async () => true, typed: async () => "VIEW MY SCREEN" };
    const deny = { verify: async () => false };
    expect(await enableScreen({ policy, osAuth: deny, prompter, locale: "en", emit: () => undefined }, "view")).toEqual(
      { ok: false, reason: "os_auth_failed" },
    );
    const ok = { verify: async () => true };
    const wrong = { ...prompter, typed: async () => "view my screen" };
    expect(
      await enableScreen({ policy, osAuth: ok, prompter: wrong, locale: "en", emit: () => undefined }, "view"),
    ).toEqual({ ok: false, reason: "cancelled" });
    expect(screenLevel(policy.get().screen)).toBe("off");
    expect(
      await enableScreen({ policy, osAuth: ok, prompter, locale: "en", emit: (t) => void emitted.push(t) }, "view"),
    ).toEqual({ ok: true });
    expect(policy.get().screen).toEqual({ ...VIEW });
    const ctl = { ...prompter, typed: async () => SCREEN_COPY.en.control.phrase };
    await enableScreen({ policy, osAuth: ok, prompter: ctl, locale: "en", emit: () => undefined }, "control");
    expect(screenLevel(policy.get().screen)).toBe("control");
    expect(await disableScreen({ policy, emit: () => undefined }, "control", "cli")).toBe(true);
    expect(screenLevel(policy.get().screen)).toBe("view");
    expect(await disableScreen({ policy, emit: () => undefined }, "all", "cli")).toBe(true);
    expect(screenLevel(policy.get().screen)).toBe("off");
    expect(emitted).toEqual(["screen.enabled"]);
  });

  it("remote tightening can turn it off or lower limits, never on, up to control, or faster", () => {
    const cur: Policy = { ...DEFAULT_POLICY, screen: VIEW };
    expect(applyRemoteTighten(cur, { screen: { control: true } })).toEqual({ ok: false, reason: "would_loosen" });
    expect(applyRemoteTighten(cur, { screen: { maxFps: 15 } })).toEqual({ ok: false, reason: "would_loosen" });
    expect(applyRemoteTighten(cur, { screen: { view: false } })).toMatchObject({ ok: true });
    expect(applyRemoteTighten(cur, { screen: { maxFps: 2 } })).toMatchObject({ ok: true });
    const off: Policy = { ...DEFAULT_POLICY };
    expect(applyRemoteTighten(off, { screen: VIEW })).toEqual({ ok: false, reason: "would_loosen" });
    expect(isTighterOrEqual({ ...DEFAULT_POLICY, screen: CONTROL }, { ...DEFAULT_POLICY, screen: VIEW })).toBe(false);
  });
});

describe("remote screen: frames and ICE configuration", () => {
  it("chunks frames under the data-channel limit and reassembles only whole, newer frames", () => {
    const data = new Uint8Array(150_000).map((_, i) => i % 251);
    const chunks = chunkFrame(7, data);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.length <= SCREEN_CHUNK_MAX)).toBe(true);
    const asm = new FrameAssembler();
    expect(asm.push(chunks[2]!)).toBeNull();
    expect(asm.push(chunks[0]!)).toBeNull();
    expect(Buffer.from(asm.push(chunks[1]!)!).equals(Buffer.from(data))).toBe(true);
    // An older frame arriving late is ignored.
    expect(asm.push(chunkFrame(6, new Uint8Array(10))[0]!)).toBeNull();
  });

  it("encodes a downscaled JPEG", () => {
    const enc = encodeFrame({ width: 3200, height: 2000, rgba: new Uint8Array(3200 * 2000 * 4).fill(120) });
    expect([enc.width, enc.height]).toEqual([1600, 1000]);
    expect([...enc.jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
  });

  it("maps normalised input to the display's coordinates", () => {
    const d = { index: 1, name: "b", x: 1440, y: 0, width: 1920, height: 1080, scaleFactor: 1, primary: false };
    expect(toDisplay(d, 0, 0)).toEqual({ x: 1440, y: 0 });
    expect(toDisplay(d, 1, 1)).toEqual({ x: 1440 + 1919, y: 1079 });
    expect(toDisplay(d, 2, -1)).toEqual({ x: 1440 + 1919, y: 0 });
  });

  it("uses public STUN unless the owner configures TURN; bad values fall back", () => {
    expect(iceServersFrom({})).toEqual(DEFAULT_ICE_SERVERS);
    const turn = [{ urls: ["turns:turn.example.com:443"], username: "u", credential: "c" }];
    expect(iceServersFrom({ CHALITO_ICE_SERVERS: JSON.stringify(turn) })).toEqual(turn);
    expect(iceServersFrom({ CHALITO_ICE_SERVERS: "nope" })).toEqual(DEFAULT_ICE_SERVERS);
    expect(iceServersFrom({ CHALITO_ICE_SERVERS: JSON.stringify([{ urls: "http://evil" }]) })).toEqual(
      DEFAULT_ICE_SERVERS,
    );
  });
});
