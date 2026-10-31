// @vitest-environment node
// ADR 0032 — the panel enrols through the real api route; only storage (in-memory ApiRepo) is faked.
import { describe, expect, it } from "vitest";
import {
  ApiError,
  DeviceClientKeys,
  generateDeviceKeys,
  httpApi,
  publicKeys,
  type ApiClient,
} from "@chalito/client-keys";
import { fingerprint } from "@chalito/crypto";
import type { DeviceDoc } from "@chalito/protocol";
import { createApp } from "../../api/src/app.js";
import { MemoryAudit, type Deps } from "../../api/src/deps.js";
import type { ApiRepo, EndorseCodeRecord } from "../../api/src/repo.js";
import { enrollDesktop } from "../src/lib/enrollment.js";

const OWNER = "8a7a0d3c-5b5e-4a39-9d2b-2f8b1e0c4a11";

const world = async () => {
  const phoneKeys = await generateDeviceKeys();
  const pub = await publicKeys(phoneKeys);
  const devices: DeviceDoc[] = [
    {
      v: 1,
      deviceId: phoneKeys.deviceId,
      owner: OWNER,
      kind: "phone",
      platform: "android",
      name: "Teléfono",
      role: "client",
      pubSign: pub.pubSign,
      pubBox: pub.pubBox,
      fingerprint: await fingerprint(phoneKeys.sign.publicKey),
      enrolledVia: "first_client",
      endorsedBy: null,
      revoked: false,
      revokedAt: null,
      createdAt: Date.now(),
      lastSeenAt: null,
      policyHash: null,
      devMode: { on: false, toggles: [], since: null },
    } satisfies DeviceDoc,
  ];
  const codes = new Map<string, EndorseCodeRecord>();
  const pointers = new Map<string, () => void>();
  const saved: { newDeviceId: string; endorsement: unknown }[] = [];
  const repo: Partial<ApiRepo> = {
    getDevice: async (o, id) => devices.find((d) => d.owner === o && d.deviceId === id) ?? null,
    createDevice: async (_o, doc) =>
      devices.some((d) => d.deviceId === doc.deviceId) ? "exists" : (devices.push(doc), "created"),
    saveEndorsement: async (_o, newDeviceId, endorsement) => void saved.push({ newDeviceId, endorsement }),
    getDeviceWebAuthn: async () => null,
    createEndorseCode: async (r) => {
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
      queueMicrotask(() => pointers.get(id)?.()); // the migration's broadcast trigger
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
  };
  const tokens: Record<string, { uid: string; role: string; owner: string; deviceId?: string }> = {
    person: { uid: OWNER, role: "user", owner: OWNER },
    phone: { uid: `d_${phoneKeys.deviceId}`, role: "client", owner: OWNER, deviceId: phoneKeys.deviceId },
  };
  const deps: Deps = {
    repo: repo as ApiRepo,
    identity: {
      verify: async (t: string) => {
        if (!tokens[t]) throw new Error("bad token");
        return tokens[t];
      },
      mintPairingWatch: async (codeId: string) => `watch-${codeId}`,
      releasePairingWatch: async () => undefined,
      mintDevice: async (_o: string, id: string) => `device-hash-${id}`,
    } as unknown as Deps["identity"],
    audit: new MemoryAudit(),
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
    now: Date.now,
  };
  const app = createApp(deps);
  const api = (token: string) =>
    httpApi({
      baseUrl: "http://api.test",
      token: async () => token,
      fetch: ((input: URL | string, init?: RequestInit) => app.request(String(input), init)) as typeof fetch,
    });
  /** The same api as it was before /v1/devices/signin: the endorsement is the only way in. */
  const legacyApi = (token: string): ApiClient => {
    const inner = api(token);
    return {
      ...inner,
      post: async <T>(path: string, body: unknown) => {
        if (path === "/v1/devices/signin") throw new ApiError(404, "not_found");
        return inner.post<T>(path, body);
      },
    };
  };
  return { app, devices, saved, codes, pointers, phoneKeys, api, legacyApi, audit: deps.audit as MemoryAudit };
};

describe("desktop sign-in alone, end to end (ADR 0029, ADR 0032)", () => {
  it("the person's sign-in enrols the panel through the real api: no code, no phone", async () => {
    const w = await world();
    const desktopKeys = await generateDeviceKeys();
    const r = await enrollDesktop({
      owner: OWNER,
      name: "Chalito (desktop)",
      keys: { load: async () => desktopKeys, save: async () => undefined },
      userApi: w.api("person"),
      deviceApi: async () => w.api("person"),
      signer: (k) => DeviceClientKeys.create(k),
      platformAuthenticator: async () => false,
    });
    expect(r).toMatchObject({
      ok: true,
      deviceId: desktopKeys.deviceId,
      customToken: `device-hash-${desktopKeys.deviceId}`,
    });
    expect(w.codes.size).toBe(0);
    expect(w.devices.find((d) => d.deviceId === desktopKeys.deviceId)).toMatchObject({
      role: "client",
      kind: "web",
      enrolledVia: "sign_in",
      endorsedBy: null,
      revoked: false,
    });
    expect(w.saved).toHaveLength(0);
    expect(w.audit.events.map((e) => [e.action, e.meta])).toContainEqual(["device.enrolled", { via: "sign_in" }]);
  });

  it("a second computer signs in the same way while the first is still active", async () => {
    const w = await world();
    for (let i = 0; i < 2; i++) {
      const k = await generateDeviceKeys();
      const r = await enrollDesktop({
        owner: OWNER,
        name: "Chalito (desktop)",
        keys: { load: async () => k, save: async () => undefined },
        userApi: w.api("person"),
        deviceApi: async () => w.api("person"),
        signer: (key) => DeviceClientKeys.create(key),
        platformAuthenticator: async () => false,
      });
      expect(r.ok).toBe(true);
    }
    expect(w.devices.filter((d) => d.enrolledVia === "sign_in")).toHaveLength(2);
  });

  it("an api without /v1/devices/signin: unsupported, and no code for another device to approve", async () => {
    const w = await world();
    const k = await generateDeviceKeys();
    const r = await enrollDesktop({
      owner: OWNER,
      name: "Chalito (desktop)",
      keys: { load: async () => k, save: async () => undefined },
      userApi: w.legacyApi("person"),
      deviceApi: async () => w.api("person"),
      signer: (key) => DeviceClientKeys.create(key),
      platformAuthenticator: async () => false,
    });
    expect(r).toEqual({ ok: false, reason: "unsupported" });
    expect(w.codes.size).toBe(0);
    expect(w.devices.some((d) => d.deviceId === k.deviceId)).toBe(false);
  });
});
