/**
 * Hand-off pairing (ADR 0028 §3–§4): the network check is enforced by the api, not only shown on
 * the approval screen. From another network a claim must carry the short code typed from the
 * computer; the hand-off view never leaks the short code; decline cancels the code; every
 * pairing raises a security alert for the whole account.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  deriveDeviceId,
  fingerprint,
  generateBoxKeyPair,
  generateSigningKeyPair,
  randomNonce,
  signEnvelope,
  toB64url,
  type BoxKeyPair,
  type SigningKeyPair,
} from "@chalito/crypto";
import { signGlyph } from "@chalito/glyph";
import {
  PAIRING_TTL_MS,
  PairingHandoffResponse,
  pairingApproveUrl,
  type DeviceDoc,
  type PairingCodeDoc,
} from "@chalito/protocol";
import { MemoryAudit, type Deps } from "../src/deps.js";
import { compareNetworks, networkOf, pairingApproval, pairingNet } from "../src/lib/pairing-network.js";
import type { ApiRepo } from "../src/repo.js";
import type { PairingNet } from "../src/lib/pairing-network.js";
import { pairingRoutes } from "../src/routes/pairing.js";
import { device, owner } from "./contract/fixtures.js";

const NOW = 1_790_000_000_000;
const HOME = "189.203.10.20";
const CAFE = "201.141.7.8";

interface Keys {
  deviceId: string;
  sign: SigningKeyPair;
  box: BoxKeyPair;
}
const keys = async (): Promise<Keys> => {
  const sign = await generateSigningKeyPair();
  return { deviceId: await deriveDeviceId(sign.publicKey), sign, box: await generateBoxKeyPair() };
};

/** The pairing slice of ApiRepo, in memory (same semantics as PostgresRepo). */
const memoryRepo = (devices: DeviceDoc[]) => {
  const codes = new Map<string, PairingCodeDoc>();
  const nets = new Map<string, PairingNet>();
  const viewers = new Set<string>();
  const notifications: Record<string, unknown>[] = [];
  const repo: Partial<ApiRepo> = {
    getDevice: async (o, id) => devices.find((d) => d.owner === o && d.deviceId === id) ?? null,
    getDeviceWebAuthn: async () => null,
    createPairingCode: async (doc, net) => {
      if (codes.has(doc.codeId)) return "exists";
      codes.set(doc.codeId, doc);
      if (net) nets.set(doc.codeId, net);
      return "created";
    },
    findPairingCodeByShortHash: async (h) => [...codes.values()].find((c) => c.shortCodeHash === h) ?? null,
    getPairingCode: async (id) => {
      const doc = codes.get(id);
      return doc ? { doc, net: nets.get(id) ?? null } : null;
    },
    recordPairingViewer: async (id, o, d) => void viewers.add(`${id}/${o}/${d}`),
    isPairingViewer: async (id, o, d) => viewers.has(`${id}/${o}/${d}`),
    cancelPairingCode: async (id) => {
      const doc = codes.get(id);
      if (!doc) return "not_found";
      if (doc.claimed) return "already_claimed";
      codes.set(id, { ...doc, cancelled: true });
      nets.delete(id);
      return "cancelled";
    },
    claimPairingCode: async (id, claim, build) => {
      const doc = codes.get(id);
      if (!doc) return { ok: false, reason: "not_found" };
      if (doc.claimed) return { ok: false, reason: "already_claimed" };
      if (doc.cancelled) return { ok: false, reason: "cancelled" };
      const agent = await build(doc);
      devices.push(agent);
      codes.set(id, { ...doc, claimed: true, owner: claim.owner, claimedByDeviceId: claim.claimedByDeviceId });
      nets.delete(id);
      return { ok: true, agentDeviceId: agent.deviceId };
    },
    createNotification: async (o, nid, d) => void notifications.push({ owner: o, nid, ...d }),
  };
  return { repo: repo as ApiRepo, codes, nets, viewers, notifications };
};

