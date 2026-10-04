import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize, stepUpChallenge, verifyWebAuthnAssertion, parseCoseKey } from "../src/index.js";

// ---- a minimal software authenticator (ES256 or Ed25519), enough to produce real assertions
const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString("base64url");
const cborHead = (major: number, n: number) =>
  n < 24 ? [(major << 5) | n] : n < 256 ? [(major << 5) | 24, n] : [(major << 5) | 25, n >> 8, n & 255];
const cborInt = (n: number) => (n >= 0 ? cborHead(0, n) : cborHead(1, -1 - n));
const cborBytes = (b: Uint8Array) => [...cborHead(2, b.length), ...b];
const coseKey = (alg: -7 | -8, pub: KeyObject) => {
  const jwk = pub.export({ format: "jwk" });
  const x = Buffer.from(jwk.x!, "base64url");
  if (alg === -8)
    return new Uint8Array([
      ...cborHead(5, 4),
      ...cborInt(1),
      ...cborInt(1),
      ...cborInt(3),
      ...cborInt(-8),
      ...cborInt(-1),
      ...cborInt(6),
      ...cborInt(-2),
      ...cborBytes(x),
    ]);
  const y = Buffer.from(jwk.y!, "base64url");
  return new Uint8Array([
    ...cborHead(5, 5),
    ...cborInt(1),
    ...cborInt(2),
    ...cborInt(3),
    ...cborInt(-7),
    ...cborInt(-1),
    ...cborInt(1),
    ...cborInt(-2),
    ...cborBytes(x),
    ...cborInt(-3),
    ...cborBytes(y),
  ]);
};

const authenticator = (alg: -7 | -8) => {
  const { publicKey, privateKey } =
    alg === -7 ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : generateKeyPairSync("ed25519");
  const credentialId = b64u(Buffer.from(`cred-${alg}-${Math.random()}`));
  let count = 0;
  return {
    credential: { credentialId, publicKey: b64u(coseKey(alg, publicKey)) },
    get(opts: { challenge: Uint8Array; rpId: string; origin: string; flags?: number; type?: string }) {
      const rpHash = createHash("sha256").update(opts.rpId).digest();
      const authData = Buffer.concat([rpHash, Buffer.from([opts.flags ?? 0x05]), Buffer.from([0, 0, 0, ++count])]);
      const clientDataJSON = Buffer.from(
        JSON.stringify({
          type: opts.type ?? "webauthn.get",
          challenge: b64u(opts.challenge),
          origin: opts.origin,
          crossOrigin: false,
        }),
      );
      const data = Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]);
      const signature =
        alg === -7 ? sign("sha256", data, { key: privateKey, dsaEncoding: "der" }) : sign(null, data, privateKey);
      return {
        credentialId,
        authenticatorData: b64u(authData),
        clientDataJSON: b64u(clientDataJSON),
        signature: b64u(signature),
      };
    },
  };
};

const RP = "chalito.chalyb.com";
const ORIGIN = "https://chalito.chalyb.com";
const body = {
  v: 1,
  aid: "a1",
  requestId: "r1",
  uid: "u1",
  targetDeviceId: "dev_agent",
  allow: true,
  nonce: "n".repeat(22),
  issuedAt: 1,
  expiresAt: 2,
};

describe("stepUpChallenge", () => {
  it("is SHA-256 of the JCS decision body without stepUp", async () => {
    const expected = createHash("sha256").update(canonicalize(body)).digest();
    expect(Buffer.from(await stepUpChallenge({ ...body, stepUp: { method: "webauthn", at: 1 } }))).toEqual(expected);
    expect(Buffer.from(await stepUpChallenge({ ...body, allow: false }))).not.toEqual(expected);
  });
});

describe.each([
  [-7 as const, "ES256"],
  [-8 as const, "EdDSA"],
])("verifyWebAuthnAssertion (%s %s)", (alg, _name) => {
  it("accepts a fresh, user-verified assertion over the right challenge", async () => {
    const a = authenticator(alg);
    expect(parseCoseKey(Buffer.from(a.credential.publicKey, "base64url"))?.alg).toBe(alg);
    const challenge = await stepUpChallenge(body);
    const res = await verifyWebAuthnAssertion({
      assertion: a.get({ challenge, rpId: RP, origin: ORIGIN }),
      credential: a.credential,
      expectedChallenge: challenge,
      rpId: RP,
      origin: ORIGIN,
    });
    expect(res).toEqual({ ok: true, signCount: 1, userVerified: true });
  });

  it("rejects every binding mismatch and a forged signature", async () => {
    const a = authenticator(alg);
    const other = authenticator(alg);
    const challenge = await stepUpChallenge(body);
    const check = (
      assertion: ReturnType<typeof a.get>,
      over: Partial<{ challenge: Uint8Array; rpId: string; origin: string }> = {},
    ) =>
      verifyWebAuthnAssertion({
        assertion,
        credential: a.credential,
        expectedChallenge: over.challenge ?? challenge,
        rpId: over.rpId ?? RP,
        origin: over.origin ?? ORIGIN,
      });
    const good = a.get({ challenge, rpId: RP, origin: ORIGIN });
    expect(await check(good, { challenge: await stepUpChallenge({ ...body, allow: false }) })).toMatchObject({
      reason: "wrong_challenge",
    });
    expect(await check(a.get({ challenge, rpId: RP, origin: "https://evil.example" }))).toMatchObject({
      reason: "wrong_origin",
    });
    expect(await check(a.get({ challenge, rpId: "evil.example", origin: ORIGIN }))).toMatchObject({
      reason: "wrong_rp",
    });
    expect(await check(a.get({ challenge, rpId: RP, origin: ORIGIN, flags: 0x01 }))).toMatchObject({
      reason: "user_not_verified",
    });
    expect(await check(a.get({ challenge, rpId: RP, origin: ORIGIN, flags: 0x04 }))).toMatchObject({
      reason: "user_not_present",
    });
    expect(await check(a.get({ challenge, rpId: RP, origin: ORIGIN, type: "webauthn.create" }))).toMatchObject({
      reason: "wrong_type",
    });
    expect(
      await check({ ...other.get({ challenge, rpId: RP, origin: ORIGIN }), credentialId: a.credential.credentialId }),
    ).toMatchObject({ reason: "bad_signature" });
    expect(await check(other.get({ challenge, rpId: RP, origin: ORIGIN }))).toMatchObject({
      reason: "wrong_credential",
    });
    expect(await check({ ...good, signature: "AAAA" })).toMatchObject({ ok: false });
    expect(await check({ ...good, authenticatorData: "!!" })).toMatchObject({ ok: false });
  });
});
