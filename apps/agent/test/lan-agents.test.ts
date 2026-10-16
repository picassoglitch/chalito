/**
 * LAN direct path (ADR 0022 §5), end to end in one process: two real AgentCores of the same owner,
 * real WebSocket listeners on 127.0.0.1, the real handshake, in-memory discovery and a fake cloud
 * for tokens and the directory. Commands are signed by the owner's phone, which only agent B trusts.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "@chalito/adapters/claude-code";
import { fakeClaudeCode } from "@chalito/adapters/testing";
import { loadLiabilityText } from "@chalito/config";
import {
  MemoryNonceStore,
  TrustedClientList,
  deriveDeviceId,
  generateBoxKeyPair,
  generateSigningKeyPair,
  randomNonce,
  sealJson,
  signEnvelope,
  toB64url,
  type BoxKeyPair,
  type SigningKeyPair,
} from "@chalito/crypto";
import { AgentEvent, LAN_WS_PATH, type SignedCommand } from "@chalito/protocol";
import { AgentCore } from "../src/agent-core.js";
import { DevMode, DevModeStore } from "../src/devmode.js";
import { LanService } from "../src/lan/service.js";
import { dialHandshake } from "../src/lan/handshake.js";
import { MemoryDiscoveryHub } from "../src/lan/mdns.js";
import { lanTee } from "../src/lan/tee.js";
import { dialLan } from "../src/lan/ws.js";
import { DEFAULT_POLICY, applyRemoteTighten, type Policy } from "../src/policy/index.js";
import { createLogger } from "../src/redact.js";
import { MemoryStore } from "../src/store.js";
import { FakeLanCloud } from "./lan-fakes.js";

const OWNER = "hub-user-lan";
const WS = "/home/aldo/code/chalito";

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
};

interface Keys {
  id: string;
  sign: SigningKeyPair;
  box: BoxKeyPair;
  pubSign: string;
  pubBox: string;
}
const keys = async (): Promise<Keys> => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  return {
    id: await deriveDeviceId(sign.publicKey),
    sign,
    box,
    pubSign: await toB64url(sign.publicKey),
    pubBox: await toB64url(box.publicKey),
  };
};

const stops: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s().catch(() => undefined);
});

interface Node {
  k: Keys;
  core: AgentCore;
  store: MemoryStore;
  lan: LanService;
  peerEvents: AgentEvent[];
  logs: string[];
  policy: { lan?: Policy["lan"] };
  handled: string[];
}

const node = async (
  cloud: FakeLanCloud,
  hub: MemoryDiscoveryHub,
  o: {
    owner?: string;
    trusts?: Keys;
    k?: Keys;
    lan?: boolean;
    slow?: () => boolean;
    addresses?: string[];
    dialDeadlineMs?: number;
  } = {},
): Promise<Node> => {
  const k = o.k ?? (await keys());
  const owner = o.owner ?? OWNER;
  cloud.devices.push({ owner, deviceId: k.id, pubSign: k.pubSign });
  const trust = new TrustedClientList(k.id);
  if (o.trusts)
    await trust.addConfirmed({ deviceId: o.trusts.id, pubSign: o.trusts.pubSign, pubBox: o.trusts.pubBox }, Date.now());
  const store = new MemoryStore();
  const logs: string[] = [];
  const log = createLogger((l) => logs.push(l));
  const policy: Policy = {
    ...DEFAULT_POLICY,
    workspaces: [{ label: "chalito", path: WS }],
    lan: { enabled: o.lan ?? true, port: 0 },
  };
  let lan: LanService | null = null;
  const fake = fakeClaudeCode([[]]);
  const liability = loadLiabilityText("es");
  const core = new AgentCore({
    store: lanTee(store, () => lan),
    adapters: { "claude-code": new ClaudeCodeAdapter({ apiKey: "sk-ant-test", queryFn: fake.queryFn, env: {} }) },
    policy: { get: () => policy, set: async () => undefined },
    devMode: new DevMode({
      store: new DevModeStore(mkdtempSync(join(tmpdir(), "lan-dm-")), k.sign, k.id),
      osAuth: { verify: async () => false },
      prompter: {
        first: async () => false,
        second: async () => false,
        liability: async () => ({ checked: false, typed: "" }),
      },
      liability,
      deviceId: k.id,
      now: Date.now,
      emit: async () => undefined,
    }),
    trust: () => trust,
    saveTrust: async () => undefined,
    nonces: new MemoryNonceStore(),
    owner,
    self: { deviceId: k.id, pubBox: k.pubBox, box: k.box, sign: k.sign },
    home: "/home/aldo",
    locale: () => "es",
    now: Date.now,
    log,
  });
  const handled: string[] = [];
  const peerEvents: AgentEvent[] = [];
  lan = new LanService({
    self: { deviceId: k.id, sign: k.sign },
    cloud: cloud.for(owner, k.id),
    discovery: async () => hub.join(o.addresses ?? ["127.0.0.1"]),
    policy: () => policy.lan,
    handleCommand: async (id, doc) => {
      while (o.slow?.()) await new Promise((r) => setTimeout(r, 10));
      const r = await core.handleCommand(id, doc);
      handled.push(`${id}:${r.ok ? "ok" : r.reason}`);
      return r;
    },
    onPeerEvent: (_from, e) => peerEvents.push(e),
    now: Date.now,
    log,
    host: "127.0.0.1",
    ackTimeoutMs: 300,
    every: () => ({ clear: () => undefined }),
    ...(o.dialDeadlineMs !== undefined ? { dialDeadlineMs: o.dialDeadlineMs } : {}),
  });
  // The cloud path, as the daemon wires it.
  store.watchCommands(
    (id, doc) => void core.handleCommand(id, doc).then((r) => handled.push(`${id}:${r.ok ? "ok" : r.reason}`)),
  );
  await lan.onPolicyChange();
  const n: Node = { k, core, store, lan, peerEvents, logs, policy, handled };
  stops.push(async () => {
    await lan.stop();
    for (const s of core.sessions.values()) s.handle.close();
  });
  return n;
};

let seq = 0;
const command = async (
  phone: Keys,
  target: Keys,
  over: { uid?: string } = {},
): Promise<{ id: string; env: SignedCommand }> => {
  const cid = `lan${++seq}`;
  const body = {
    v: 1 as const,
    cid,
    uid: over.uid ?? OWNER,
    targetDeviceId: target.id,
    origin: `client:${phone.id}`,
    nonce: await randomNonce(),
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    payload: {
      type: "session.start" as const,
      adapter: "claude-code" as const,
      workspaceLabel: "chalito",
      promptCt: await sealJson("hola", { [target.id]: target.box.publicKey }, `command:${cid}`),
      permissionMode: "default" as const,
    },
  };
  return {
    id: cid,
    env: (await signEnvelope("chalito.command.v1", body, phone.id, phone.sign.secretKey)) as SignedCommand,
  };
};

/** A and B with B trusting the phone; ids ordered so A (the lower) dials. */
const pair = async (o: { bSlow?: () => boolean } = {}) => {
  const cloud = new FakeLanCloud();
  const hub = new MemoryDiscoveryHub();
  const phone = await keys();
  let [ka, kb] = [await keys(), await keys()];
  if (ka.id > kb.id) [ka, kb] = [kb, ka];
  const b = await node(cloud, hub, { k: kb, trusts: phone, ...(o.bSlow ? { slow: o.bSlow } : {}) });
  const a = await node(cloud, hub, { k: ka });
  await waitFor(() => a.lan.peers().includes(kb.id) && b.lan.peers().includes(ka.id));
  return { a, b, phone, cloud, hub };
};

