import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Recovery-code hashing with scrypt (node:crypto, no native addon). The code carries
 * 130 bits of entropy, so the KDF guards against a leaked hash, not guessing.
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEYLEN = 32;

const derive = (code: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(code.replace(/-/g, ""), salt, KEYLEN, PARAMS, (err, key) => (err ? reject(err) : resolve(key))),
  );

export interface RecoveryHash {
  alg: "scrypt";
  salt: string;
  hash: string;
  N: number;
  r: number;
  p: number;
}

export const hashRecoveryCode = async (code: string): Promise<RecoveryHash> => {
  const salt = randomBytes(16);
  const key = await derive(code, salt);
  return {
    alg: "scrypt",
    salt: salt.toString("base64url"),
    hash: key.toString("base64url"),
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
  };
};

export const verifyRecoveryCode = async (code: string, stored: RecoveryHash): Promise<boolean> => {
  const key = await derive(code, Buffer.from(stored.salt, "base64url"));
  const expected = Buffer.from(stored.hash, "base64url");
  return key.length === expected.length && timingSafeEqual(key, expected);
};