const setup = async (opts: { trustedProxies?: number } = {}) => {
  const o = owner();
  const phone = await keys();
  const tablet = await keys();
  const stranger = await keys();
  const other = owner();
  const computer = await keys();
  const pub = async (k: Keys) => ({
    pubSign: await toB64url(k.sign.publicKey),
    pubBox: await toB64url(k.box.publicKey),
  });
  const devices = [
    { ...(await device(o, "client")), deviceId: phone.deviceId, ...(await pub(phone)) },
    { ...(await device(o, "client")), deviceId: tablet.deviceId, ...(await pub(tablet)) },
    { ...(await device(other, "client")), deviceId: stranger.deviceId, ...(await pub(stranger)) },
  ];
  const mem = memoryRepo(devices);
  const audit = new MemoryAudit();
  const tokens: Record<string, { uid: string; role: string; owner: string; deviceId?: string }> = {
    phone: { uid: `d_${phone.deviceId}`, role: "client", owner: o, deviceId: phone.deviceId },
    tablet: { uid: `d_${tablet.deviceId}`, role: "client", owner: o, deviceId: tablet.deviceId },
    stranger: { uid: `d_${stranger.deviceId}`, role: "client", owner: other, deviceId: stranger.deviceId },
    person: { uid: o, role: "user", owner: o },
  };
  const deps: Deps = {
    repo: mem.repo,
    identity: {
      verify: async (t: string) => {
        const c = tokens[t];
        if (!c) throw new Error("bad token");
        return c;
      },
      mintPairingWatch: async (codeId: string) => `watch-${codeId}`,
    } as unknown as Deps["identity"],
    audit,
    config: {
      ssoSecret: "s",
      adminToken: "a",
      recoveryCooldownMs: 1,
      skewMs: 60_000,
      ...(opts.trustedProxies ? { trustedProxies: opts.trustedProxies } : {}),
    },
    now: () => NOW,
  };
  const app = new Hono().route("/v1/pairing", pairingRoutes(deps));
  const post = async (path: string, body: unknown, opts: { token?: string; ip: string; city?: string }) => {
    const res = await app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": opts.ip,
        ...(opts.city ? { "x-client-geo-city": opts.city } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, any> };
  };
  const get = async (path: string) => {
    const res = await app.request(path, { method: "GET", headers: { authorization: "Bearer phone" } });
    return { status: res.status };
  };
  /** The computer publishes a code with this code id. */
  const askWith = async (codeId: string, ip = HOME, city?: string) => {
    const glyph = await signGlyph(
      {
        v: 1,
        purpose: "pair_device",
        codeId,
        issuerPubSign: (await pub(computer)).pubSign,
        issuerPubBox: (await pub(computer)).pubBox,
        label: "MacBook de Ana",
        issuedAt: NOW,
        expiresAt: NOW + PAIRING_TTL_MS,
        nonce: await randomNonce(),
      } as never,
      computer.sign.secretKey,
    );
    const r = await post(
      "/v1/pairing/codes",
      { glyph, kind: "laptop", platform: "macos" },
      { ip, ...(city ? { city } : {}) },
    );
    return { ...r, codeId: glyph.body.codeId };
  };
  /** The computer asks for a code from `ip` (what `chalito pair` and the panel do). */
  const ask = async (ip = HOME, city?: string) => {
    const glyph = await signGlyph(
      {
        v: 1,
        purpose: "pair_device",
        codeId: await randomNonce(),
        issuerPubSign: (await pub(computer)).pubSign,
        issuerPubBox: (await pub(computer)).pubBox,
        label: "MacBook de Ana",
        issuedAt: NOW,
        expiresAt: NOW + PAIRING_TTL_MS,
        nonce: await randomNonce(),
      } as never,
      computer.sign.secretKey,
    );
    const r = await post(
      "/v1/pairing/codes",
      { glyph, kind: "laptop", platform: "macos" },
      { ip, ...(city ? { city } : {}) },
    );
    expect(r.status).toBe(201);
    return { codeId: glyph.body.codeId, shortCode: r.json.shortCode as string };
  };
  const claimBody = async (codeId: string, shortCode?: string) => ({
    claim: await signEnvelope(
      "chalito.pairing-claim.v1",
      {
        v: 1,
        owner: o,
        codeId,
        agentDeviceId: computer.deviceId,
        agentFingerprint: await fingerprint(computer.sign.publicKey),
        claimerDeviceId: phone.deviceId,
        issuedAt: NOW,
      },
      phone.deviceId,
      phone.sign.secretKey,
    ),
    ...(shortCode ? { shortCode } : {}),
  });
  return { o, mem, audit, post, get, ask, askWith, claimBody, computer };
};

