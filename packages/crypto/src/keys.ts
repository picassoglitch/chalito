import { ready } from "./sodium.js";

export interface SigningKeyPair {
  /** Ed25519 public key, 32 bytes. */
  publicKey: Uint8Array;
  /** Ed25519 secret key (libsodium format, 64 bytes). */
  secretKey: Uint8Array;
}

export interface BoxKeyPair {
  /** X25519 public key, 32 bytes. */
  publicKey: Uint8Array;
  /** X25519 secret key, 32 bytes. */
  secretKey: Uint8Array;
}

export const generateSigningKeyPair = async (): Promise<SigningKeyPair> => {
  const s = await ready();
  const { publicKey, privateKey } = s.crypto_sign_keypair();
  return { publicKey, secretKey: privateKey };
};

export const generateBoxKeyPair = async (): Promise<BoxKeyPair> => {
  const s = await ready();
  const { publicKey, privateKey } = s.crypto_box_keypair();
  return { publicKey, secretKey: privateKey };
};

export const randomBytes = async (n: number): Promise<Uint8Array> => (await ready()).randombytes_buf(n);
