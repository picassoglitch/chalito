import type { RoomSealed } from "@chalito/protocol";
import { fromB64url, toB64url, utf8 } from "./encoding.js";
import type { BoxKeyPair } from "./keys.js";
import { ready } from "./sodium.js";

export interface WrappedRoomKey {
  epoch: number;
  ct: string;
}

export const generateRoomKey = async (): Promise<Uint8Array> =>
  (await ready()).crypto_aead_xchacha20poly1305_ietf_keygen();

/** Wraps a room key for each member client device (sealed box). */
export const wrapRoomKey = async (
  key: Uint8Array,
  epoch: number,
  recipients: Readonly<Record<string, Uint8Array>>,
): Promise<Record<string, WrappedRoomKey>> => {
  const s = await ready();
  const out: Record<string, WrappedRoomKey> = {};
  for (const [id, pub] of Object.entries(recipients))
    out[id] = { epoch, ct: await toB64url(s.crypto_box_seal(key, pub)) };
  return out;
};

export const unwrapRoomKey = async (wrapped: WrappedRoomKey, keyPair: BoxKeyPair): Promise<Uint8Array> => {
  const s = await ready();
  return s.crypto_box_seal_open(await fromB64url(wrapped.ct), keyPair.publicKey, keyPair.secretKey);
};

/**
 * Starts a new epoch with a fresh key wrapped only to the remaining devices.
 * Called on leave/removal so a departed member can't read new events.
 */
export const rotateRoomKey = async (currentEpoch: number, remaining: Readonly<Record<string, Uint8Array>>) => {
  const epoch = currentEpoch + 1;
  const key = await generateRoomKey();
  return { epoch, key, wrapped: await wrapRoomKey(key, epoch, remaining) };
};

const roomAad = (roomId: string, epoch: number) => utf8(`chalito.room.v1:${roomId}:${epoch}`);

export const roomSeal = async (
  roomId: string,
  epoch: number,
  key: Uint8Array,
  plaintext: Uint8Array,
): Promise<RoomSealed> => {
  const s = await ready();
  const nonce = s.randombytes_buf(s.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const ct = s.crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, roomAad(roomId, epoch), null, nonce, key);
  return { alg: "xchacha20poly1305", epoch, nonce: await toB64url(nonce), ct: await toB64url(ct) };
};

/** Decrypts with the key for the event's epoch; throws if this device doesn't hold that epoch. */
export const roomOpen = async (
  roomId: string,
  sealed: RoomSealed,
  keyring: ReadonlyMap<number, Uint8Array>,
): Promise<Uint8Array> => {
  const s = await ready();
  const key = keyring.get(sealed.epoch);
  if (!key) throw new Error(`roomOpen: no key for epoch ${sealed.epoch}`);
  return s.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,
    await fromB64url(sealed.ct),
    roomAad(roomId, sealed.epoch),
    await fromB64url(sealed.nonce),
    key,
  );
};