describe("network of an address", () => {
  it("IPv4 as is, IPv4-mapped IPv6 as IPv4, IPv6 by its /64, anything else null", () => {
    expect(networkOf("189.203.10.20")).toEqual({ family: 4, net: "189.203.10.20" });
    expect(networkOf("::ffff:189.203.10.20")).toEqual({ family: 4, net: "189.203.10.20" });
    expect(networkOf("2806:10a6:1:2:aaaa:bbbb:cccc:dddd")).toEqual({ family: 6, net: "2806:10a6:1:2" });
    expect(networkOf("2806:10a6:1:2::1")).toEqual(networkOf("2806:10a6:0001:0002:ffff::9"));
    expect(networkOf("[2806:10a6:1:2::1]")).toEqual({ family: 6, net: "2806:10a6:1:2" });
    for (const bad of ["local", "", "999.1.1.1", "not-an-ip"]) expect(networkOf(bad)).toBeNull();
  });

  it("compares by keyed hash; another family or no record is unknown", () => {
    const a = pairingNet(HOME, "k");
    expect(a?.netHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.netHash).not.toContain("189");
    expect(compareNetworks(a, pairingNet(HOME, "k"))).toBe("same");
    expect(compareNetworks(a, pairingNet(CAFE, "k"))).toBe("different");
    expect(compareNetworks(a, pairingNet("2806:10a6:1:2::1", "k"))).toBe("unknown");
    expect(compareNetworks(null, a)).toBe("unknown");
    expect(compareNetworks(pairingNet("2806:10a6:1:2::1", "k"), pairingNet("2806:10a6:1:2::99", "k"))).toBe("same");
  });

  it("one policy decides a mismatch: the code by default, or blocked", () => {
    expect(pairingApproval("same")).toBe("one_tap");
    expect(pairingApproval("different")).toBe("code_required");
    expect(pairingApproval("unknown")).toBe("code_required");
    expect(pairingApproval("different", "block")).toBe("blocked");
    expect(pairingApproval("same", "block")).toBe("one_tap");
  });

  it("the approval link carries the code id in the fragment", () => {
    expect(pairingApproveUrl("https://www.chalyb.com/app/chalito/", "abc_DEF-123")).toBe(
      "https://www.chalyb.com/app/chalito/computadoras/aprobar#c=abc_DEF-123",
    );
  });
});

describe("POST /v1/pairing/handoff", () => {
  it("shows what would be approved, never the short code or its hash", async () => {
    const s = await setup();
    const { codeId, shortCode } = await s.ask(HOME);
    const r = await s.post("/v1/pairing/handoff", { codeId }, { token: "phone", ip: HOME });
    expect(r.status).toBe(200);
    expect(PairingHandoffResponse.parse(r.json)).toMatchObject({ network: "same", approval: "one_tap", city: null });
    const text = JSON.stringify(r.json);
    expect(text).not.toContain(shortCode);
    expect(text).not.toContain(s.mem.codes.get(codeId)!.shortCodeHash);
    expect(r.json).not.toHaveProperty("shortCodeHash");
    expect(r.json).not.toHaveProperty("claimerPubSign");
  });

  it("from another network: code required, with the computer's coarse city from the load balancer", async () => {
    const s = await setup({ trustedProxies: 1 });
    const { codeId } = await s.ask(HOME, "Guadalajara");
    const r = await s.post("/v1/pairing/handoff", { codeId }, { token: "phone", ip: CAFE });
    expect(r.json).toMatchObject({ network: "different", approval: "code_required", city: "Guadalajara" });
  });

  it("without a load balancer a city header is the client's own claim, so it's ignored", async () => {
    const s = await setup();
    const { codeId } = await s.ask(HOME, "Guadalajara");
    const r = await s.post("/v1/pairing/handoff", { codeId }, { token: "phone", ip: CAFE });
    expect(r.json).toMatchObject({ network: "different", city: null });
  });

  it("needs a signed-in client; unknown, claimed, declined or expired codes are 404", async () => {
    const s = await setup();
    const { codeId } = await s.ask();
    expect((await s.post("/v1/pairing/handoff", { codeId }, { ip: HOME })).status).toBe(401);
    expect((await s.post("/v1/pairing/handoff", { codeId }, { token: "person", ip: HOME })).status).toBe(403);
    expect(
      (await s.post("/v1/pairing/handoff", { codeId: "nope_nope_nope" }, { token: "phone", ip: HOME })).status,
    ).toBe(404);
    s.mem.codes.set(codeId, { ...s.mem.codes.get(codeId)!, expiresAt: NOW });
    expect((await s.post("/v1/pairing/handoff", { codeId }, { token: "phone", ip: HOME })).status).toBe(404);
  });

  it("is rate-limited", async () => {
    const s = await setup();
    const { codeId } = await s.ask();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++)
      statuses.push((await s.post("/v1/pairing/handoff", { codeId }, { token: "phone", ip: CAFE })).status);
    expect(statuses).toContain(429);
  });
});

