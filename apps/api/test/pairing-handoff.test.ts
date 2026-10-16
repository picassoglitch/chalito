/**
 * Hand-off pairing (ADR 0028 §3–§4, owner decision #52). One tap only with the agent's loopback
 * proof that the approving browser runs on that computer; otherwise the short code typed from
 * the computer (at /claim, or earlier at /resolve). The public network is warning text only. The
 * hand-off view never leaks the short code; decline is bound to a client that opened the code;
 * the computer can withdraw its own code; every pairing alerts the account.
 */
import { createHash } from "node:crypto";
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
import { PAIRING_NONCE_TTL_MS, pairingRoutes } from "../src/routes/pairing.js";
import { device, owner } from "./contract/fixtures.js";

const NOW = 1_790_000_000_000;
const HOME = "189.203.10.20";
const CAFE = "201.141.7.8";
const HUB = "https://www.chalyb.com";

interface Keys {
  deviceId: string;
  sign: SigningKeyPair;
  box: BoxKeyPair;
}
const keys = async (): Promise<Keys> => {
  const sign = await generateSigningKeyPair();
  return { deviceId: await deriveDeviceId(sign.publicKey), sign, box: await generateBoxKeyPair() };
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

interface Viewer {
  typed: boolean;
  nonceHash: string | null;
  nonceExpiresAt: number | null;
}

/** The pairing slice of ApiRepo, in memory (same semantics as PostgresRepo). */
const memoryRepo = (devices: DeviceDoc[], opts: { failNotify?: boolean } = {}) => {
  const codes = new Map<string, PairingCodeDoc>();
  const nets = new Map<string, PairingNet>();
  const viewers = new Map<string, Viewer>();
  const notifications: Record<string, unknown>[] = [];
  const revoked: string[] = [];
  const key = (id: string, o: string, d: string) => `${id}/${o}/${d}`;
  const drop = (id: string) => {
    nets.delete(id);
    for (const k of [...viewers.keys()]) if (k.startsWith(`${id}/`)) viewers.delete(k);
  };
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
    recordPairingViewer: async (id, o, d, x = {}) => {
      const cur = viewers.get(key(id, o, d)) ?? { typed: false, nonceHash: null, nonceExpiresAt: null };
      viewers.set(key(id, o, d), {
        typed: cur.typed || !!x.typed,
        nonceHash: x.nonce ? x.nonce.hash : cur.nonceHash,
        nonceExpiresAt: x.nonce ? x.nonce.expiresAt : cur.nonceExpiresAt,
      });
    },
    getPairingViewer: async (id, o, d) => {
      const v = viewers.get(key(id, o, d));
      return v ? { typed: v.typed } : null;
    },
    takePairingNonce: async (id, o, d, h, now) => {
      const v = viewers.get(key(id, o, d));
      if (!v || v.nonceHash !== h || (v.nonceExpiresAt ?? 0) <= now) return false;
      viewers.set(key(id, o, d), { ...v, nonceHash: null, nonceExpiresAt: null });
      return true;
    },
    cancelPairingCode: async (id) => {
      const doc = codes.get(id);
      if (!doc) return "not_found";
      if (doc.claimed) return "already_claimed";
      codes.set(id, { ...doc, cancelled: true });
      drop(id);
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
      drop(id);
      return { ok: true, agentDeviceId: agent.deviceId };
    },
    revokeDevice: async (o, id) => {
      revoked.push(`${o}/${id}`);
      return "revoked";
    },
    createNotification: async (o, nid, d) => {
      if (opts.failNotify) throw new Error("notifications down");
      notifications.push({ owner: o, nid, ...d });
    },
  };
  return { repo: repo as ApiRepo, codes, nets, viewers, notifications, revoked };
};

