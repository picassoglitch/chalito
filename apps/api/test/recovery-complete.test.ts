import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { deriveDeviceId, generateBoxKeyPair, generateSigningKeyPair, signEnvelope, toB64url } from "@chalito/crypto";
import { DeviceRegistrationBody, type DeviceDoc } from "@chalito/protocol";
import { MemoryAudit, type Deps } from "../src/deps.js";
import { hashRecoveryCode } from "../src/lib/recovery.js";
import type { ApiRepo, StoredRecovery } from "../src/repo.js";
import { recoveryRoutes } from "../src/routes/recovery.js";

const O = "hub-user-1";
const CODE = "ABCDE-FGHJK-MNPQR-STVWX-YZ0123";
const NEXT = "ABCDE-FGHJK-MNPQR-STVWX-YZ0456";

const registration = async (now: number) => {
  const sign = await generateSigningKeyPair();
  const deviceId = await deriveDeviceId(sign.publicKey);
  const body = DeviceRegistrationBody.parse({
    v: 1,
    owner: O,
    deviceId,
    kind: "phone",
    platform: "web",
    name: "Nuevo",
    pubSign: await toB64url(sign.publicKey),
    pubBox: await toB64url((await generateBoxKeyPair()).publicKey),
    issuedAt: now,
  });
  return signEnvelope("chalito.device-register.v1", body, deviceId, sign.secretKey);
};

/**
 * Audit 2026-10-08: a recovery code completes one recovery. The route hands the verified hash to the
 * repo, which refuses (code_changed) once a concurrent completion has replaced it.
 */
describe("POST /v1/recovery/complete", () => {
  const setup = async (result: "ok" | "device_exists" | "code_changed") => {
    const now = 1_790_000_000_000;
    const rec: StoredRecovery = { ...(await hashRecoveryCode(CODE)), cooldownUntil: now - 1 };
    const calls: { doc: DeviceDoc; expectHash: string | undefined }[] = [];
    const repo: Partial<ApiRepo> = {
      getRecovery: async () => rec,
      completeRecovery: async (_o, doc, _next, expectHash) => {
        calls.push({ doc, expectHash });
        return result;
      },
    };
    const deps = {
      repo,
      identity: {
        verify: async () => ({ uid: O, role: "user", owner: O }),
        mintDevice: async () => "device-token",
      },
      audit: new MemoryAudit(),
      config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
      now: () => now,
    } as unknown as Deps;
    const app = new Hono().route("/v1/recovery", recoveryRoutes(deps));
    const res = await app.request("/v1/recovery/complete", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer person" },
      body: JSON.stringify({ recoveryCode: CODE, newRecoveryCode: NEXT, registration: await registration(now) }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown>, calls, rec };
  };

  it("passes the verified code's hash, so the repo can refuse a code another completion used", async () => {
    const r = await setup("ok");
    expect(r.status).toBe(201);
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.expectHash).toBe(r.rec.hash);
  });

  it("a code used meanwhile is 409 recovery_used, not a second device", async () => {
    const r = await setup("code_changed");
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ error: "recovery_used" });
  });
});
