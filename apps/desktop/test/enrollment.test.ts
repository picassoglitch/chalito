import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  DeviceClientKeys,
  generateDeviceKeys,
  publicKeys,
  signEndorsement,
  type ApiClient,
  type DeviceKeys,
} from "@chalito/client-keys";
import type { DeviceRegistration, Endorsement } from "@chalito/protocol";
import {
  EndorsementUnavailableError,
  SIGN_IN_INTRODUCER,
  enrollDesktop,
  unavailableEndorsement,
  type EndorsementChannel,
  type EnrollDeps,
} from "../src/lib/enrollment.js";
import { needsStepUp, platformAuthenticatorAvailable } from "../src/lib/stepup.js";

const OWNER = "8a7a0d3c-5b5e-4a39-9d2b-2f8b1e0c4a11";
const NOW = 1_780_000_000_000;

/** A trusted phone that endorses whatever registration it's shown (or a tampered version). */
const phone = async () => {
  const keys = await generateDeviceKeys();
  const endorse = (reg: DeviceRegistration, over: Partial<{ uid: string; newDeviceId: string }> = {}) =>
    signEndorsement(keys, {
      uid: over.uid ?? reg.body.owner,
      newDeviceId: over.newDeviceId ?? reg.body.deviceId,
      pubSign: reg.body.pubSign,
      pubBox: reg.body.pubBox,
      now: NOW,
    });
  return { keys, endorse };
};

const channelFrom = (
  endorse: (reg: DeviceRegistration) => Promise<Endorsement>,
): EndorsementChannel & { seen: DeviceRegistration[] } => {
  const seen: DeviceRegistration[] = [];
  return {
    seen,
    open: async (reg) => {
      seen.push(reg);
      return { display: { shortCode: "ABCDE" }, endorsement: endorse(reg), cancel: vi.fn() };
    },
  };
};

const memoryKeys = (initial: DeviceKeys | null = null) => {
  let k = initial;
  return { load: async () => k, save: vi.fn(async (n: DeviceKeys) => void (k = n)) };
};

/** An api without /v1/devices/signin (404), unless `signIn` answers it: the endorsement fallback. */
const userApi = (
  impl?: (path: string, body: unknown) => unknown,
  signIn?: (body: unknown) => unknown,
): ApiClient & { calls: [string, unknown][] } => {
  const calls: [string, unknown][] = [];
  return {
    calls,
    post: async <T>(path: string, body: unknown) => {
      if (path === "/v1/devices/signin") {
        if (!signIn) throw new ApiError(404, "not_found");
        calls.push([path, body]);
        return signIn(body) as T;
      }
      calls.push([path, body]);
      if (impl) return impl(path, body) as T;
      const b = body as { registration: DeviceRegistration };
      return { customToken: "device-hash", deviceId: b.registration.body.deviceId } as T;
    },
  };
};

const base = async (over: Partial<EnrollDeps> = {}): Promise<EnrollDeps> => {
  const p = await phone();
  return {
    owner: OWNER,
    name: "Chalito (escritorio)",
    keys: memoryKeys(),
    channel: channelFrom((reg) => p.endorse(reg)),
    userApi: userApi(),
    deviceApi: async () => userApi(),
    signer: (k) => DeviceClientKeys.create(k),
    platformAuthenticator: async () => false,
    now: () => NOW,
    ...over,
  };
};

const enrolled = (body: unknown) => ({
  customToken: "device-hash",
  deviceId: (body as { registration: DeviceRegistration }).registration.body.deviceId,
});