describe("POST /v1/pairing/claim: the network check is server-side", () => {
  it("same network: one tap, no code needed", async () => {
    const s = await setup();
    const { codeId } = await s.ask(HOME);
    const r = await s.post("/v1/pairing/claim", await s.claimBody(codeId), { token: "phone", ip: HOME });
    expect(r.status).toBe(200);
    expect(r.json.agentDeviceId).toBe(s.computer.deviceId);
  });

  it("another network without the code: refused, nothing created", async () => {
    const s = await setup();
    const { codeId } = await s.ask(HOME);
    const r = await s.post("/v1/pairing/claim", await s.claimBody(codeId), { token: "phone", ip: CAFE });
    expect(r).toMatchObject({ status: 403, json: { error: "code_required" } });
    expect(s.mem.codes.get(codeId)!.claimed).toBe(false);
    expect(s.mem.notifications).toEqual([]);
  });

  it("another network with a wrong code: refused", async () => {
    const s = await setup();
    const { codeId } = await s.ask(HOME);
    const r = await s.post("/v1/pairing/claim", await s.claimBody(codeId, "ZZZZ-ZZZZ"), { token: "phone", ip: CAFE });
    expect(r).toMatchObject({ status: 403, json: { error: "code_required" } });
  });

  it("another network with the typed code (any case, spaces): allowed", async () => {
    const s = await setup();
    const { codeId, shortCode } = await s.ask(HOME);
    const typed = ` ${shortCode.toLowerCase().replace("-", " ")} `;
    const r = await s.post("/v1/pairing/claim", await s.claimBody(codeId, typed), { token: "phone", ip: CAFE });
    expect(r.status).toBe(200);
  });

  it("IPv4 computer, IPv6 browser (can't compare): the code is required", async () => {
    const s = await setup();
    const { codeId } = await s.ask(HOME);
    const r = await s.post("/v1/pairing/claim", await s.claimBody(codeId), { token: "phone", ip: "2806:10a6:1:2::1" });
    expect(r).toMatchObject({ status: 403, json: { error: "code_required" } });
  });

  it("a declined code can't be claimed, even from the same network", async () => {
    const s = await setup();
    const { codeId } = await s.ask(HOME);
    await s.post("/v1/pairing/handoff", { codeId }, { token: "phone", ip: HOME });
    expect((await s.post("/v1/pairing/decline", { codeId }, { token: "phone", ip: HOME })).status).toBe(200);
    const r = await s.post("/v1/pairing/claim", await s.claimBody(codeId), { token: "phone", ip: HOME });
    expect(r).toMatchObject({ status: 410, json: { error: "cancelled" } });
  });

  it("every pairing alerts all of the account's devices (security, revoke from Dispositivos)", async () => {
    const s = await setup();
    const { codeId } = await s.ask(HOME);
    await s.post("/v1/pairing/claim", await s.claimBody(codeId), { token: "phone", ip: HOME });
    expect(s.mem.notifications).toEqual([
      expect.objectContaining({
        owner: s.o,
        source: "security",
        level: "L2",
        deepLink: "/dispositivos",
        coalesceKey: `security:pairing:${s.computer.deviceId}`,
        channels: ["desktop", "push"],
      }),
    ]);
    expect(s.audit.events).toContainEqual(
      expect.objectContaining({ action: "pairing.claimed", meta: { approval: "one_tap" } }),
    );
  });
});

