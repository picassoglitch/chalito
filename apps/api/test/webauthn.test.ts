import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { describe, expect, it } from "vitest";
import {
  deriveDeviceId,
  fromB64url,
  generateSigningKeyPair,
  signEnvelope,
  toB64url,
  verifyWebAuthnAssertion,
} from "@chalito/crypto";
import { SoftAuthenticator } from "@chalito/client-keys/testing";
import type { DeviceDoc } from "@chalito/protocol";
import { createApp } from "../src/app.js";
import { MemoryAudit, type Deps } from "../src/deps.js";
import type { ApiRepo, StoredWebAuthnCredential, WebAuthnChallenge } from "../src/repo.js";
import { webauthnRoutes } from "../src/routes/webauthn.js";
import { Hono } from "hono";
import { device, owner } from "./contract/fixtures.js";

const RP = "chalito.chalyb.com";
const ORIGIN = `https://${RP}`;
const NOW = 1_790_000_000_000;

/** The slice of ApiRepo these routes use, in memory. */
const memoryRepo = (devices: DeviceDoc[]) => {
  const challenges = new Map<string, WebAuthnChallenge>();
  const creds = new Map<string, StoredWebAuthnCredential>();
  const key = (o: string, d: string, p: string) => `${o}/${d}/${p}`;
  const repo: Partial<ApiRepo> = {
    getDevice: async (o, id) => devices.find((d) => d.owner === o && d.deviceId === id) ?? null,
    putWebAuthnChallenge: async (c) => void challenges.set(key(c.owner, c.deviceId, c.purpose), c),
    takeWebAuthnChallenge: async (o, d, p, now) => {
      const c = challenges.get(key(o, d, p));
      challenges.delete(key(o, d, p));
      return c && c.expiresAt > now ? c.challenge : null;
    },
    setDeviceWebAuthn: async (o, d, cred) => {
      if (!devices.some((x) => x.owner === o && x.deviceId === d)) return false;
      creds.set(`${o}/${d}`, cred);
      return true;
    },
    getDeviceWebAuthn: async (o, d) => creds.get(`${o}/${d}`) ?? null,
    setDeviceWebAuthnBinding: async (o, d, binding) => {
      const c = creds.get(`${o}/${d}`);
      if (!c) return false;
      creds.set(`${o}/${d}`, { ...c, binding });
      return true;
    },
  };
  return { repo: repo as ApiRepo, challenges, creds };
};