const setup = async (opts: { trustedProxies?: number; failNotify?: boolean } = {}) => {
  const o = owner();
  const phone = await keys();
  const tablet = await keys();
  const stranger = await keys();
  const other = owner();
  const computer = await keys();
  const attacker = await keys();
  const pub = async (k: Keys) => ({
    pubSign: await toB64url(k.sign.publicKey),
    pubBox: await toB64url(k.box.publicKey),
  });
  const devices = [
    { ...(await device(o, "client")), deviceId: phone.deviceId, ...(await pub(phone)) },
    { ...(await device(o, "client")), deviceId: tablet.deviceId, ...(await pub(tablet)) },
    { ...(await device(other, "client")), deviceId: stranger.deviceId, ...(await pub(stranger)) },
  ];
  const mem = memoryRepo(devices, opts);
  const audit = new MemoryAudit();
  const tokens: Record<string, { uid: string; role: string; owner: string; deviceId?: string }> = {
    phone: { uid: `d_${phone.deviceId}`, role: "client", owner: o, deviceId: phone.deviceId },
    tablet: { uid: `d_${tablet.deviceId}`, role: "client", owner: o, deviceId: tablet.deviceId },
    stranger: { uid: `d_${stranger.deviceId}`, role: "client", owner: other, deviceId: stranger.deviceId },
    person: { uid: o, role: "user", owner: o },
  };
  const disabled: string[] = [];
  const deps: Deps = {
    repo: mem.repo,
    identity: {
      verify: async (t: string) => {
        const c = tokens[t];
        if (!c) throw new Error("bad token");
        return c;
      },
      mintPairingWatch: async (codeId: string) => `watch-${codeId}`,
      disableDevice: async (id: string) => (disabled.push(id), true),
    } as unknown as Deps["identity"],
    audit,
    config: {
      ssoSecret: "s",
      adminToken: "a",
      recoveryCooldownMs: 1,
      skewMs: 60_000,
      ...(opts.trustedProxies ? { trustedProxies: opts.trustedProxies } : {}),
    },
    now: () => clock,
  };
  let clock = NOW;
  const app = new Hono().route("/v1/pairing", pairingRoutes(deps));
  const post = async (path: string, body: unknown, opts: { token?: string; ip?: string; city?: string }) => {
    const res = await app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": opts.ip ?? HOME,
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
  /** The computer asks for a code (what `chalito pair` and the panel do). */
  const ask = async (ip = HOME, city?: string) => {
    const r = await askWith(await randomNonce(), ip, city);
    expect(r.status).toBe(201);
    return { codeId: r.codeId, shortCode: r.json.shortCode as string };
  };
  const claimBody = async (codeId: string, extra: Record<string, unknown> = {}, by: Keys = phone) => ({
    claim: await signEnvelope(
      "chalito.pairing-claim.v1",
      {
        v: 1,
        owner: by === stranger ? other : o,
        codeId,
        agentDeviceId: computer.deviceId,
        agentFingerprint: await fingerprint(computer.sign.publicKey),
        claimerDeviceId: by.deviceId,
        issuedAt: clock,
      },
      by.deviceId,
      by.sign.secretKey,
    ),
    ...extra,
  });
  /** What the agent answers on loopback: (code id, nonce, origin) signed with `signer` (the computer). */
  const proof = (codeId: string, nonce: string, o: { origin?: string; signer?: Keys } = {}) => {
    const signer = o.signer ?? computer;
    return signEnvelope(
      "chalito.pairing-loopback.v1",
      { v: 1, codeId, nonce, origin: o.origin ?? HUB, issuedAt: clock },
      signer.deviceId,
      signer.sign.secretKey,
    );
  };
  const withdraw = (codeId: string, signer: Keys = computer) =>
    signEnvelope(
      "chalito.pairing-withdraw.v1",
      { v: 1, codeId, issuedAt: clock },
      signer.deviceId,
      signer.sign.secretKey,
    );
  const handoff = async (codeId: string, token = "phone") =>
    (await post("/v1/pairing/handoff", { codeId }, { token })).json as Record<string, string>;
  return {
    o,
    mem,
    audit,
    disabled,
    post,
    get,
    ask,
    askWith,
    claimBody,
    proof,
    withdraw,
    handoff,
    computer,
    attacker,
    stranger,
    tick: (ms: number) => void (clock += ms),
  };
};

describe("network of an address (warning text only)", () => {
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
  });

  it("one policy decides: one tap only on the same computer, else the code (or blocked)", () => {
    expect(pairingApproval({ sameComputer: true })).toBe("one_tap");
    expect(pairingApproval({ sameComputer: false })).toBe("code_required");
    expect(pairingApproval({ sameComputer: false }, "block")).toBe("blocked");
    expect(pairingApproval({ sameComputer: true }, "block")).toBe("one_tap");
  });

  it("the approval link carries the code id and the loopback port, never the short code", () => {
    expect(pairingApproveUrl("https://www.chalyb.com/app/chalito/", "abc_DEF-123", 47810)).toBe(
      "https://www.chalyb.com/app/chalito/computadoras/aprobar#c=abc_DEF-123&p=47810",
    );
  });
});

