import { describe, expect, it } from "vitest";
import { ApiError, generateDeviceKeys, signEndorsement, type ApiClient } from "@chalito/client-keys";
import type { DeviceKeys } from "@chalito/client-keys";
import { fingerprint, signEnvelope } from "@chalito/crypto";
import { verifyGlyph } from "@chalito/glyph";
import type { DeviceRegistration, Endorsement, GlyphPayload } from "@chalito/protocol";
import { approveTarget, browserName, resolveTarget, waitForEndorsement } from "@/lib/endorse";

const OWNER = "u_owner";
const CODE_ID = "c".repeat(22);

/** Just enough of /v1/endorse and /v1/devices/endorsed to run both sides in one process. */
const server = () => {
  let reg: DeviceRegistration | null = null;
  let endorsement: Endorsement | null = null;
  let onPointer: (() => void) | null = null;
  const calls: string[] = [];
  const api: ApiClient = {
    post: async <T>(path: string, body: unknown): Promise<T> => {
      calls.push(path);
      const b = body as Record<string, unknown>;
      switch (path) {
        case "/v1/endorse/codes":
          reg = b.registration as DeviceRegistration;
          return { codeId: CODE_ID, shortCode: "KQ7R-M2XZ", watchToken: "w", expiresAt: Date.now() + 300_000 } as T;
        case "/v1/endorse/resolve":
          if (!reg) throw new ApiError(404, "not_found");
          if ("shortCode" in b && b.shortCode !== "KQ7R-M2XZ") throw new ApiError(404, "not_found");
          return { codeId: CODE_ID, registration: reg, expiresAt: Date.now() + 300_000 } as T;
        case "/v1/endorse/approve":
          endorsement = b.endorsement as Endorsement;
          onPointer?.();
          return { ok: true } as T;
        case "/v1/endorse/take":
          if (!endorsement) throw new ApiError(409, "not_endorsed");
          return { endorsement } as T;
        case "/v1/devices/endorsed":
          return { customToken: "tok", deviceId: (b.registration as DeviceRegistration).body.deviceId } as T;
      }
      throw new ApiError(404, "not_found");
    },
  };
  return {
    api,
    calls,
    watch: async (_c: string, _t: string, f: () => void) => {
      onPointer = f;
      return () => (onPointer = null);
    },
    setEndorsement: (e: Endorsement) => {
      endorsement = e;
      onPointer?.();
    },
    registration: () => reg!,
  };
};

const signer = (k: DeviceKeys) => ({
  deviceId: k.deviceId,
  sign: <T>(ctx: Parameters<typeof signEnvelope>[0], body: T) => signEnvelope(ctx, body, k.deviceId, k.sign.secretKey),
});

