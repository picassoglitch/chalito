import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  DeviceClientKeys,
  generateDeviceKeys,
  publicKeys,
  type ApiClient,
  type DeviceKeys,
} from "@chalito/client-keys";
import type { DeviceRegistration } from "@chalito/protocol";
import { SIGN_IN_INTRODUCER, enrollDesktop, type EnrollDeps } from "../src/lib/enrollment.js";
import { needsStepUp, platformAuthenticatorAvailable } from "../src/lib/stepup.js";

const OWNER = "8a7a0d3c-5b5e-4a39-9d2b-2f8b1e0c4a11";
const NOW = 1_780_000_000_000;

const memoryKeys = (initial: DeviceKeys | null = null) => {
  let k = initial;
  return { load: async () => k, save: vi.fn(async (n: DeviceKeys) => void (k = n)) };
};

const enrolled = (body: unknown) => ({
  customToken: "device-hash",
  deviceId: (body as { registration: DeviceRegistration }).registration.body.deviceId,
});

/** The api: /v1/devices/signin enrols by default; `impl` answers every route instead. */
const userApi = (impl?: (path: string, body: unknown) => unknown): ApiClient & { calls: [string, unknown][] } => {
  const calls: [string, unknown][] = [];
  return {
    calls,
    post: async <T>(path: string, body: unknown) => {
      calls.push([path, body]);
      if (impl) return impl(path, body) as T;
      if (path === "/v1/devices/signin") return enrolled(body) as T;
      throw new ApiError(404, "not_found");
    },
  };
};

const base = async (over: Partial<EnrollDeps> = {}): Promise<EnrollDeps> => ({
  owner: OWNER,
  name: "Chalito (escritorio)",
  keys: memoryKeys(),
  userApi: userApi(),
  deviceApi: async () => userApi(),
  signer: (k) => DeviceClientKeys.create(k),
  platformAuthenticator: async () => false,
  now: () => NOW,
  ...over,
});