describe("POST /v1/pairing/handoff", () => {
  it("shows what would be approved and a nonce, never the short code or its hash", async () => {
    const s = await setup();
    const { codeId, shortCode } = await s.ask();
    const r = await s.post("/v1/pairing/handoff", { codeId }, { token: "phone" });
    expect(r.status).toBe(200);
    const v = PairingHandoffResponse.parse(r.json);
    expect(v).toMatchObject({ network: "same", approval: "code_required", codeTyped: false });
    expect(v.loopbackNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const text = JSON.stringify(r.json);
    expect(text).not.toContain(shortCode);
    expect(text).not.toContain(s.mem.codes.get(codeId)!.shortCodeHash);
  });

  it("the same public IP no longer means one tap: the code is still required", async () => {
    const s = await setup();
    const { codeId } = await s.ask(HOME);
    await s.handoff(codeId);
    const r = await s.post("/v1/pairing/claim", await s.claimBody(codeId), { token: "phone", ip: HOME });
    expect(r).toMatchObject({ status: 403, json: { error: "code_required" } });
  });

  it("another network: warning info with the city from the load balancer only", async () => {
    const lb = await setup({ trustedProxies: 1 });
    const a = await lb.ask(HOME, "Guadalajara");
    expect(
      (await lb.post("/v1/pairing/handoff", { codeId: a.codeId }, { token: "phone", ip: CAFE })).json,
    ).toMatchObject({
      network: "different",
      city: "Guadalajara",
    });
    const plain = await setup();
    const b = await plain.ask(HOME, "Guadalajara");
    expect(
      (await plain.post("/v1/pairing/handoff", { codeId: b.codeId }, { token: "phone", ip: CAFE })).json,
    ).toMatchObject({ network: "different", city: null });
  });

  it("needs a signed-in client, and is rate-limited", async () => {
    const s = await setup();
    const { codeId } = await s.ask();
    expect((await s.post("/v1/pairing/handoff", { codeId }, {})).status).toBe(401);
    expect((await s.post("/v1/pairing/handoff", { codeId }, { token: "person" })).status).toBe(403);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++)
      statuses.push((await s.post("/v1/pairing/handoff", { codeId }, { token: "phone" })).status);
    expect(statuses).toContain(429);
  });
});

