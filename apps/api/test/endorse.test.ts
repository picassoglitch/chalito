import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  deriveDeviceId,
  generateBoxKeyPair,
  generateSigningKeyPair,
  signEnvelope,
  toB64url,
  type BoxKeyPair,
  type SigningKeyPair,
} from "@chalito/crypto";
import { SoftAuthenticator } from "@chalito/client-keys/testing";
import {
  DeviceRegistrationBody,
  EndorsementBody,
  type DeviceDoc,
  type DeviceRegistration,
  type Endorsement,
} from "@chalito/protocol";
import { createApp } from "../src/app.js";
import { MemoryAudit, type Deps } from "../src/deps.js";
import type { ApiRepo, EndorseCodeRecord, StoredWebAuthnCredential, WebAuthnChallenge } from "../src/repo.js";
import { ENDORSE_CODE_TTL_MS, endorseRoutes } from "../src/routes/endorse.js";
import { webauthnRoutes } from "../src/routes/webauthn.js";
import { device, owner } from "./contract/fixtures.js";

/** Device keys and the client-keys signing helpers, rebuilt on @chalito/crypto (no DOM here). */
interface DeviceKeys {
  deviceId: string;
  sign: SigningKeyPair;
  box: BoxKeyPair;
}
const generateDeviceKeys = async (): Promise<DeviceKeys> => {
  const sign = await generateSigningKeyPair();
  return { deviceId: await deriveDeviceId(sign.publicKey), sign, box: await generateBoxKeyPair() };
};
const publicKeys = async (k: DeviceKeys) => ({
  pubSign: await toB64url(k.sign.publicKey),
  pubBox: await toB64url(k.box.publicKey),
});
const signDeviceRegistration = async (
  k: DeviceKeys,
  r: { owner: string; kind: "web" | "phone"; platform: "web"; name: string; now: number },
): Promise<DeviceRegistration> => {
  const body = DeviceRegistrationBody.parse({
    v: 1,
    owner: r.owner,
    deviceId: k.deviceId,
    kind: r.kind,
    platform: r.platform,
    name: r.name,
    ...(await publicKeys(k)),
    issuedAt: r.now,
  });
  return signEnvelope("chalito.device-register.v1", body, k.deviceId, k.sign.secretKey);
};
const signEndorsement = async (
  k: DeviceKeys,
  e: { uid: string; newDeviceId: string; pubSign: string; pubBox: string; now: number },
): Promise<Endorsement> => {
  const body = EndorsementBody.parse({
    v: 1,
    uid: e.uid,
    newDeviceId: e.newDeviceId,
    pubSign: e.pubSign,
    pubBox: e.pubBox,
    issuedAt: e.now,
  });
  return signEnvelope("chalito.endorsement.v1", body, k.deviceId, k.sign.secretKey);
};

const RP = "chalito.chalyb.com";
const ORIGIN = `https://${RP}`;
const NOW = 1_790_000_000_000;
const WA = { rpId: RP, rpName: "Chalito", origins: [ORIGIN], challengeTtlMs: 60_000 };

/** The slice of ApiRepo these routes use, in memory (same semantics as PostgresRepo). */
const memoryRepo = (devices: DeviceDoc[]) => {
  const codes = new Map<string, EndorseCodeRecord>();
  const challenges = new Map<string, WebAuthnChallenge>();
  const creds = new Map<string, StoredWebAuthnCredential>();
  const repo: Partial<ApiRepo> = {
    getDevice: async (o, id) => devices.find((d) => d.owner === o && d.deviceId === id) ?? null,
    createEndorseCode: async (r) => {
      if (codes.has(r.codeId) || [...codes.values()].some((c) => c.shortCodeHash === r.shortCodeHash)) return "exists";
      codes.set(r.codeId, {
        ...r,
        newDeviceId: r.registration.body.deviceId,
        endorsement: null,
        endorsedByDeviceId: null,
        endorsedAt: null,
        takenAt: null,
      });
      return "created";
    },
    findEndorseCode: async (id) => codes.get(id) ?? null,
    findEndorseCodeByShortHash: async (h) => [...codes.values()].find((c) => c.shortCodeHash === h) ?? null,
    approveEndorseCode: async (id, o, e, now) => {
      const c = codes.get(id);
      if (!c || c.owner !== o) return "not_found";
      if (c.endorsement) return "already_endorsed";
      if (c.expiresAt <= now) return "expired";
      codes.set(id, { ...c, ...e });
      return "ok";
    },
    takeEndorsement: async (id, o, now) => {
      const c = codes.get(id);
      if (!c || c.owner !== o) return { ok: false, reason: "not_found" };
      if (c.takenAt) return { ok: false, reason: "already_taken" };
      if (c.expiresAt <= now) return { ok: false, reason: "expired" };
      if (!c.endorsement) return { ok: false, reason: "not_endorsed" };
      codes.set(id, { ...c, takenAt: now });
      return { ok: true, endorsement: c.endorsement };
    },
    putWebAuthnChallenge: async (c) => void challenges.set(`${c.owner}/${c.deviceId}/${c.purpose}`, c),
    takeWebAuthnChallenge: async (o, d, p, now) => {
      const k = `${o}/${d}/${p}`;
      const c = challenges.get(k);
      challenges.delete(k);
      return c && c.expiresAt > now ? c.challenge : null;
    },
    setDeviceWebAuthn: async (o, d, cred) => (creds.set(`${o}/${d}`, cred), true),
    getDeviceWebAuthn: async (o, d) => creds.get(`${o}/${d}`) ?? null,
  };
  return { repo: repo as ApiRepo, codes, creds };
};

