import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

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

export const authenticator = (alg: -7 | -8) => {
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
