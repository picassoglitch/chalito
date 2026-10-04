import {
  deriveDeviceId,
  fingerprint,
  fromB64url,
  generateBoxKeyPair,
  generateSigningKeyPair,
  toB64url,
  type BoxKeyPair,
  type SigningKeyPair,
} from "@chalito/crypto";
import { SECRET_NAMES, type SecretStore } from "./secrets.js";

export interface Identity {
  deviceId: string;
  sign: SigningKeyPair;
  box: BoxKeyPair;
  pubSign: string;
  pubBox: string;
  fingerprint: string;
}

/** Loads the device keys from the OS keychain, creating them on first run. */
export const loadOrCreateIdentity = async (secrets: SecretStore): Promise<Identity> => {
  const raw = await secrets.get(SECRET_NAMES.identity);
  let sign: SigningKeyPair;
  let box: BoxKeyPair;
  if (raw) {
    const j = JSON.parse(raw) as { signPk: string; signSk: string; boxPk: string; boxSk: string };
    sign = { publicKey: await fromB64url(j.signPk), secretKey: await fromB64url(j.signSk) };
    box = { publicKey: await fromB64url(j.boxPk), secretKey: await fromB64url(j.boxSk) };
  } else {
    sign = await generateSigningKeyPair();
    box = await generateBoxKeyPair();
    await secrets.set(
      SECRET_NAMES.identity,
      JSON.stringify({
        signPk: await toB64url(sign.publicKey),
        signSk: await toB64url(sign.secretKey),
        boxPk: await toB64url(box.publicKey),
        boxSk: await toB64url(box.secretKey),
      }),
    );
  }
  return {
    deviceId: await deriveDeviceId(sign.publicKey),
    sign,
    box,
    pubSign: await toB64url(sign.publicKey),
    pubBox: await toB64url(box.publicKey),
    fingerprint: await fingerprint(sign.publicKey),
  };
};