const docFor = async (o: string, keys: DeviceKeys, over: Partial<DeviceDoc> = {}) => {
  const pub = await publicKeys(keys);
  return { ...(await device(o, "client")), deviceId: keys.deviceId, pubSign: pub.pubSign, pubBox: pub.pubBox, ...over };
};

const setup = async () => {
  const o = owner();
  const other = owner();
  let clock = NOW;
  const phoneKeys = await generateDeviceKeys();
  const agentKeys = await generateDeviceKeys();
  const strangerKeys = await generateDeviceKeys();
  const devices = [
    await docFor(o, phoneKeys),
    await docFor(o, agentKeys, { role: "agent", kind: "laptop", platform: "linux" }),
    await docFor(other, strangerKeys),
  ];
  const mem = memoryRepo(devices);
  const audit = new MemoryAudit();
  const watches: string[] = [];
  const released: string[] = [];
  const tokens: Record<string, { uid: string; role: string; owner: string; deviceId?: string }> = {
    person: { uid: o, role: "user", owner: o },
    "other-person": { uid: other, role: "user", owner: other },
    phone: { uid: `d_${phoneKeys.deviceId}`, role: "client", owner: o, deviceId: phoneKeys.deviceId },
    agent: { uid: `d_${agentKeys.deviceId}`, role: "agent", owner: o, deviceId: agentKeys.deviceId },
    stranger: { uid: `d_${strangerKeys.deviceId}`, role: "client", owner: other, deviceId: strangerKeys.deviceId },
  };
  const deps: Deps = {
    repo: mem.repo,
    identity: {
      verify: async (t: string) => {
        const c = tokens[t];
        if (!c) throw new Error("bad token");
        return c;
      },
      mintPairingWatch: async (codeId: string) => (watches.push(codeId), `watch-${codeId}`),
      releasePairingWatch: async (codeId: string) => void released.push(codeId),
    } as unknown as Deps["identity"],
    audit,
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
    now: () => clock,
  };
  const app = new Hono().route("/v1/endorse", endorseRoutes(deps, WA)).route("/v1/webauthn", webauthnRoutes(deps, WA));
  const post = async (path: string, body: unknown, token: string) => {
    const res = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const newKeys = await generateDeviceKeys();
  const registration = (keys = newKeys, owner_ = o, kind: "web" | "phone" = "web") =>
    signDeviceRegistration(keys, { owner: owner_, kind, platform: "web", name: "Chalito (desktop)", now: clock });
  const endorse = async (
    reg: Awaited<ReturnType<typeof registration>>,
    by = phoneKeys,
    over: { uid?: string; now?: number } = {},
  ) =>
    signEndorsement(by, {
      uid: over.uid ?? reg.body.owner,
      newDeviceId: reg.body.deviceId,
      pubSign: reg.body.pubSign,
      pubBox: reg.body.pubBox,
      now: over.now ?? clock,
    });
  const createCode = async () => {
    const reg = await registration();
    const r = await post("/v1/endorse/codes", { registration: reg }, "person");
    expect(r.status).toBe(201);
    return { reg, ...(r.json as { codeId: string; shortCode: string; watchToken: string; expiresAt: number }) };
  };
  return {
    o,
    other,
    phoneKeys,
    newKeys,
    mem,
    audit,
    watches,
    released,
    post,
    registration,
    endorse,
    createCode,
    tick: (ms: number) => (clock += ms),
  };
};

describe("app wiring", () => {
  it("mounts /v1/endorse", async () => {
    const deps = {
      repo: memoryRepo([]).repo,
      identity: { verify: async () => Promise.reject(new Error("x")) },
      audit: new MemoryAudit(),
      config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 1 },
      now: () => NOW,
    } as unknown as Deps;
    expect((await createApp(deps).request("/v1/endorse/codes", { method: "POST" })).status).toBe(401);
  });
});

