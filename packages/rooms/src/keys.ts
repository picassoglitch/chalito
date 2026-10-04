import {
  fromB64url,
  generateRoomKey,
  rotateRoomKey,
  roomOpen,
  roomSeal,
  unwrapRoomKey,
  utf8,
  wrapRoomKey,
  type BoxKeyPair,
} from "@chalito/crypto";
import {
  CreateRoomRequest,
  PostRoomEventRequest,
  RoomEventBody,
  RotateRoomKeyRequest,
  type RoomSealed,
} from "@chalito/protocol";

/** A device of a room member, as the api lists it (deviceId + X25519 key, base64url). */
export interface RoomDevice {
  deviceId: string;
  pubBox: string;
}

const boxKeys = async (devices: readonly RoomDevice[]) => {
  const out: Record<string, Uint8Array> = {};
  for (const d of devices) out[d.deviceId] = await fromB64url(d.pubBox);
  return out;
};

const flatten = (w: Record<string, { ct: string }>) =>
  Object.fromEntries(Object.entries(w).map(([id, v]) => [id, v.ct]));

/** Wraps a room key for one epoch to a member's client devices: deviceId → sealed key. */
export const wrapRoomKeyFor = async (key: Uint8Array, epoch: number, devices: readonly RoomDevice[]) =>
  flatten(await wrapRoomKey(key, epoch, await boxKeys(devices)));

/**
 * A new room: a fresh epoch-1 key, wrapped to the creator's own client devices. The key never
 * leaves the clients; the api only stores the sealed copies.
 */
export const newRoom = async (r: {
  roomId: string;
  type: "family" | "business" | "project";
  name: string;
  companionId: string;
  myDevices: readonly RoomDevice[];
}) => {
  const key = await generateRoomKey();
  const request = CreateRoomRequest.parse({
    roomId: r.roomId,
    type: r.type,
    name: r.name,
    companionId: r.companionId,
    wrappedKeys: await wrapRoomKeyFor(key, 1, r.myDevices),
  });
  return { request, key, epoch: 1 };
};

/**
 * After someone leaves: epoch + 1 with a fresh key, wrapped to exactly the remaining members'
 * devices, so the leaver can't read anything new.
 */
export const rotateRoom = async (r: {
  companionId: string;
  currentEpoch: number;
  remaining: Readonly<Record<string, readonly RoomDevice[]>>;
}) => {
  const all: RoomDevice[] = Object.values(r.remaining).flat();
  const { epoch, key, wrapped } = await rotateRoomKey(r.currentEpoch, await boxKeys(all));
  const byCompanion: Record<string, Record<string, string>> = {};
  for (const [companion, devices] of Object.entries(r.remaining))
    byCompanion[companion] = Object.fromEntries(devices.map((d) => [d.deviceId, wrapped[d.deviceId]!.ct]));
  return {
    request: RotateRoomKeyRequest.parse({ companionId: r.companionId, epoch, wrappedKeys: byCompanion }),
    key,
    epoch,
  };
};

/** This device's keys for a room, by epoch, from its own room_member_keys rows. */
export const unwrapKeyring = async (
  rows: readonly { epoch: number; ct: string }[],
  box: BoxKeyPair,
): Promise<Map<number, Uint8Array>> => {
  const ring = new Map<number, Uint8Array>();
  for (const r of rows) ring.set(r.epoch, await unwrapRoomKey({ epoch: r.epoch, ct: r.ct }, box));
  return ring;
};

/**
 * Seals a room event. The body must be one of the protocol's notification kinds (there is no kind
 * for an instruction), and the plaintext kind must match the event's public kind.
 */
export const sealRoomEvent = async (e: {
  roomId: string;
  epoch: number;
  key: Uint8Array;
  eid: string;
  companionId: string;
  to?: string[];
  urgency?: "low" | "normal" | "high" | "critical";
  body: RoomEventBody;
}) => {
  const body = RoomEventBody.parse(e.body);
  const ct = await roomSeal(e.roomId, e.epoch, e.key, utf8(JSON.stringify(body)));
  return PostRoomEventRequest.parse({
    eid: e.eid,
    companionId: e.companionId,
    to: e.to ?? [],
    kind: body.kind,
    urgency: e.urgency ?? "low",
    ct,
    keyEpoch: e.epoch,
  });
};

export interface RoomEventRow {
  room_id: string;
  eid: string;
  from_companion_id: string;
  to_companions: string[];
  kind: string;
  urgency: string;
  ct: RoomSealed;
  key_epoch: number;
  promoted: boolean;
  t: string | number;
  expires_at: string | number | null;
  rev: number | string;
}

/** Decrypts and validates one event; null if this device lacks the epoch key or it doesn't check out. */
export const openRoomEvent = async (
  row: RoomEventRow,
  keyring: ReadonlyMap<number, Uint8Array>,
): Promise<RoomEventBody | null> => {
  try {
    const plain = await roomOpen(row.room_id, row.ct, keyring);
    const body = RoomEventBody.safeParse(JSON.parse(new TextDecoder().decode(plain)));
    if (!body.success || body.data.kind !== row.kind) return null;
    return body.data;
  } catch {
    return null;
  }
};

/**
 * Client-side TTL: an event is gone at its expiry even before the server's purge runs (the read
 * policy hides it too, but a client may hold rows it fetched earlier).
 */
export const isVisible = (row: Pick<RoomEventRow, "expires_at">, now: number) =>
  row.expires_at === null || new Date(row.expires_at).getTime() > now;