describe("POST /v1/pairing/claim: one tap needs the loopback proof", () => {
  it("a valid proof over this client's nonce: one tap, no code", async () => {
    const s = await setup();
    const { codeId } = await s.ask();
    const { loopbackNonce } = await s.handoff(codeId);
    const r = await s.post(
      "/v1/pairing/claim",
      await s.claimBody(codeId, { loopbackProof: await s.proof(codeId, loopbackNonce!) }),
      { token: "phone", ip: CAFE },
    );
    expect(r).toMatchObject({ status: 200, json: { agentDeviceId: s.computer.deviceId } });
    expect(s.audit.events).toContainEqual(
      expect.objectContaining({ action: "pairing.claimed", meta: { approval: "one_tap" } }),
    );
  });

  it("a forged proof (signed by another key) is refused", async () => {
    const s = await setup();
    const { codeId } = await s.ask();
    const { loopbackNonce } = await s.handoff(codeId);
    const forged = await s.proof(codeId, loopbackNonce!, { signer: s.attacker });
    const tampered = { ...(await s.proof(codeId, loopbackNonce!)), signerDeviceId: s.computer.deviceId };
    tampered.body = { ...tampered.body, issuedAt: tampered.body.issuedAt + 1 };
    for (const p of [forged, tampered]) {
      const r = await s.post("/v1/pairing/claim", await s.claimBody(codeId, { loopbackProof: p }), { token: "phone" });
      expect(r).toMatchObject({ status: 403, json: { error: "bad_proof" } });
    }
  });

  it("a wrong nonce, a reused nonce and an expired nonce are refused", async () => {
    const s = await setup();
    const { codeId } = await s.ask();
    const { loopbackNonce } = await s.handoff(codeId);
    const wrong = "A".repeat(43);
    expect(
      (
        await s.post("/v1/pairing/claim", await s.claimBody(codeId, { loopbackProof: await s.proof(codeId, wrong) }), {
          token: "phone",
        })
      ).json.error,
    ).toBe("bad_proof");
    // Used once (a failed claim, e.g. a stale claim body, still consumes it)…
    const p = await s.proof(codeId, loopbackNonce!);
    const stale = { ...(await s.claimBody(codeId)), loopbackProof: p };
    stale.claim.body = { ...stale.claim.body, issuedAt: 1 };
    await s.post("/v1/pairing/claim", stale, { token: "phone" });
    expect(
      (await s.post("/v1/pairing/claim", await s.claimBody(codeId, { loopbackProof: p }), { token: "phone" })).json
        .error,
    ).toBe("bad_proof");
    // …and a fresh nonce that waited too long.
    const again = await s.handoff(codeId);
    s.tick(PAIRING_NONCE_TTL_MS + 1);
    const late = await s.proof(codeId, again.loopbackNonce!);
    expect(
      (await s.post("/v1/pairing/claim", await s.claimBody(codeId, { loopbackProof: late }), { token: "phone" })).json
        .error,
    ).toBe("bad_proof");
  });

  it("a proof over another client's nonce is refused (a link can't carry a pre-made proof)", async () => {
    const s = await setup();
    const { codeId } = await s.ask();
    const theirs = await s.handoff(codeId, "tablet");
    await s.handoff(codeId, "phone");
    const r = await s.post(
      "/v1/pairing/claim",
      await s.claimBody(codeId, { loopbackProof: await s.proof(codeId, theirs.loopbackNonce!) }),
      { token: "phone" },
    );
    expect(r).toMatchObject({ status: 403, json: { error: "bad_proof" } });
  });

  it("a proof naming another origin, or another code, is refused", async () => {
    const s = await setup();
    const { codeId } = await s.ask();
    const other = await s.ask();
    const n1 = (await s.handoff(codeId)).loopbackNonce!;
    const evil = await s.proof(codeId, n1, { origin: "https://evil.example" });
    expect(
      (await s.post("/v1/pairing/claim", await s.claimBody(codeId, { loopbackProof: evil }), { token: "phone" })).json
        .error,
    ).toBe("bad_proof");
    const n2 = (await s.handoff(codeId)).loopbackNonce!;
    const wrongCode = await s.proof(other.codeId, n2);
    expect(
      (await s.post("/v1/pairing/claim", await s.claimBody(codeId, { loopbackProof: wrongCode }), { token: "phone" }))
        .json.error,
    ).toBe("bad_proof");
  });

  it("fallback: no proof, the typed code (any case, spaces) is enough; a wrong one isn't", async () => {
    const s = await setup();
    const { codeId, shortCode } = await s.ask();
    expect(
      (
        await s.post("/v1/pairing/claim", await s.claimBody(codeId, { shortCode: "ZZZZ-ZZZZ" }), {
          token: "phone",
          ip: CAFE,
        })
      ).json.error,
    ).toBe("code_required");
    const typed = ` ${shortCode.toLowerCase().replace("-", " ")} `;
    const r = await s.post("/v1/pairing/claim", await s.claimBody(codeId, { shortCode: typed }), {
      token: "phone",
      ip: CAFE,
    });
    expect(r.status).toBe(200);
    expect(s.audit.events).toContainEqual(
      expect.objectContaining({ action: "pairing.claimed", meta: { approval: "code_required" } }),
    );
  });

  it("backwards compatible: a client that typed the code at /resolve claims without resending it", async () => {
    const s = await setup();
    const { codeId, shortCode } = await s.ask();
    const r1 = await s.post("/v1/pairing/resolve", { shortCode }, { token: "phone", ip: CAFE });
    expect(r1.json).toMatchObject({ codeTyped: true, loopbackNonce: null });
    // Only that client: another one that didn't type it still needs the code.
    expect(
      (await s.post("/v1/pairing/claim", await s.claimBody(codeId, {}, s.stranger), { token: "stranger" })).json.error,
    ).toBe("code_required");
    expect((await s.post("/v1/pairing/claim", await s.claimBody(codeId), { token: "phone", ip: CAFE })).status).toBe(
      200,
    );
  });

  it("claimed, declined, expired and unknown codes answer the same 404", async () => {
    const s = await setup();
    const claimed = await s.ask();
    await s.post("/v1/pairing/claim", await s.claimBody(claimed.codeId, { shortCode: claimed.shortCode }), {
      token: "phone",
    });
    const declined = await s.ask();
    await s.handoff(declined.codeId);
    await s.post("/v1/pairing/decline", { codeId: declined.codeId }, { token: "phone" });
    const expired = await s.ask();
    s.mem.codes.set(expired.codeId, { ...s.mem.codes.get(expired.codeId)!, expiresAt: NOW });
    const bodies = [];
    for (const c of [claimed, declined, expired, { codeId: "A".repeat(22), shortCode: "ZZZZ-ZZZZ" }])
      bodies.push(
        await s.post("/v1/pairing/claim", await s.claimBody(c.codeId, { shortCode: c.shortCode }), { token: "phone" }),
      );
    expect(new Set(bodies.map((b) => JSON.stringify(b)))).toEqual(new Set([JSON.stringify(bodies[0])]));
    expect(bodies[0]).toMatchObject({ status: 404, json: { error: "not_found" } });
  });

  it("every pairing alerts all of the account's devices", async () => {
    const s = await setup();
    const { codeId, shortCode } = await s.ask();
    await s.post("/v1/pairing/claim", await s.claimBody(codeId, { shortCode }), { token: "phone" });
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
  });

  it("a failed alert doesn't undo or fail the committed pairing", async () => {
    const s = await setup({ failNotify: true });
    const { codeId, shortCode } = await s.ask();
    const r = await s.post("/v1/pairing/claim", await s.claimBody(codeId, { shortCode }), { token: "phone" });
    expect(r.status).toBe(200);
    expect(s.mem.codes.get(codeId)!.claimed).toBe(true);
  });
});