describe("endorsement handoff", () => {
  it("code → resolve (id or short code) → approve → take, each step single use", async () => {
    const s = await setup();
    const c = await s.createCode();
    expect(c.codeId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(c.shortCode).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(c.watchToken).toBe(`watch-${c.codeId}`);
    expect(c.expiresAt).toBe(NOW + ENDORSE_CODE_TTL_MS);
    // The short code is stored hashed only.
    const stored = s.mem.codes.get(c.codeId)!;
    expect(JSON.stringify(stored)).not.toContain(c.shortCode);

    const byId = await s.post("/v1/endorse/resolve", { codeId: c.codeId }, "phone");
    const byShort = await s.post("/v1/endorse/resolve", { shortCode: c.shortCode.toLowerCase() }, "phone");
    expect(byId.status).toBe(200);
    expect(byShort.json).toEqual(byId.json);
    expect(byId.json.registration).toEqual(c.reg);

    // Nothing to take yet.
    expect((await s.post("/v1/endorse/take", { codeId: c.codeId }, "person")).json.error).toBe("not_endorsed");

    const endorsement = await s.endorse(c.reg);
    expect((await s.post("/v1/endorse/approve", { codeId: c.codeId, endorsement }, "phone")).status).toBe(200);
    expect(s.audit.events.at(-1)).toMatchObject({ action: "endorse.approved", target: c.reg.body.deviceId });
    // A second approval (even a valid one) is refused; the code no longer resolves.
    const again = await s.post(
      "/v1/endorse/approve",
      { codeId: c.codeId, endorsement: await s.endorse(c.reg) },
      "phone",
    );
    expect([again.status, again.json.error]).toEqual([409, "already_endorsed"]);
    expect((await s.post("/v1/endorse/resolve", { codeId: c.codeId }, "phone")).status).toBe(404);

    const taken = await s.post("/v1/endorse/take", { codeId: c.codeId }, "person");
    expect(taken.status).toBe(200);
    expect(taken.json.endorsement as Endorsement).toEqual(endorsement);
    expect(s.released).toEqual([c.codeId]);
    const twice = await s.post("/v1/endorse/take", { codeId: c.codeId }, "person");
    expect([twice.status, twice.json.error]).toEqual([409, "already_taken"]);
  });

  describe("POST /codes (new device, person session)", () => {
    it("only the person's session can open a code", async () => {
      const s = await setup();
      const reg = await s.registration();
      expect((await s.post("/v1/endorse/codes", { registration: reg }, "phone")).status).toBe(403);
      expect((await s.post("/v1/endorse/codes", { registration: reg }, "nope")).status).toBe(401);
    });

    it.each([
      [
        "another account's registration",
        async (s: Awaited<ReturnType<typeof setup>>) => s.registration(undefined, s.other),
        403,
        "owner_mismatch",
      ],
      [
        "a forged signature",
        async (s: Awaited<ReturnType<typeof setup>>) => ({
          ...(await s.registration()),
          sig: (await s.registration(s.phoneKeys)).sig,
        }),
        400,
        "bad_signature",
      ],
      [
        "a device that already exists",
        async (s: Awaited<ReturnType<typeof setup>>) => s.registration(s.phoneKeys),
        409,
        "device_exists",
      ],
      ["garbage", async () => ({ nope: true }), 400, "bad_request"],
    ] as const)("refuses %s", async (_n, make, status, error) => {
      const s = await setup();
      const r = await s.post("/v1/endorse/codes", { registration: await make(s) }, "person");
      expect([r.status, r.json.error]).toEqual([status, error]);
    });
  });

  describe("POST /resolve (trusted client)", () => {
    it("another account, an expired code or an agent token all get nothing", async () => {
      const s = await setup();
      const c = await s.createCode();
      expect((await s.post("/v1/endorse/resolve", { codeId: c.codeId }, "stranger")).status).toBe(404);
      expect((await s.post("/v1/endorse/resolve", { codeId: c.codeId }, "agent")).status).toBe(403);
      expect((await s.post("/v1/endorse/resolve", { shortCode: "ZZZZ-ZZZZ" }, "phone")).status).toBe(404);
      s.tick(ENDORSE_CODE_TTL_MS);
      expect((await s.post("/v1/endorse/resolve", { codeId: c.codeId }, "phone")).status).toBe(404);
    });
  });

  describe("POST /approve (trusted client)", () => {
    it.each([
      ["signed by another device than the caller", "signer_mismatch", 403],
      ["for another account", "endorsement_mismatch", 400],
      ["for other keys", "endorsement_mismatch", 400],
      ["stale", "stale_endorsement", 400],
      ["with a bad signature", "bad_endorsement", 400],
    ] as const)("refuses an endorsement %s", async (name, error, status) => {
      const s = await setup();
      const c = await s.createCode();
      let e = await s.endorse(c.reg);
      if (name.startsWith("signed by another")) e = await s.endorse(c.reg, s.newKeys);
      if (name === "for another account") e = await s.endorse(c.reg, s.phoneKeys, { uid: s.other });
      if (name === "for other keys") e = await s.endorse(await s.registration(await generateDeviceKeys()));
      if (name === "stale") e = await s.endorse(c.reg, s.phoneKeys, { now: NOW - 10 * 60_000 });
      if (name === "with a bad signature")
        e = { ...e, sig: (await s.endorse(await s.registration(await generateDeviceKeys()))).sig };
      const r = await s.post("/v1/endorse/approve", { codeId: c.codeId, endorsement: e }, "phone");
      expect([r.status, r.json.error]).toEqual([status, error]);
      expect(s.mem.codes.get(c.codeId)!.endorsement).toBeNull();
    });

    it("refuses agents, other accounts' clients, expired and unknown codes", async () => {
      const s = await setup();
      const c = await s.createCode();
      const e = await s.endorse(c.reg);
      expect((await s.post("/v1/endorse/approve", { codeId: c.codeId, endorsement: e }, "agent")).status).toBe(403);
      expect((await s.post("/v1/endorse/approve", { codeId: c.codeId, endorsement: e }, "stranger")).status).toBe(403);
      expect((await s.post("/v1/endorse/approve", { codeId: "A".repeat(22), endorsement: e }, "phone")).status).toBe(
        404,
      );
      s.tick(ENDORSE_CODE_TTL_MS);
      const late = await s.post(
        "/v1/endorse/approve",
        { codeId: c.codeId, endorsement: await s.endorse(c.reg) },
        "phone",
      );
      expect([late.status, late.json.error]).toEqual([410, "expired"]);
    });

    it("an endorser with a passkey must step up with a fresh server-challenged assertion", async () => {
      const s = await setup();
      const auth = new SoftAuthenticator({ origin: ORIGIN, alg: -8 });
      const opts = await s.post("/v1/webauthn/register/options", {}, "phone");
      expect(
        (await s.post("/v1/webauthn/register/verify", { response: await auth.create(opts.json.options) }, "phone"))
          .status,
      ).toBe(201);

      const c = await s.createCode();
      const e = await s.endorse(c.reg);
      const none = await s.post("/v1/endorse/approve", { codeId: c.codeId, endorsement: e }, "phone");
      expect([none.status, none.json.error]).toEqual([401, "step_up_required"]);

      const a = await s.post("/v1/webauthn/assert/options", {}, "phone");
      const stepUp = await auth.get(a.json.options);
      const ok = await s.post("/v1/endorse/approve", { codeId: c.codeId, endorsement: e, stepUp }, "phone");
      expect(ok.status).toBe(200);
      expect(s.audit.events.at(-1)?.meta).toMatchObject({ stepUp: true });

      // The challenge is single use: replaying the assertion on another code fails.
      const c2 = await s.createCode();
      const replay = await s.post(
        "/v1/endorse/approve",
        { codeId: c2.codeId, endorsement: await s.endorse(c2.reg), stepUp },
        "phone",
      );
      expect([replay.status, replay.json.error]).toEqual([401, "step_up_failed"]);
    });
  });

  describe("POST /take (new device)", () => {
    it("only the same person, only before expiry", async () => {
      const s = await setup();
      const c = await s.createCode();
      await s.post("/v1/endorse/approve", { codeId: c.codeId, endorsement: await s.endorse(c.reg) }, "phone");
      expect((await s.post("/v1/endorse/take", { codeId: c.codeId }, "other-person")).status).toBe(404);
      expect((await s.post("/v1/endorse/take", { codeId: c.codeId }, "phone")).status).toBe(403);
      s.tick(ENDORSE_CODE_TTL_MS);
      const late = await s.post("/v1/endorse/take", { codeId: c.codeId }, "person");
      expect([late.status, late.json.error]).toEqual([410, "expired"]);
    });
  });
});
