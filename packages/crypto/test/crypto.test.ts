import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Decision, Fingerprint, RoomSealed, SealedEnvelope, type DecisionBody } from "@chalito/protocol";
import {
  MemoryNonceStore,
  canonicalize,
  fingerprint,
  generateBoxKeyPair,
  generateSigningKeyPair,
  open,
  openJson,
  randomNonce,
  roomOpen,
  roomSeal,
  rotateRoomKey,
  generateRoomKey,
  seal,
  sealJson,
  signEnvelope,
  unwrapRoomKey,
  utf8,
  verifyEnvelope,
  wrapRoomKey,
  fromUtf8,
  toB64url,
} from "../src/index.js";

const now = 1_790_000_000_000;

const decisionBody = async (over: Partial<DecisionBody> = {}): Promise<DecisionBody> => ({
  v: 1,
  aid: "a1",
  requestId: "r1",
  uid: "u1",
  targetDeviceId: "agent1",
  allow: true,
  nonce: await randomNonce(),
  issuedAt: now,
  expiresAt: now + 60_000,
  ...over,
});

describe("JCS", () => {
  it("sorts keys and drops whitespace", () => {
    expect(canonicalize({ b: 1, a: [true, null, "x"], c: { z: 1, y: 2 } })).toBe(
      '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}',
    );
  });
  it("is independent of key insertion order", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.oneof(fc.integer(), fc.string(), fc.boolean())), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        expect(canonicalize(reversed)).toBe(canonicalize(obj));
      }),
    );
  });
  it("rejects non-finite numbers", () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow();
  });
});

describe("signatures", () => {
  it("sign/verify round trip produces a valid protocol Decision", async () => {
    const phone = await generateSigningKeyPair();
    const env = await signEnvelope("chalito.decision.v1", await decisionBody(), "phone1", phone.secretKey);
    expect(Decision.safeParse(env).success).toBe(true);
    const res = await verifyEnvelope(env, "chalito.decision.v1", new Map([["phone1", phone.publicKey]]));
    expect(res).toEqual({ ok: true, signerDeviceId: "phone1" });
  });

  it("detects tampering with any field", async () => {
    const phone = await generateSigningKeyPair();
    const env = await signEnvelope(
      "chalito.decision.v1",
      await decisionBody({ allow: false }),
      "phone1",
      phone.secretKey,
    );
    const trusted = new Map([["phone1", phone.publicKey]]);
    const tampered = { ...env, body: { ...env.body, allow: true } };
    expect(await verifyEnvelope(tampered, "chalito.decision.v1", trusted)).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
    const retargeted = { ...env, body: { ...env.body, targetDeviceId: "agent2" } };
    expect((await verifyEnvelope(retargeted, "chalito.decision.v1", trusted)).ok).toBe(false);
  });

  it("rejects a signer the device never trusted (approver injection)", async () => {
    const phone = await generateSigningKeyPair();
    const injected = await generateSigningKeyPair();
    const env = await signEnvelope("chalito.decision.v1", await decisionBody(), "evil", injected.secretKey);
    const res = await verifyEnvelope(env, "chalito.decision.v1", new Map([["phone1", phone.publicKey]]));
    expect(res).toEqual({ ok: false, reason: "untrusted_signer" });
  });

  it("a signature for one context can't be replayed as another", async () => {
    const phone = await generateSigningKeyPair();
    const env = await signEnvelope("chalito.command.v1", await decisionBody(), "phone1", phone.secretKey);
    const trusted = new Map([["phone1", phone.publicKey]]);
    expect(await verifyEnvelope(env, "chalito.decision.v1", trusted)).toEqual({ ok: false, reason: "wrong_context" });
    const relabeled = { ...env, ctx: "chalito.decision.v1" as const };
    expect(await verifyEnvelope(relabeled, "chalito.decision.v1", trusted)).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });
});

describe("nonce replay", () => {
  it("accepts a nonce once and rejects replays until expiry", async () => {
    const store = new MemoryNonceStore();
    const n = await randomNonce();
    expect(await store.claim(n, now + 1000, now)).toBe(true);
    expect(await store.claim(n, now + 1000, now + 10)).toBe(false);
  });
  it("rejects already-expired messages", async () => {
    const store = new MemoryNonceStore();
    expect(await store.claim(await randomNonce(), now, now)).toBe(false);
  });
});