describe("desktop enrolment: signing in approves this computer (ADR 0029, ADR 0032)", () => {
  it("the person's sign-in enrols this panel: no code, no second device", async () => {
    const keys = memoryKeys();
    const api = userApi();
    const r = await enrollDesktop(await base({ keys, userApi: api }));
    expect(r).toMatchObject({ ok: true, customToken: "device-hash", passkey: "unavailable", credential: null });
    expect(keys.save).toHaveBeenCalledTimes(1);
    expect(api.calls.map((c) => c[0])).toEqual(["/v1/devices/signin"]);
    const reg = (api.calls[0]![1] as { registration: DeviceRegistration }).registration;
    expect(reg.body).toMatchObject({ owner: OWNER, kind: "web", platform: "web", name: "Chalito (escritorio)" });
    expect(reg.signerDeviceId).toBe(reg.body.deviceId);
    expect(r.ok && r.deviceId).toBe(reg.body.deviceId);
  });

  it("reuses stored keys (same identity on retry)", async () => {
    const existing = await generateDeviceKeys();
    const keys = memoryKeys(existing);
    const r = await enrollDesktop(await base({ keys }));
    expect(r.ok && r.deviceId).toBe(existing.deviceId);
    expect(keys.save).not.toHaveBeenCalled();
  });

  it("trusts the account's computers from the directory, and only ones whose id matches the key", async () => {
    const laptop = await generateDeviceKeys();
    const pub = await publicKeys(laptop);
    const forged = await generateDeviceKeys();
    const trust = vi.fn(async (_k: DeviceKeys, agents: { deviceId: string }[], by: string) => {
      expect(by).toBe(SIGN_IN_INTRODUCER);
      return agents.map((a) => a.deviceId);
    });
    const r = await enrollDesktop(
      await base({
        introduce: {
          directory: async () => [
            { ...pub, deviceId: laptop.deviceId, role: "agent", revoked: false },
            // Another id over the laptop's key: a directory swap, never trusted.
            { ...pub, deviceId: forged.deviceId, role: "agent", revoked: false },
            { ...pub, deviceId: laptop.deviceId, role: "client", revoked: false },
            { ...pub, deviceId: "gone", role: "agent", revoked: true },
          ],
          trust,
        },
      }),
    );
    expect(r).toMatchObject({ ok: true, agents: [laptop.deviceId] });
  });

  it("an unreadable directory still enrols: the computers come on the next connect", async () => {
    const r = await enrollDesktop(
      await base({
        introduce: {
          directory: async () => Promise.reject(new Error("rls")),
          trust: vi.fn(),
        },
      }),
    );
    expect(r).toMatchObject({ ok: true, agents: [] });
  });

  it("keys left from an earlier attempt (taken or revoked) are replaced, once", async () => {
    const old = await generateDeviceKeys();
    const keys = memoryKeys(old);
    let n = 0;
    const api = userApi((_p, body) => {
      if (n++ === 0) throw new ApiError(409, "device_exists");
      return enrolled(body);
    });
    const r = await enrollDesktop(await base({ keys, userApi: api }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.deviceId).not.toBe(old.deviceId);
    expect(keys.save).toHaveBeenCalledTimes(1);
    expect(api.calls).toHaveLength(2);
  });

  it("taken twice in a row: device_exists, no third try", async () => {
    const api = userApi(() => {
      throw new ApiError(409, "device_exists");
    });
    expect(await enrollDesktop(await base({ keys: memoryKeys(await generateDeviceKeys()), userApi: api }))).toEqual({
      ok: false,
      reason: "device_exists",
    });
    expect(api.calls).toHaveLength(2);
  });

  it.each([
    [new ApiError(404, "not_found"), "unsupported"],
    [new ApiError(403, "owner_mismatch"), "rejected"],
    [new ApiError(503, "unavailable"), "failed"],
    [new Error("network"), "failed"],
  ] as const)("a refusal %s → %s, and never a code for another device to approve", async (err, reason) => {
    const api = userApi(() => {
      throw err;
    });
    expect(await enrollDesktop(await base({ userApi: api }))).toEqual({ ok: false, reason });
    expect(api.calls.map((c) => c[0])).toEqual(["/v1/devices/signin"]);
  });

  it("a credential for another device id is not used", async () => {
    const other = (await generateDeviceKeys()).deviceId;
    const api = userApi(() => ({ customToken: "h", deviceId: other }));
    expect(await enrollDesktop(await base({ userApi: api }))).toEqual({ ok: false, reason: "failed" });
  });

  describe("passkey right after, where available", () => {
    it.each(["tauri://localhost", "http://tauri.localhost", ""])(
      "off https (%s) the attempt is skipped entirely: no ceremony, passkey unavailable",
      async (origin) => {
        const create = vi.fn();
        const r = await enrollDesktop(
          await base({
            origin,
            platformAuthenticator: async () => true,
            ceremonies: { create, get: vi.fn() },
          }),
        );
        expect(r).toMatchObject({ ok: true, passkey: "unavailable", credential: null });
        expect(create).not.toHaveBeenCalled();
      },
    );

    it("enrolls when a platform authenticator exists", async () => {
      const deviceApi = userApi((path) =>
        path === "/v1/webauthn/register/options"
          ? { options: { challenge: "c" } }
          : path === "/v1/webauthn/register/verify"
            ? { credential: { credentialId: "Y3JlZDE", publicKey: "cGstY29zZQ", rpId: "chalito.chalyb.com" } }
            : { ok: true },
      );
      const r = await enrollDesktop(
        await base({
          origin: "https://chalito.chalyb.com",
          platformAuthenticator: async () => true,
          deviceApi: async (tok) => (expect(tok).toBe("device-hash"), deviceApi),
          ceremonies: { create: async () => ({}) as never, get: async () => ({}) as never },
        }),
      );
      expect(r).toMatchObject({
        ok: true,
        passkey: "enrolled",
        credential: { credentialId: "Y3JlZDE", rpId: "chalito.chalyb.com" },
      });
    });

    it("a failing ceremony (e.g. webview origin ≠ rpId) leaves a working client without step-up", async () => {
      const r = await enrollDesktop(
        await base({
          origin: "https://chalito.chalyb.com",
          platformAuthenticator: async () => true,
          ceremonies: {
            create: async () => Promise.reject(new DOMException("origin", "SecurityError")),
            get: async () => ({}) as never,
          },
          deviceApi: async () => userApi((p) => (p.endsWith("options") ? { options: {} } : {})),
        }),
      );
      expect(r).toMatchObject({ ok: true, passkey: "failed", credential: null });
    });
  });
});

describe("step-up capability", () => {
  it("detects via isUserVerifyingPlatformAuthenticatorAvailable, never the user agent", async () => {
    expect(await platformAuthenticatorAvailable(undefined)).toBe(false);
    expect(await platformAuthenticatorAvailable({})).toBe(false);
    expect(
      await platformAuthenticatorAvailable({ isUserVerifyingPlatformAuthenticatorAvailable: async () => true }),
    ).toBe(true);
    expect(
      await platformAuthenticatorAvailable({ isUserVerifyingPlatformAuthenticatorAvailable: async () => false }),
    ).toBe(false);
    expect(
      await platformAuthenticatorAvailable({
        isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.reject(new Error("x")),
      }),
    ).toBe(false);
  });

  it("HIGH, CRITICAL or marked approvals need a step-up", () => {
    expect(needsStepUp({ risk: "LOW", stepUpRequired: false })).toBe(false);
    expect(needsStepUp({ risk: "MED", stepUpRequired: false })).toBe(false);
    expect(needsStepUp({ risk: "MED", stepUpRequired: true })).toBe(true);
    expect(needsStepUp({ risk: "HIGH", stepUpRequired: false })).toBe(true);
    expect(needsStepUp({ risk: "CRITICAL", stepUpRequired: false })).toBe(true);
  });
});
