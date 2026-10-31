import { describe, expect, it } from "vitest";
import {
  ApiError,
  generateDeviceKeys,
  type ApiClient,
  type DeviceKeys,
  type DirectoryDevice,
} from "@chalito/client-keys";
import { deriveDeviceId, fromB64url, toB64url, verifyEnvelope } from "@chalito/crypto";
import type { DeviceRegistration, IntroducedAgent } from "@chalito/protocol";
import { SIGN_IN_INTRODUCER, enrolBySignIn } from "@/lib/sign-in-enrol";

const OWNER = "u_owner";

const agentRow = async (over: Partial<DirectoryDevice> = {}): Promise<DirectoryDevice> => {
  const k = await generateDeviceKeys();
  return {
    deviceId: k.deviceId,
    role: "agent",
    revoked: false,
    pubSign: await toB64url(k.sign.publicKey),
    pubBox: await toB64url(k.box.publicKey),
    ...over,
  };
};

/** /v1/devices/signin as apps/api answers it: the registration must be self-signed for the owner. */
const signinApi = (fail?: ApiError) => {
  const posted: { path: string; registration: DeviceRegistration }[] = [];
  const api: ApiClient = {
    post: async <T>(path: string, body: unknown): Promise<T> => {
      const registration = (body as { registration: DeviceRegistration }).registration;
      posted.push({ path, registration });
      if (fail) throw fail;
      return { customToken: "tok", deviceId: registration.body.deviceId } as T;
    },
  };
  return { api, posted };
};

const deps = (api: ApiClient, extra: Partial<Parameters<typeof enrolBySignIn>[0]> = {}) => {
  const saved: DeviceKeys[] = [];
  const trusted: { agents: IntroducedAgent[]; by: string }[] = [];
  return {
    saved,
    trusted,
    d: {
      api,
      save: async (k: DeviceKeys) => void saved.push(k),
      owner: OWNER,
      name: "Chrome en Mac",
      trust: async (_k: DeviceKeys, agents: IntroducedAgent[], by: string) => void trusted.push({ agents, by }),
      ...extra,
    },
  };
};

describe("ADR 0032: signing in approves this browser", () => {
  it("posts a fresh self-signed registration, saves the keys first, and trusts the account's computers", async () => {
    const srv = signinApi();
    const good = await agentRow();
    const revoked = await agentRow({ revoked: true });
    // A row whose id isn't derived from its key: never trusted.
    const forged = { ...(await agentRow()), deviceId: good.deviceId.replace(/.$/, "x") };
    const client = { ...(await agentRow()), role: "client" as const };
    const t = deps(srv.api, { directory: async () => [good, revoked, forged, client] });

    const r = await enrolBySignIn(t.d);

    expect(r).toEqual({ ok: true, deviceId: t.saved[0]!.deviceId, customToken: "tok", computers: 1 });
    expect(srv.posted).toHaveLength(1);
    expect(srv.posted[0]!.path).toBe("/v1/devices/signin");
    const reg = srv.posted[0]!.registration;
    expect(reg.body).toMatchObject({ owner: OWNER, kind: "web", platform: "web", name: "Chrome en Mac" });
    // What apps/api's checkRegistration verifies: id derived from the key, signed by that key.
    const pub = await fromB64url(reg.body.pubSign);
    expect(await deriveDeviceId(pub)).toBe(reg.body.deviceId);
    expect(reg.body.deviceId).toBe(t.saved[0]!.deviceId);
    const sig = await verifyEnvelope(reg, "chalito.device-register.v1", new Map([[reg.body.deviceId, pub]]));
    expect(sig.ok).toBe(true);
    expect(t.trusted).toEqual([
      { agents: [expect.objectContaining({ deviceId: good.deviceId })], by: SIGN_IN_INTRODUCER },
    ]);
  });

  it("a new identity every time: a leftover or revoked one never comes back", async () => {
    const srv = signinApi();
    const a = deps(srv.api);
    const b = deps(srv.api);
    const ra = await enrolBySignIn(a.d);
    const rb = await enrolBySignIn(b.d);
    expect(ra.ok && rb.ok && ra.deviceId !== rb.deviceId).toBe(true);
  });

  it("maps the api's refusals to readable reasons", async () => {
    const cases: [ApiError, string][] = [
      [new ApiError(404, "not_found"), "unsupported"],
      [new ApiError(409, "device_exists"), "device_exists"],
      [new ApiError(403, "forbidden"), "rejected"],
      [new ApiError(503, "unavailable"), "failed"],
    ];
    for (const [err, reason] of cases) {
      const t = deps(signinApi(err).api);
      expect(await enrolBySignIn(t.d)).toEqual({ ok: false, reason });
      expect(t.trusted).toEqual([]);
    }
    const offline = deps({
      post: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await enrolBySignIn(offline.d)).toEqual({ ok: false, reason: "failed" });
  });

  it("refuses an answer for another device id", async () => {
    const t = deps({ post: async <T>() => ({ customToken: "tok", deviceId: "dev_someone_else" }) as T });
    expect(await enrolBySignIn(t.d)).toEqual({ ok: false, reason: "failed" });
  });

  it("an unreadable directory still approves the browser: computers come on the next connect", async () => {
    const t = deps(signinApi().api, {
      directory: async () => {
        throw new Error("rls");
      },
    });
    const r = await enrolBySignIn(t.d);
    expect(r.ok && r.computers).toBe(0);
  });
});