describe("POST /v1/pairing/decline", () => {
  it("cancels an open code the client opened, and drops its network record", async () => {
    const s = await setup();
    const { codeId } = await s.ask(HOME);
    expect(s.mem.nets.has(codeId)).toBe(true);
    await s.post("/v1/pairing/handoff", { codeId }, { token: "phone", ip: CAFE });
    const r = await s.post("/v1/pairing/decline", { codeId }, { token: "phone", ip: CAFE });
    expect(r).toMatchObject({ status: 200, json: { ok: true } });
    expect(s.mem.codes.get(codeId)!.cancelled).toBe(true);
    expect(s.mem.nets.has(codeId)).toBe(false);
    expect(s.audit.events).toContainEqual(expect.objectContaining({ action: "pairing.declined" }));
  });

  it("knowing the code id isn't enough: only a client that opened the code may decline it", async () => {
    const s = await setup();
    const { codeId, shortCode } = await s.ask(HOME);
    await s.post("/v1/pairing/handoff", { codeId }, { token: "phone", ip: HOME });
    for (const token of ["stranger", "tablet"]) {
      const r = await s.post("/v1/pairing/decline", { codeId }, { token, ip: CAFE });
      expect(r, token).toMatchObject({ status: 403, json: { error: "not_opened" } });
    }
    expect(s.mem.codes.get(codeId)!.cancelled).toBe(false);
    // Typing the code opens it too (the phone path).
    await s.post("/v1/pairing/resolve", { shortCode }, { token: "tablet", ip: CAFE });
    expect((await s.post("/v1/pairing/decline", { codeId }, { token: "tablet", ip: CAFE })).status).toBe(200);
  });

  it("needs a signed-in client; a claimed or unknown code is 404", async () => {
    const s = await setup();
    const { codeId } = await s.ask(HOME);
    expect((await s.post("/v1/pairing/decline", { codeId }, { ip: HOME })).status).toBe(401);
    await s.post("/v1/pairing/handoff", { codeId }, { token: "phone", ip: HOME });
    await s.post("/v1/pairing/claim", await s.claimBody(codeId), { token: "phone", ip: HOME });
    expect((await s.post("/v1/pairing/decline", { codeId }, { token: "phone", ip: HOME })).status).toBe(404);
    expect(
      (await s.post("/v1/pairing/decline", { codeId: "nope_nope_nope" }, { token: "phone", ip: HOME })).status,
    ).toBe(404);
  });

  it("is limited per client", async () => {
    const s = await setup();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++)
      statuses.push(
        (await s.post("/v1/pairing/decline", { codeId: `unknown_code_${i}` }, { token: "phone", ip: CAFE })).status,
      );
    expect(statuses.slice(0, 5)).toEqual([404, 404, 404, 404, 404]);
    expect(statuses).toContain(429);
  });

  it("and per code, from any number of clients and networks", async () => {
    const s = await setup();
    const { codeId } = await s.ask(HOME);
    const statuses: number[] = [];
    const ips = ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4", "198.51.100.5"];
    for (const [i, ip] of ips.entries())
      statuses.push(
        (await s.post("/v1/pairing/decline", { codeId }, { token: i % 2 ? "stranger" : "tablet", ip })).status,
      );
    expect(statuses).toEqual([403, 403, 403, 429, 429]);
    expect(s.mem.codes.get(codeId)!.cancelled).toBe(false);
  });
});

describe("the code id is a capability", () => {
  it("the computer can't publish a guessable code id (under 128 bits)", async () => {
    const s = await setup();
    const r = await s.askWith("short_id_123");
    expect(r).toMatchObject({ status: 400, json: { error: "weak_code_id" } });
  });

  it("unknown, claimed, declined and expired codes answer the same 404", async () => {
    const s = await setup();
    const claimed = await s.ask(HOME);
    await s.post("/v1/pairing/claim", await s.claimBody(claimed.codeId), { token: "phone", ip: HOME });
    const declined = await s.ask(HOME);
    await s.post("/v1/pairing/handoff", { codeId: declined.codeId }, { token: "phone", ip: HOME });
    await s.post("/v1/pairing/decline", { codeId: declined.codeId }, { token: "phone", ip: HOME });
    const expired = await s.ask(HOME);
    s.mem.codes.set(expired.codeId, { ...s.mem.codes.get(expired.codeId)!, expiresAt: NOW });
    const bodies = [];
    for (const codeId of ["A".repeat(22), claimed.codeId, declined.codeId, expired.codeId])
      bodies.push(await s.post("/v1/pairing/handoff", { codeId }, { token: "tablet", ip: HOME }));
    expect(new Set(bodies.map((b) => JSON.stringify(b)))).toEqual(new Set([JSON.stringify(bodies[0])]));
    expect(bodies[0]).toMatchObject({ status: 404, json: { error: "not_found" } });
  });

  it("there is no route that lists codes, and the audit log never holds a code id", async () => {
    const s = await setup();
    const { codeId } = await s.ask(HOME);
    for (const path of ["/v1/pairing/codes", "/v1/pairing", "/v1/pairing/handoff"]) {
      const r = await s.get(path);
      expect([404, 405], path).toContain(r.status);
    }
    await s.post("/v1/pairing/handoff", { codeId }, { token: "phone", ip: HOME });
    await s.post("/v1/pairing/decline", { codeId }, { token: "phone", ip: HOME });
    expect(JSON.stringify(s.audit.events)).not.toContain(codeId);
  });
});

describe("POST /v1/pairing/resolve (typed code)", () => {
  it("returns the same view, flagged from another network", async () => {
    const s = await setup();
    const { shortCode } = await s.ask(HOME);
    const r = await s.post("/v1/pairing/resolve", { shortCode }, { token: "phone", ip: CAFE });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ network: "different", approval: "code_required" });
  });
});