describe("LAN direct path: two agents of the same owner", () => {
  it("authenticates over the LAN and runs a signed command with the cloud path's checks", async () => {
    const { a, b, phone } = await pair();
    const cmd = await command(phone, b.k);
    let cloudUsed = false;
    const r = await a.lan.sendCommand(b.k.id, cmd.id, cmd.env, async () => void (cloudUsed = true));
    expect(r).toMatchObject({ via: "lan", ok: true });
    expect(cloudUsed).toBe(false);
    expect(b.core.sessions.size).toBe(1);
    // The durable records still went to B's cloud store; A got the live copy over the link.
    expect(b.store.events.some((e) => e.type === "session.started")).toBe(true);
    expect(b.store.audits.some((x) => x.type === "command.accepted")).toBe(true);
    await waitFor(() => a.peerEvents.some((e) => e.type === "session.started" && e.deviceId === b.k.id));
  });

  it("a command the receiver doesn't trust is refused exactly as on the cloud path", async () => {
    const { a, b } = await pair();
    const stranger = await keys();
    const cmd = await command(stranger, b.k);
    const r = await a.lan.sendCommand(b.k.id, cmd.id, cmd.env, async () => undefined);
    expect(r).toMatchObject({ via: "lan", ok: false, reason: "untrusted_signer" });
    expect(b.core.sessions.size).toBe(0);
  });

  it("refuses replays: the same command twice over the LAN, and one the cloud already delivered", async () => {
    const { a, b, phone } = await pair();
    const cmd = await command(phone, b.k);
    expect(await a.lan.sendCommand(b.k.id, cmd.id, cmd.env, async () => undefined)).toMatchObject({ ok: true });
    expect(await a.lan.sendCommand(b.k.id, cmd.id, cmd.env, async () => undefined)).toMatchObject({
      via: "lan",
      ok: false,
      reason: "replayed_nonce",
    });
    const viaCloud = await command(phone, b.k);
    b.store.sendCommand(viaCloud.id, { env: viaCloud.env });
    await waitFor(() => b.handled.includes(`${viaCloud.id}:ok`));
    expect(await a.lan.sendCommand(b.k.id, viaCloud.id, viaCloud.env, async () => undefined)).toMatchObject({
      ok: false,
      reason: "replayed_nonce",
    });
    expect(b.core.sessions.size).toBe(2);
  });

  it("rejects an agent of another owner (its token is unknown here), and never dials it", async () => {
    const { a, b, cloud, hub } = await pair();
    const other = await node(cloud, hub, { owner: "someone-else" });
    await new Promise((r) => setTimeout(r, 100));
    expect(a.lan.peers()).toEqual([b.k.id]);
    expect(other.lan.peers()).toEqual([]);
    // It dials A directly with its own owner's token: refused in the handshake.
    const conn = await dialLan(`ws://127.0.0.1:${a.lan.port}${LAN_WS_PATH}`, 1 << 20, 1000);
    await expect(
      dialHandshake(
        conn,
        {
          deviceId: other.k.id,
          sign: other.k.sign,
          tokens: () => [],
          peerKey: () => a.k.pubSign,
          now: Date.now,
        },
        await cloud.token("someone-else"),
        a.k.id,
        1000,
      ),
    ).rejects.toThrow();
    await waitFor(() => a.logs.some((l) => l.includes("lan.auth_failed") && l.includes("unknown_token")));
    expect(a.lan.peers()).toEqual([b.k.id]);
  });

  it("rejects a device holding this owner's token that the directory doesn't list", async () => {
    const { a, cloud } = await pair();
    const mallory = await keys();
    const conn = await dialLan(`ws://127.0.0.1:${a.lan.port}${LAN_WS_PATH}`, 1 << 20, 1000);
    // Its side of the handshake can finish (it speaks last); A refuses it and closes.
    const link = await dialHandshake(
      conn,
      { deviceId: mallory.id, sign: mallory.sign, tokens: () => [], peerKey: () => a.k.pubSign, now: Date.now },
      await cloud.token(OWNER),
      a.k.id,
      1000,
    ).catch(() => null);
    let closed = link === null;
    link?.onClose(() => (closed = true));
    await waitFor(() => closed);
    await waitFor(() => a.logs.some((l) => l.includes("lan.auth_failed") && l.includes("not_in_directory")));
    expect(a.lan.peers()).not.toContain(mallory.id);
  });

  it("falls back to the cloud when there is no link (LAN off on the other agent)", async () => {
    const cloud = new FakeLanCloud();
    const hub = new MemoryDiscoveryHub();
    const phone = await keys();
    const b = await node(cloud, hub, { trusts: phone, lan: false });
    const a = await node(cloud, hub);
    await new Promise((r) => setTimeout(r, 50));
    expect(a.lan.peers()).toEqual([]);
    const cmd = await command(phone, b.k);
    const r = await a.lan.sendCommand(b.k.id, cmd.id, cmd.env, async () =>
      b.store.sendCommand(cmd.id, { env: cmd.env }),
    );
    expect(r.via).toBe("cloud");
    await waitFor(() => b.handled.includes(`${cmd.id}:ok`));
  });

  it("falls back to the cloud when the peer doesn't answer, and the late duplicate is refused", async () => {
    let slow = true;
    const { a, b, phone } = await pair({ bSlow: () => slow });
    const cmd = await command(phone, b.k);
    const r = await a.lan.sendCommand(b.k.id, cmd.id, cmd.env, async () => {
      slow = false; // the cloud copy arrives while the LAN one is still queued
      b.store.sendCommand(cmd.id, { env: cmd.env });
    });
    expect(r.via).toBe("cloud");
    await waitFor(() => b.handled.length === 2);
    expect(b.handled.sort()).toEqual([`${cmd.id}:ok`, `${cmd.id}:replayed_nonce`].sort());
    expect(b.core.sessions.size).toBe(1);
  });

  it("falls back to the cloud when the link drops, and turning LAN off locally ends links", async () => {
    const { a, b, phone } = await pair();
    b.policy.lan = { enabled: false, port: 0 };
    await b.lan.onPolicyChange();
    await waitFor(() => a.lan.peers().length === 0);
    const cmd = await command(phone, b.k);
    const r = await a.lan.sendCommand(b.k.id, cmd.id, cmd.env, async () =>
      b.store.sendCommand(cmd.id, { env: cmd.env }),
    );
    expect(r.via).toBe("cloud");
    await waitFor(() => b.handled.includes(`${cmd.id}:ok`));
  });

  it("drops the link when the directory revokes the peer", async () => {
    const { a, b, cloud } = await pair();
    cloud.devices.find((d) => d.deviceId === b.k.id)!.revoked = true;
    await a.lan.tick();
    await waitFor(() => a.lan.peers().length === 0);
    expect(a.logs.some((l) => l.includes("lan.link_down") && l.includes("peer_revoked"))).toBe(true);
  });

  it("stays off without a token from the cloud", async () => {
    const cloud = new FakeLanCloud();
    cloud.fail = true;
    const n = await node(cloud, new MemoryDiscoveryHub());
    expect(n.lan.running).toBe(false);
    expect(n.lan.port).toBeNull();
  });
});