describe("desktop enrolment by sign-in alone (owner decision 2026-10-19)", () => {
  it("the person's sign-in enrols this panel: no code, no second device", async () => {
    const keys = memoryKeys();
    const api = userApi(undefined, enrolled);
    const open = vi.fn();
    const display = vi.fn();
    const r = await enrollDesktop({ ...(await base({ keys, userApi: api, channel: { open } })), onDisplay: display });
    expect(r).toMatchObject({ ok: true, customToken: "device-hash", passkey: "unavailable" });
    expect(api.calls.map((c) => c[0])).toEqual(["/v1/devices/signin"]);
    const reg = (api.calls[0]![1] as { registration: DeviceRegistration }).registration;
    expect(reg.body).toMatchObject({ owner: OWNER, kind: "web", platform: "web", name: "Chalito (escritorio)" });
    expect(reg.signerDeviceId).toBe(reg.body.deviceId);
    expect(r.ok && r.deviceId).toBe(reg.body.deviceId);
    expect(open).not.toHaveBeenCalled();
    expect(display).not.toHaveBeenCalled();
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
        userApi: userApi(undefined, enrolled),
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

  it("keys left from an earlier attempt (taken or revoked) are replaced, once", async () => {
    const old = await generateDeviceKeys();
    const keys = memoryKeys(old);
    let n = 0;
    const api = userApi(undefined, (body) => {
      if (n++ === 0) throw new ApiError(409, "device_exists");
      return enrolled(body);
    });
    const r = await enrollDesktop(await base({ keys, userApi: api }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.deviceId).not.toBe(old.deviceId);
    expect(keys.save).toHaveBeenCalledTimes(1);
    expect(api.calls).toHaveLength(2);
  });

  it.each([
    [new ApiError(403, "owner_mismatch"), "rejected"],
    [new ApiError(503, "unavailable"), "failed"],
    [new Error("network"), "failed"],
  ] as const)("a refusal %s → %s (no endorsement fallback)", async (err, reason) => {
    const open = vi.fn();
    const api = userApi(undefined, () => {
      throw err;
    });
    expect(await enrollDesktop(await base({ userApi: api, channel: { open } }))).toEqual({ ok: false, reason });
    expect(open).not.toHaveBeenCalled();
  });
});

describe("desktop enrolment (endorsed new client, the fallback for an api without /v1/devices/signin)", () => {
  it("generates and stores keys, signs its registration, posts it with the endorsement", async () => {
    const keys = memoryKeys();
    const api = userApi();
    const d = await base({ keys, userApi: api });
    const display = vi.fn();
    const r = await enrollDesktop({ ...d, onDisplay: display });
    expect(r).toMatchObject({ ok: true, customToken: "device-hash", passkey: "unavailable", credential: null });
    expect(keys.save).toHaveBeenCalledTimes(1);
    expect(display).toHaveBeenCalledWith({ shortCode: "ABCDE" });
    const [path, body] = api.calls[0]!;
    expect(path).toBe("/v1/devices/endorsed");
    const reg = (body as { registration: DeviceRegistration }).registration;
    expect(reg.body).toMatchObject({ owner: OWNER, kind: "web", platform: "web", name: "Chalito (escritorio)" });
    expect(reg.signerDeviceId).toBe(reg.body.deviceId);
  });

  it("reuses stored keys (same identity on retry)", async () => {
    const existing = await generateDeviceKeys();
    const keys = memoryKeys(existing);
    const r = await enrollDesktop(await base({ keys }));
    expect(r.ok && r.deviceId).toBe(existing.deviceId);
    expect(keys.save).not.toHaveBeenCalled();
  });

  describe("rejection paths", () => {
    it("no endorsement transport yet", async () => {
      expect(await enrollDesktop(await base({ channel: unavailableEndorsement }))).toEqual({
        ok: false,
        reason: "channel_unavailable",
      });
      expect(new EndorsementUnavailableError().message).toBe("endorsement_channel_unavailable");
    });

    it("endorsement for another account or another device is refused locally (nothing posted)", async () => {
      const p = await phone();
      const otherDevice = (await generateDeviceKeys()).deviceId;
      for (const over of [{ uid: "00000000-0000-4000-8000-000000000000" }, { newDeviceId: otherDevice }]) {
        const api = userApi();
        const r = await enrollDesktop(
          await base({ userApi: api, channel: channelFrom((reg) => p.endorse(reg, over)) }),
        );
        expect(r).toEqual({ ok: false, reason: "endorsement_mismatch" });
        expect(api.calls).toEqual([]);
      }
    });

    it("cancelled while waiting for the phone", async () => {
      const ac = new AbortController();
      const cancel = vi.fn();
      const channel: EndorsementChannel = {
        open: async () => ({ display: null, endorsement: new Promise<Endorsement>(() => undefined), cancel }),
      };
      const pending = enrollDesktop({ ...(await base({ channel })), signal: ac.signal });
      ac.abort();
      expect(await pending).toEqual({ ok: false, reason: "cancelled" });
      expect(cancel).toHaveBeenCalled();
    });

    it.each([
      [new ApiError(403, "endorser_not_trusted"), "endorser_not_trusted"],
      [new ApiError(409, "device_exists"), "device_exists"],
      [new ApiError(400, "stale_endorsement"), "rejected"],
      [new ApiError(503, "unavailable"), "failed"],
      [new Error("network"), "failed"],
    ] as const)("api refusal %s → %s", async (err, reason) => {
      const api = userApi(() => {
        throw err;
      });
      expect(await enrollDesktop(await base({ userApi: api }))).toEqual({ ok: false, reason });
    });

    it("a credential for another device id is not used", async () => {
      const other = (await generateDeviceKeys()).deviceId;
      const api = userApi(() => ({ customToken: "h", deviceId: other }));
      expect(await enrollDesktop(await base({ userApi: api }))).toEqual({ ok: false, reason: "failed" });
    });
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