describe("POST /v1/pairing/decline", () => {
  it("cancels an open code the client opened, and drops its records", async () => {
    const s = await setup();
    const { codeId } = await s.ask();
    expect(s.mem.nets.has(codeId)).toBe(true);
    await s.handoff(codeId);
    expect(await s.post("/v1/pairing/decline", { codeId }, { token: "phone", ip: CAFE })).toMatchObject({
      status: 200,
      json: { ok: true },
    });
    expect(s.mem.codes.get(codeId)!.cancelled).toBe(true);
    expect(s.mem.nets.has(codeId)).toBe(false);
    expect([...s.mem.viewers.keys()].some((k) => k.startsWith(codeId))).toBe(false);
  });

  it("knowing the code id isn't enough: only a client that opened it may decline", async () => {
    const s = await setup();
    const { codeId, shortCode } = await s.ask();
    await s.handoff(codeId);
    for (const token of ["stranger", "tablet"])
      expect(await s.post("/v1/pairing/decline", { codeId }, { token })).toMatchObject({
        status: 403,
        json: { error: "not_opened" },
      });
    await s.post("/v1/pairing/resolve", { shortCode }, { token: "tablet" });
    expect((await s.post("/v1/pairing/decline", { codeId }, { token: "tablet" })).status).toBe(200);
  });

  it("strangers' attempts don't use up the code's own decline budget", async () => {
    const s = await setup();
    const { codeId } = await s.ask();
    await s.handoff(codeId);
    for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4", "198.51.100.5"])
      expect((await s.post("/v1/pairing/decline", { codeId }, { token: "stranger", ip })).status).toBe(403);
    expect((await s.post("/v1/pairing/decline", { codeId }, { token: "phone" })).status).toBe(200);
  });

  it("is limited per client; the per-code bucket comes after the viewer check", async () => {
    const s = await setup();
    const perClient: number[] = [];
    for (let i = 0; i < 7; i++)
      perClient.push(
        (await s.post("/v1/pairing/decline", { codeId: `unknown_code_${i}` }, { token: "phone", ip: CAFE })).status,
      );
    expect(perClient).toContain(429);

    const t = await setup();
    const { codeId } = await t.ask();
    await t.handoff(codeId);
    await t.handoff(codeId, "tablet");
    // The per-code bucket is taken only after the viewer check; then a viewer can't hammer it.
    const ok = await t.post("/v1/pairing/decline", { codeId }, { token: "phone" });
    expect(ok.status).toBe(200);
    expect((await t.post("/v1/pairing/decline", { codeId }, { token: "tablet" })).status).toBe(404);
  });

  it("needs a signed-in client; claimed or unknown codes are 404", async () => {
    const s = await setup();
    const { codeId, shortCode } = await s.ask();
    expect((await s.post("/v1/pairing/decline", { codeId }, {})).status).toBe(401);
    await s.handoff(codeId);
    await s.post("/v1/pairing/claim", await s.claimBody(codeId, { shortCode }), { token: "phone" });
    expect((await s.post("/v1/pairing/decline", { codeId }, { token: "phone" })).status).toBe(404);
  });
});