describe("sealed boxes", () => {
  it("round-trips for multiple recipients and matches the protocol shape", async () => {
    const [a, b, c] = await Promise.all([generateBoxKeyPair(), generateBoxKeyPair(), generateBoxKeyPair()]);
    const env = await sealJson(
      { prompt: "corre los tests" },
      { phone: a.publicKey, laptop: b.publicKey, agent: c.publicKey },
      "approval:a1",
    );
    expect(SealedEnvelope.safeParse(env).success).toBe(true);
    for (const [id, kp] of [
      ["phone", a],
      ["laptop", b],
      ["agent", c],
    ] as const) {
      expect(await openJson(env, id, kp, "approval:a1")).toEqual({ prompt: "corre los tests" });
    }
  });

  it("a non-recipient (e.g. a revoked key) can't open it", async () => {
    const [a, revoked] = await Promise.all([generateBoxKeyPair(), generateBoxKeyPair()]);
    const env = await seal(utf8("secreto"), { phone: a.publicKey });
    await expect(open(env, "revoked", revoked)).rejects.toThrow();
    const stolen = { ...env, keys: { revoked: env.keys.phone! } };
    await expect(open(stolen, "revoked", revoked)).rejects.toThrow();
  });

  it("binds ciphertext to its AAD", async () => {
    const a = await generateBoxKeyPair();
    const env = await seal(utf8("x"), { phone: a.publicKey }, "approval:a1");
    await expect(open(env, "phone", a, "approval:a2")).rejects.toThrow();
  });

  it("round-trips arbitrary bytes", async () => {
    const a = await generateBoxKeyPair();
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 512 }), async (bytes) => {
        const env = await seal(bytes, { d: a.publicKey });
        expect(await open(env, "d", a)).toEqual(bytes);
      }),
      { numRuns: 25 },
    );
  });
});

describe("room keys", () => {
  it("wrap/unwrap and seal/open with the protocol shape", async () => {
    const [dad, son] = await Promise.all([generateBoxKeyPair(), generateBoxKeyPair()]);
    const key = await generateRoomKey();
    const wrapped = await wrapRoomKey(key, 1, { dadPhone: dad.publicKey, sonPhone: son.publicKey });
    const sonKey = await unwrapRoomKey(wrapped.sonPhone!, son);
    const sealed = await roomSeal("room1", 1, key, utf8("¿Lo agendo?"));
    expect(RoomSealed.safeParse(sealed).success).toBe(true);
    expect(fromUtf8(await roomOpen("room1", sealed, new Map([[1, sonKey]])))).toBe("¿Lo agendo?");
  });

  it("after rotation a removed member can't read new events", async () => {
    const [dad, son, ex] = await Promise.all([generateBoxKeyPair(), generateBoxKeyPair(), generateBoxKeyPair()]);
    const k1 = await generateRoomKey();
    const w1 = await wrapRoomKey(k1, 1, { dad: dad.publicKey, son: son.publicKey, ex: ex.publicKey });
    const exKeyring = new Map([[1, await unwrapRoomKey(w1.ex!, ex)]]);

    const { epoch, key: k2, wrapped: w2 } = await rotateRoomKey(1, { dad: dad.publicKey, son: son.publicKey });
    expect(epoch).toBe(2);
    expect(w2.ex).toBeUndefined();
    const sealed = await roomSeal("room1", epoch, k2, utf8("nuevo"));
    await expect(roomOpen("room1", sealed, exKeyring)).rejects.toThrow();
    const sonKeyring = new Map([[2, await unwrapRoomKey(w2.son!, son)]]);
    expect(fromUtf8(await roomOpen("room1", sealed, sonKeyring))).toBe("nuevo");
  });

  it("room ciphertext can't be moved to another room", async () => {
    const key = await generateRoomKey();
    const sealed = await roomSeal("room1", 1, key, utf8("x"));
    await expect(roomOpen("room2", sealed, new Map([[1, key]]))).rejects.toThrow();
  });
});

describe("fingerprints", () => {
  it("matches the protocol format and is stable per key", async () => {
    const k = await generateSigningKeyPair();
    const fp = await fingerprint(k.publicKey);
    expect(Fingerprint.safeParse(fp).success).toBe(true);
    expect(await fingerprint(k.publicKey)).toBe(fp);
    const other = await generateSigningKeyPair();
    expect(await fingerprint(other.publicKey)).not.toBe(fp);
  });
  it("encodes 32-byte keys to the protocol's 43-char base64url", async () => {
    const k = await generateSigningKeyPair();
    expect(await toB64url(k.publicKey)).toHaveLength(43);
  });
});

describe("device ids", () => {
  it("are derived from the signing key and match the protocol pattern", async () => {
    const { deriveDeviceId } = await import("../src/index.js");
    const { DeviceIdPattern } = await import("@chalito/protocol");
    const k = await generateSigningKeyPair();
    const id = await deriveDeviceId(k.publicKey);
    expect(id).toMatch(DeviceIdPattern);
    expect(await deriveDeviceId(k.publicKey)).toBe(id);
  });
});