describe("adding a browser (/v1/endorse)", () => {
  it("new browser waits, a trusted one resolves the short code, compares the fingerprint, approves; it enrols", async () => {
    const srv = server();
    const trusted = await generateDeviceKeys();
    const saved: DeviceKeys[] = [];
    const w = await waitForEndorsement({
      api: srv.api,
      watch: srv.watch,
      save: async (k) => void saved.push(k),
      owner: OWNER,
      name: "Chrome en Mac",
      pollMs: 60_000,
    });
    if ("error" in w) throw new Error(w.error);
    expect(saved).toHaveLength(1);
    expect(w.display.shortCode).toBe("KQ7R-M2XZ");
    // The glyph is signed by the very key that registers.
    const g = w.display.glyph as GlyphPayload;
    expect(g.body.purpose).toBe("endorse_client");
    expect((await verifyGlyph(g, Date.now())).ok).toBe(true);
    expect(w.fingerprint).toBe(await fingerprint(saved[0]!.sign.publicKey));

    // Typed with spaces and lower case: normalised before it reaches the api.
    const r = await resolveTarget(srv.api, { shortCode: "kq7r m2xz" }, Date.now());
    if (!r.ok) throw new Error(r.reason);
    expect(r.target.display.fingerprint).toBe(w.fingerprint);
    expect(r.target.display.name).toBe("Chrome en Mac");
    // Or scanned: the same target.
    const scanned = await resolveTarget(srv.api, { glyph: g }, Date.now());
    expect(scanned.ok && scanned.target.display.deviceId).toBe(saved[0]!.deviceId);

    expect(await approveTarget(srv.api, signer(trusted), r.target, { owner: OWNER, now: Date.now() })).toEqual({
      ok: true,
    });
    expect(await w.result).toEqual({ ok: true, deviceId: saved[0]!.deviceId, customToken: "tok" });
    expect(srv.calls).toContain("/v1/devices/endorsed");
  });

  it("refuses an endorsement for other keys, and maps expiry and cancel", async () => {
    const srv = server();
    const w = await waitForEndorsement({
      api: srv.api,
      watch: srv.watch,
      save: async () => {},
      owner: OWNER,
      name: "x",
    });
    if ("error" in w) throw new Error(w.error);
    const someoneElse = await generateDeviceKeys();
    const reg = srv.registration().body;
    srv.setEndorsement(
      await signEndorsement(someoneElse, {
        uid: OWNER,
        newDeviceId: reg.deviceId,
        pubSign: reg.pubSign,
        pubBox: "A".repeat(43), // not this browser's box key
        now: Date.now(),
      }),
    );
    expect(await w.result).toEqual({ ok: false, reason: "endorsement_mismatch" });
    expect(srv.calls).not.toContain("/v1/devices/endorsed");

    const w2 = await waitForEndorsement({
      api: srv.api,
      watch: srv.watch,
      save: async () => {},
      owner: OWNER,
      name: "x",
    });
    if ("error" in w2) throw new Error(w2.error);
    w2.cancel();
    expect(await w2.result).toEqual({ ok: false, reason: "cancelled" });
  });

  it("trusted side: bad codes, wrong account, own device, and api codes become readable reasons", async () => {
    const srv = server();
    expect(await resolveTarget(srv.api, { shortCode: "nope" }, Date.now())).toEqual({
      ok: false,
      reason: "invalid_code",
    });
    expect(await resolveTarget(srv.api, { shortCode: "AAAA-BBBB" }, Date.now())).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(await resolveTarget(srv.api, { glyph: { nope: 1 } }, Date.now())).toEqual({
      ok: false,
      reason: "invalid_code",
    });

    const w = await waitForEndorsement({
      api: srv.api,
      watch: srv.watch,
      save: async () => {},
      owner: OWNER,
      name: "x",
    });
    if ("error" in w) throw new Error(w.error);
    const r = await resolveTarget(srv.api, { shortCode: "KQ7R-M2XZ" }, Date.now());
    if (!r.ok) throw new Error(r.reason);
    const trusted = signer(await generateDeviceKeys());
    expect(await approveTarget(srv.api, trusted, r.target, { owner: "u_other", now: Date.now() })).toEqual({
      ok: false,
      reason: "wrong_account",
    });
    const refusing: ApiClient = {
      post: async () => {
        throw new ApiError(401, "step_up_required");
      },
    };
    expect(await approveTarget(refusing, trusted, r.target, { owner: OWNER, now: Date.now() })).toEqual({
      ok: false,
      reason: "step_up",
    });
    const cloned: ApiClient = {
      post: async () => {
        throw new ApiError(403, "authenticator_cloned");
      },
    };
    expect(await approveTarget(cloned, trusted, r.target, { owner: OWNER, now: Date.now() })).toEqual({
      ok: false,
      reason: "passkey_cloned",
    });
    // A cancelled passkey prompt is a step-up problem too, and nothing is posted.
    const stepUp = async () => {
      throw Object.assign(new Error("cancelled"), { name: "NotAllowedError" });
    };
    expect(await approveTarget(srv.api, trusted, r.target, { owner: OWNER, now: Date.now(), stepUp })).toEqual({
      ok: false,
      reason: "step_up",
    });
    expect(srv.calls).not.toContain("/v1/endorse/approve");
    w.cancel();
  });

  it("names the browser from its user agent", () => {
    const mac =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
    expect(browserName(mac, "es")).toBe("Chrome en Mac");
    expect(browserName(mac, "en")).toBe("Chrome on Mac");
    expect(browserName("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", "es")).toBe(
      "Firefox en Linux",
    );
    expect(browserName("", "es")).toBe("Navegador");
  });
});