describe("POST /v1/pairing/withdraw: the computer burns its own code", () => {
  it("Cancelar while waiting: the code can't be claimed any more", async () => {
    const s = await setup();
    const { codeId, shortCode } = await s.ask();
    expect((await s.post("/v1/pairing/withdraw", { withdraw: await s.withdraw(codeId) }, {})).status).toBe(200);
    expect(s.mem.codes.get(codeId)!.cancelled).toBe(true);
    expect(
      (await s.post("/v1/pairing/claim", await s.claimBody(codeId, { shortCode }), { token: "phone" })).status,
    ).toBe(404);
  });

  it("No fui yo after a claim: the device that claim created is revoked", async () => {
    const s = await setup();
    const { codeId, shortCode } = await s.ask();
    await s.post("/v1/pairing/claim", await s.claimBody(codeId, { shortCode }), { token: "phone" });
    expect((await s.post("/v1/pairing/withdraw", { withdraw: await s.withdraw(codeId) }, {})).status).toBe(200);
    expect(s.mem.revoked).toEqual([`${s.o}/${s.computer.deviceId}`]);
    expect(s.disabled).toEqual([s.computer.deviceId]);
  });

  it("only the computer that published the code can withdraw it", async () => {
    const s = await setup();
    const { codeId } = await s.ask();
    const r = await s.post("/v1/pairing/withdraw", { withdraw: await s.withdraw(codeId, s.attacker) }, {});
    expect(r).toMatchObject({ status: 403, json: { error: "not_this_computer" } });
    const forged = { ...(await s.withdraw(codeId, s.attacker)), signerDeviceId: s.computer.deviceId };
    expect((await s.post("/v1/pairing/withdraw", { withdraw: forged }, {})).status).toBe(403);
    expect(s.mem.codes.get(codeId)!.cancelled).toBe(false);
  });
});

describe("the code id is a capability", () => {
  it("the computer can't publish a guessable code id (under 128 bits)", async () => {
    const s = await setup();
    expect(await s.askWith("short_id_123")).toMatchObject({ status: 400, json: { error: "weak_code_id" } });
  });

  it("unknown, claimed, declined and expired codes answer the same 404 at /handoff", async () => {
    const s = await setup();
    const claimed = await s.ask();
    await s.post("/v1/pairing/claim", await s.claimBody(claimed.codeId, { shortCode: claimed.shortCode }), {
      token: "phone",
    });
    const declined = await s.ask();
    await s.handoff(declined.codeId);
    await s.post("/v1/pairing/decline", { codeId: declined.codeId }, { token: "phone" });
    const expired = await s.ask();
    s.mem.codes.set(expired.codeId, { ...s.mem.codes.get(expired.codeId)!, expiresAt: NOW });
    const bodies = [];
    for (const codeId of ["A".repeat(22), claimed.codeId, declined.codeId, expired.codeId])
      bodies.push(await s.post("/v1/pairing/handoff", { codeId }, { token: "tablet" }));
    expect(new Set(bodies.map((b) => JSON.stringify(b)))).toEqual(new Set([JSON.stringify(bodies[0])]));
    expect(bodies[0]).toMatchObject({ status: 404, json: { error: "not_found" } });
  });

  it("no route lists codes, and the audit log never holds a code id or a nonce", async () => {
    const s = await setup();
    const { codeId } = await s.ask();
    for (const path of ["/v1/pairing/codes", "/v1/pairing", "/v1/pairing/handoff"])
      expect([404, 405], path).toContain((await s.get(path)).status);
    const { loopbackNonce } = await s.handoff(codeId);
    await s.post("/v1/pairing/decline", { codeId }, { token: "phone" });
    const log = JSON.stringify(s.audit.events);
    expect(log).not.toContain(codeId);
    expect(log).not.toContain(loopbackNonce!);
    expect([...s.mem.viewers.values()].every((v) => v.nonceHash !== loopbackNonce)).toBe(true);
    expect(sha(loopbackNonce!)).toMatch(/^[0-9a-f]{64}$/);
  });
});