const setup = async (opts: { now?: () => number; revoked?: boolean; phone?: Partial<DeviceDoc> } = {}) => {
  const o = owner();
  const phone = await device(o, "client", { revoked: opts.revoked ?? false, ...opts.phone });
  const mem = memoryRepo([phone]);
  const audit = new MemoryAudit();
  let clock = NOW;
  const deps: Deps = {
    repo: mem.repo,
    identity: {
      verify: async (t: string) => {
        if (t !== "phone-token") throw new Error("bad token");
        return { uid: `d_${phone.deviceId}`, role: "client", owner: o, deviceId: phone.deviceId };
      },
    } as unknown as Deps["identity"],
    audit,
    config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 60_000 },
    now: opts.now ?? (() => clock),
  };
  const app = new Hono().route(
    "/v1/webauthn",
    webauthnRoutes(deps, { rpId: RP, rpName: "Chalito", origins: [ORIGIN], challengeTtlMs: 60_000 }),
  );
  const post = async (path: string, body: unknown = {}, token = "phone-token") => {
    const res = await app.request(`/v1/webauthn${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    // Response bodies are loosely typed JSON in these assertions.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { o, phone, mem, audit, post, tick: (ms: number) => (clock += ms) };
};

describe("app wiring", () => {
  it("mounts /v1/webauthn", async () => {
    const deps = {
      repo: memoryRepo([]).repo,
      identity: {
        verify: async () => {
          throw new Error("x");
        },
      },
      audit: new MemoryAudit(),
      config: { ssoSecret: "s", adminToken: "a", recoveryCooldownMs: 1, skewMs: 1 },
      now: () => NOW,
    } as unknown as Deps;
    const res = await createApp(deps).request("/v1/webauthn/register/options", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe.each([[-7 as const], [-8 as const]])("WebAuthn routes with a software authenticator (COSE alg %s)", (alg) => {
  it("registers a passkey on the device record, then issues server-checked assertion challenges", async () => {
    const s = await setup();
    const auth = new SoftAuthenticator({ origin: ORIGIN, alg });
    const opts = await s.post("/register/options");
    expect(opts.status).toBe(200);
    expect(opts.json.options.rp.id).toBe(RP);
    expect(opts.json.options.authenticatorSelection.userVerification).toBe("required");
    const reg = await s.post("/register/verify", { response: await auth.create(opts.json.options) });
    expect(reg.status).toBe(201);
    expect(reg.json.credential).toEqual({ credentialId: auth.credentialId, publicKey: auth.publicKey, rpId: RP });
    expect(s.mem.creds.get(`${s.o}/${s.phone.deviceId}`)?.publicKey).toBe(auth.publicKey);
    expect(s.audit.events.at(-1)).toMatchObject({ action: "webauthn.registered", target: s.phone.deviceId });

    const a = await s.post("/assert/options");
    expect(a.json.options.allowCredentials).toEqual([
      { id: auth.credentialId, type: "public-key", transports: ["internal"] },
    ]);
    const challenge = [...s.mem.challenges.values()].find((c) => c.purpose === "assert")!.challenge;
    const resp = await auth.get(a.json.options);
    const stored = s.mem.creds.get(`${s.o}/${s.phone.deviceId}`)!;
    const v = await verifyAuthenticationResponse({
      response: resp,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP,
      credential: {
        id: stored.credentialId,
        publicKey: (await fromB64url(stored.publicKey)) as Uint8Array<ArrayBuffer>,
        counter: 0,
      },
      requireUserVerification: true,
    });
    expect(v.verified).toBe(true);
    // The agent's own verifier agrees on the stored key.
    expect(
      (
        await verifyWebAuthnAssertion({
          assertion: {
            credentialId: resp.id,
            authenticatorData: resp.response.authenticatorData,
            clientDataJSON: resp.response.clientDataJSON,
            signature: resp.response.signature,
          },
          credential: stored,
          expectedChallenge: await fromB64url(challenge),
          rpId: RP,
          origin: ORIGIN,
        })
      ).ok,
    ).toBe(true);
  });
});

describe("WebAuthn routes refuse", () => {
  it("a replayed, expired or missing registration challenge", async () => {
    const s = await setup();
    const auth = new SoftAuthenticator({ origin: ORIGIN });
    const opts = await s.post("/register/options");
    const response = await auth.create(opts.json.options);
    expect((await s.post("/register/verify", { response })).status).toBe(201);
    expect((await s.post("/register/verify", { response })).json).toEqual({ error: "challenge_expired" });
    const opts2 = await s.post("/register/options");
    s.tick(61_000);
    expect((await s.post("/register/verify", { response: await auth.create(opts2.json.options) })).json).toEqual({
      error: "challenge_expired",
    });
  });

  it("a response from the wrong origin, without user verification, or malformed", async () => {
    const s = await setup();
    for (const auth of [
      new SoftAuthenticator({ origin: "https://evil.example" }),
      new SoftAuthenticator({ origin: ORIGIN, flags: 0x01 }),
    ]) {
      const opts = await s.post("/register/options");
      const r = await s.post("/register/verify", { response: await auth.create(opts.json.options) });
      expect(r).toEqual({ status: 400, json: { error: "bad_registration" } });
    }
    await s.post("/register/options");
    expect((await s.post("/register/verify", { response: { id: "x" } })).json).toEqual({ error: "bad_registration" });
    expect((await s.post("/register/verify", {})).json).toEqual({ error: "bad_request" });
    expect(s.mem.creds.size).toBe(0);
  });

  it("assertion options before any passkey, unauthenticated callers, and revoked devices", async () => {
    const s = await setup();
    expect(await s.post("/assert/options")).toEqual({ status: 409, json: { error: "no_passkey" } });
    expect((await s.post("/register/options", {}, "nope")).status).toBe(401);
    const r = await setup({ revoked: true });
    expect((await r.post("/register/options")).status).toBe(403);
  });
});

describe("passkey binding (chalito.webauthn-binding.v1)", () => {
  const phoneKeys = async () => {
    const sign = await generateSigningKeyPair();
    return { sign, deviceId: await deriveDeviceId(sign.publicKey), pubSign: await toB64url(sign.publicKey) };
  };
  const bind = (
    k: Awaited<ReturnType<typeof phoneKeys>>,
    body: { credentialId: string; publicKey: string; rpId?: string },
    signer = k,
  ) =>
    signEnvelope(
      "chalito.webauthn-binding.v1",
      { v: 1 as const, deviceId: k.deviceId, rpId: RP, issuedAt: NOW, ...body },
      signer.deviceId,
      signer.sign.secretKey,
    );
  const registered = async () => {
    const k = await phoneKeys();
    const s = await setup({ phone: { deviceId: k.deviceId, pubSign: k.pubSign } });
    const auth = new SoftAuthenticator({ origin: ORIGIN });
    const opts = await s.post("/register/options");
    expect((await s.post("/register/verify", { response: await auth.create(opts.json.options) })).status).toBe(201);
    return { s, k, auth };
  };

  it("stores a binding signed by the device's own key for its registered passkey", async () => {
    const { s, k, auth } = await registered();
    const binding = await bind(k, { credentialId: auth.credentialId, publicKey: auth.publicKey });
    const res = await s.post("/register/bind", { binding });
    expect(res).toEqual({ status: 200, json: { ok: true } });
    expect(s.mem.creds.get(`${s.o}/${k.deviceId}`)?.binding).toEqual(binding);
    expect(s.audit.events.at(-1)).toMatchObject({ action: "webauthn.bound", target: k.deviceId });
  });

  it("refuses a binding signed by another key, for another credential or another relying party", async () => {
    const { s, k, auth } = await registered();
    const other = await phoneKeys();
    const forged = {
      ...(await bind(k, { credentialId: auth.credentialId, publicKey: auth.publicKey }, other)),
      signerDeviceId: k.deviceId,
    };
    expect((await s.post("/register/bind", { binding: forged })).json.error).toBe("bad_binding_invalid_signature");
    expect(
      (
        await s.post("/register/bind", {
          binding: await bind(k, { credentialId: "b3RoZXI", publicKey: auth.publicKey }),
        })
      ).json.error,
    ).toBe("bad_binding_credential_mismatch");
    expect(
      (
        await s.post("/register/bind", {
          binding: await bind(k, { credentialId: auth.credentialId, publicKey: auth.publicKey, rpId: "evil.example" }),
        })
      ).json.error,
    ).toBe("bad_binding_expected_rp_mismatch");
    expect(s.mem.creds.get(`${s.o}/${k.deviceId}`)?.binding).toBeUndefined();
  });

  it("needs a registered passkey first", async () => {
    const k = await phoneKeys();
    const s = await setup({ phone: { deviceId: k.deviceId, pubSign: k.pubSign } });
    const res = await s.post("/register/bind", {
      binding: await bind(k, { credentialId: "Y3JlZA", publicKey: "cHVi" }),
    });
    expect(res.status).toBe(409);
  });
});