describe("LAN dialing limits", () => {
  /** B advertises `addresses` (its real one is 127.0.0.1); A, the lower id, dials. */
  const flood = async (addresses: string[], dialDeadlineMs?: number) => {
    const cloud = new FakeLanCloud();
    const hub = new MemoryDiscoveryHub();
    let [ka, kb] = [await keys(), await keys()];
    if (ka.id > kb.id) [ka, kb] = [kb, ka];
    const b = await node(cloud, hub, { k: kb, addresses });
    const a = await node(cloud, hub, { k: ka, ...(dialDeadlineMs !== undefined ? { dialDeadlineMs } : {}) });
    return { a, b };
  };

  it("an mDNS answer with many addresses: at most 4 are dialled", async () => {
    // Ten loopback addresses nobody listens on, then the real one (never reached).
    const fake = Array.from({ length: 10 }, (_, i) => `127.0.0.${i + 2}`);
    const { a, b } = await flood([...fake, "127.0.0.1"]);
    await waitFor(() => a.logs.filter((l) => l.includes("lan.connect_failed")).length >= 4);
    await new Promise((r) => setTimeout(r, 100));
    expect(a.logs.filter((l) => l.includes("lan.connect_failed"))).toHaveLength(4);
    expect(a.lan.peers()).not.toContain(b.k.id);
  });

  it("all of a peer's addresses are tried within one deadline", async () => {
    const { a, b } = await flood(["127.0.0.1"], 0);
    await waitFor(() => a.logs.some((l) => l.includes("lan.dial_deadline")));
    expect(a.lan.peers()).not.toContain(b.k.id);
  });

  it("frames above the pre-auth size flow once the link is up", async () => {
    const { a, b } = await pair();
    const sid = randomUUID();
    const e = AgentEvent.parse({
      v: 1,
      eid: randomUUID(),
      type: "message.assistant",
      deviceId: b.k.id,
      sid,
      seq: 1,
      t: Date.now(),
      ct: await sealJson("x".repeat(20_000), { [a.k.id]: a.k.box.publicKey }, `event:${sid}`),
    });
    expect(JSON.stringify(e).length).toBeGreaterThan(4096);
    b.lan.broadcastEvent(e);
    await waitFor(() => a.peerEvents.some((x) => x.sid === sid));
    expect(a.lan.peers()).toContain(b.k.id);
  });
});

describe("LAN policy", () => {
  it("remote surfaces can turn LAN off but never on", () => {
    const base: Policy = { ...DEFAULT_POLICY };
    expect(applyRemoteTighten(base, { lan: { enabled: true, port: 0 } })).toMatchObject({
      ok: false,
      reason: "would_loosen",
    });
    const on: Policy = { ...DEFAULT_POLICY, lan: { enabled: true, port: 0 } };
    expect(applyRemoteTighten(on, { lan: { enabled: false } })).toMatchObject({ ok: true });
    expect(applyRemoteTighten(on, { lan: { port: 4000 } })).toMatchObject({ ok: false, reason: "would_loosen" });
  });
});
