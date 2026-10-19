import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { deriveDeviceId, generateBoxKeyPair, generateSigningKeyPair, signEnvelope, toB64url } from "@chalito/crypto";
import { DeviceRegistrationBody, type DeviceDoc, type DeviceRegistration } from "@chalito/protocol";
import { MemoryAudit, type Deps } from "../src/deps.js";
import type { ApiRepo } from "../src/repo.js";
import { deviceRoutes } from "../src/routes/devices.js";
import { owner } from "./contract/fixtures.js";

const NOW = 1_790_000_000_000;
const WA = {
  rpId: "chalito.chalyb.com",
  rpName: "Chalito",
  origins: ["https://chalito.chalyb.com"],
  challengeTtlMs: 60_000,
};

const keysFor = async () => {
  const sign = await generateSigningKeyPair();
  const box = await generateBoxKeyPair();
  return { deviceId: await deriveDeviceId(sign.publicKey), sign, box };
};
type Keys = Awaited<ReturnType<typeof keysFor>>;

const register = async (
  k: Keys,
  o: { owner: string; kind?: "web" | "phone"; now?: number; signer?: Keys },
): Promise<DeviceRegistration> => {
  const body = DeviceRegistrationBody.parse({
    v: 1,
    owner: o.owner,
    deviceId: k.deviceId,
    kind: o.kind ?? "web",
    platform: "web",
    name: "Chalito (desktop)",
    pubSign: await toB64url(k.sign.publicKey),
    pubBox: await toB64url(k.box.publicKey),
    issuedAt: o.now ?? NOW,
  });
  const by = o.signer ?? k;
  return signEnvelope("chalito.device-register.v1", body, by.deviceId, by.sign.secretKey);
};

const setup = () => {
  const o = owner();
  const other = owner();
  const devices: DeviceDoc[] = [];
  const notifications: { owner: string; nid: string; deepLink: string; coalesceKey: string }[] = [];
  const repo: Partial<ApiRepo> = {
    getDevice: async (ow, id) => devices.find((d) => d.owner === ow && d.deviceId === id) ?? null,
    createDevice: async (_ow, doc) => {
      if (devices.some((d) => d.deviceId === doc.deviceId)) return "exists";
      devices.push(doc);
      return "created";
    },
    createNotification: async (ow, nid, n) =>
      void notifications.push({
        owner: ow,
        nid,
        deepLink: String(n.deepLink),
        coalesceKey: String(n.coalesceKey),
      }),
  };
  const tokens: Record<string, { uid: string; role: string; owner: string; deviceId?: string }> = {
    person: { uid: o, role: "user", owner: o },
    "other-person": { uid: other, role: "user", owner: other },
    client: { uid: "d_x", role: "client", owner: o, deviceId: "x" },
  };
  const minted: { owner: string; deviceId: string; role: string }[] = [];
  const audit = new MemoryAudit();
  const deps: Deps = {
    repo: repo as ApiRepo,
    identity: {
      verify: async (t: string) => {
        const c = tokens[t];
        if (!c) throw new Error("bad token");
        return c;
      },
      mintDevice: async (ow: string, deviceId: string, role: string) => {
        minted.push({ owner: ow, deviceId, role });
        return `device-token-${deviceId}`;
      },
    } as unknown as Deps["identity"],
    audit,
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
    now: () => NOW,
  };
  const app = new Hono().route("/v1/devices", deviceRoutes(deps, WA));
  const post = async (body: unknown, token = "person") => {
    const res = await app.request("/v1/devices/signin", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { o, other, devices, notifications, minted, audit, post };
};

describe("POST /v1/devices/signin (sign-in alone)", () => {
  it("enrols the device as a client of the account, with no endorsement", async () => {
    const s = setup();
    const k = await keysFor();
    const r = await s.post({ registration: await register(k, { owner: s.o }) });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ customToken: `device-token-${k.deviceId}`, deviceId: k.deviceId });
    expect(s.devices).toHaveLength(1);
    expect(s.devices[0]).toMatchObject({
      owner: s.o,
      deviceId: k.deviceId,
      role: "client",
      enrolledVia: "sign_in",
      endorsedBy: null,
      revoked: false,
    });
    expect(s.minted).toEqual([{ owner: s.o, deviceId: k.deviceId, role: "client" }]);
    expect(s.audit.events.map((e) => [e.action, e.meta])).toContainEqual(["device.enrolled", { via: "sign_in" }]);
  });

  it("works for the first device and for every later one (no second device needed)", async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) {
      const k = await keysFor();
      expect((await s.post({ registration: await register(k, { owner: s.o }) })).status).toBe(201);
    }
    expect(s.devices.map((d) => d.enrolledVia)).toEqual(["sign_in", "sign_in", "sign_in"]);
  });

  it("tells every device of the account, with Devices one tap away", async () => {
    const s = setup();
    const k = await keysFor();
    await s.post({ registration: await register(k, { owner: s.o }) });
    expect(s.notifications).toEqual([
      expect.objectContaining({ owner: s.o, deepLink: "/dispositivos", coalesceKey: `security:signin:${k.deviceId}` }),
    ]);
  });

  it("keeps the registration checks: another account, a key that didn't sign it, a stale one", async () => {
    const s = setup();
    const k = await keysFor();
    expect((await s.post({ registration: await register(k, { owner: s.other }) })).json.error).toBe("owner_mismatch");
    const forger = await keysFor();
    expect((await s.post({ registration: await register(k, { owner: s.o, signer: forger }) })).status).toBe(400);
    expect(
      (await s.post({ registration: await register(k, { owner: s.o, now: NOW - 60 * 60 * 1000 }) })).json.error,
    ).toBe("stale_request");
    expect(s.devices).toHaveLength(0);
  });

  it("needs the person's own session (not a device's) and refuses a device twice", async () => {
    const s = setup();
    const k = await keysFor();
    const reg = await register(k, { owner: s.o });
    expect((await s.post({ registration: reg }, "client")).status).toBe(403);
    expect((await s.post({ registration: reg }, "nobody")).status).toBe(401);
    expect((await s.post({ registration: reg })).status).toBe(201);
    expect((await s.post({ registration: reg })).json.error).toBe("device_exists");
    expect((await s.post({ nope: true })).json.error).toBe("bad_request");
  });

  it("a failed alert still enrols the device", async () => {
    const s = setup();
    const k = await keysFor();
    s.notifications.push = () => {
      throw new Error("db down");
    };
    expect((await s.post({ registration: await register(k, { owner: s.o }) })).status).toBe(201);
  });
});
