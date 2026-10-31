import { describe, expect, it } from "vitest";
import { endorsementChannel, endorsementMatches } from "@chalito/client";
import {
  ApiError,
  endorseGlyph,
  generateDeviceKeys,
  signDeviceRegistration,
  type ApiClient,
} from "@chalito/client-keys";
import type { DeviceKeys } from "@chalito/client-keys";
import { fingerprint, signEnvelope } from "@chalito/crypto";
import { verifyGlyph } from "@chalito/glyph";
import type { DeviceRegistration, Endorsement, GlyphPayload } from "@chalito/protocol";
import { approveTarget, browserName, resolveTarget } from "@/lib/endorse";

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

/** An older app (no sign-in approval) opening a code, as packages/client does on its side. */
const olderApp = async (srv: ReturnType<typeof server>, name = "Chrome en Mac") => {
  const keys = await generateDeviceKeys();
  const registration = await signDeviceRegistration(keys, {
    owner: OWNER,
    kind: "web",
    platform: "web",
    name,
    now: Date.now(),
  });
  const channel = endorsementChannel({
    api: srv.api,
    watch: srv.watch,
    glyphFor: (code) => endorseGlyph(keys, code, { label: name, now: Date.now() }),
    pollMs: 60_000,
  });
  return { keys, registration, ...(await channel.open(registration)) };
};

describe("approving another device's code (/v1/endorse)", () => {
  it("a trusted browser resolves an older app's code, compares the fingerprint, and endorses exactly its keys", async () => {
    const srv = server();
    const trusted = await generateDeviceKeys();
    const older = await olderApp(srv);
    const g = (older.display as { glyph: GlyphPayload }).glyph;
    expect(g.body.purpose).toBe("endorse_client");
    expect((await verifyGlyph(g, Date.now())).ok).toBe(true);

    // Typed with spaces and lower case: normalised before it reaches the api.
    const r = await resolveTarget(srv.api, { shortCode: "kq7r m2xz" }, Date.now());
    if (!r.ok) throw new Error(r.reason);
    expect(r.target.display.fingerprint).toBe(await fingerprint(older.keys.sign.publicKey));
    expect(r.target.display.name).toBe("Chrome en Mac");
    // Or scanned: the same target.
    const scanned = await resolveTarget(srv.api, { glyph: g }, Date.now());
    expect(scanned.ok && scanned.target.display.deviceId).toBe(older.keys.deviceId);

    expect(await approveTarget(srv.api, signer(trusted), r.target, { owner: OWNER, now: Date.now() })).toEqual({
      ok: true,
    });
    expect(endorsementMatches(await older.endorsement, older.registration)).toBe(true);
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

    const older = await olderApp(srv, "x");
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
    older.cancel();
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
