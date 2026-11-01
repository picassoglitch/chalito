/** The one paired board: its key id and the shared secret as a non-extractable HMAC key. */
export interface PairedBoard {
  keyId: string;
  key: CryptoKey;
}

/** Where the pairing lives; every window of the app sees the same one. */
export interface PairStore {
  load(): Promise<PairedBoard | null>;
  save(p: PairedBoard): Promise<void>;
  clear(): Promise<void>;
  /** Another window (or this one) paired or forgot the board. */
  onChange(cb: () => void): () => void;
}

const hex = (b: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** BOARD_LINK pairing: the key id is the first 16 hex of sha256(secret). */
export const keyIdOf = async (secret: Uint8Array<ArrayBuffer>): Promise<string> =>
  hex(await crypto.subtle.digest("SHA-256", secret)).slice(0, 16);

/** The secret as an HMAC key nothing can read back (not even this app's own scripts). */
export const hmacKey = (secret: Uint8Array<ArrayBuffer>): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

const decideData = (aid: string, ticket: string, allow: boolean) =>
  new TextEncoder().encode(`v1|decide|${aid}|${ticket}|${allow ? "true" : "false"}`);

/** What a paired board puts in `mac` (lowercase hex HMAC-SHA256). */
export const decideMac = async (key: CryptoKey, aid: string, ticket: string, allow: boolean): Promise<string> =>
  hex(await crypto.subtle.sign("HMAC", key, decideData(aid, ticket, allow)));

/** Checks a decide's mac; WebCrypto's HMAC verify compares in constant time. */
export const verifyDecideMac = async (
  key: CryptoKey,
  d: { aid: string; ticket: string; allow: boolean },
  mac: unknown,
): Promise<boolean> => {
  if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac)) return false;
  const bytes = Uint8Array.from(mac.match(/../g)!, (h) => parseInt(h, 16));
  return crypto.subtle.verify("HMAC", key, bytes, decideData(d.aid, d.ticket, d.allow));
};

/** 32 random bytes and a 6-digit code (uniform, no modulo bias). */
export const newPairing = (): { secret: Uint8Array<ArrayBuffer>; code: string } => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const n = new Uint32Array(1);
  do crypto.getRandomValues(n);
  while (n[0]! >= 4_294_000_000);
  return { secret, code: String(n[0]! % 1_000_000).padStart(6, "0") };
};

/** In memory: tests and a browser without IndexedDB (pairing then lasts until the app quits). */
export const memoryPairStore = (): PairStore => {
  let p: PairedBoard | null = null;
  const subs = new Set<() => void>();
  const emit = () => subs.forEach((f) => f());
  return {
    load: async () => p,
    save: async (next) => void ((p = next), emit()),
    clear: async () => void ((p = null), emit()),
    onChange: (cb) => (subs.add(cb), () => void subs.delete(cb)),
  };
};

const DB = "chalito-board";
const STORE = "pair";
const RECORD = "board";
const CHANNEL = "chalito-board-pairing";

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("indexeddb"));
  });

/** Like the device keys (client-keys KeyVault): IndexedDB holding a non-extractable CryptoKey. */
export const idbPairStore = (idb: IDBFactory = indexedDB): PairStore => {
  let db: Promise<IDBDatabase> | null = null;
  const open = () => {
    if (!db) {
      const o = idb.open(DB, 1);
      o.onupgradeneeded = () => o.result.createObjectStore(STORE);
      db = req(o);
    }
    return db;
  };
  const tx = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode).objectStore(STORE);
  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  const subs = new Set<() => void>();
  const emit = () => {
    subs.forEach((f) => f());
    channel?.postMessage("changed");
  };
  channel?.addEventListener("message", () => subs.forEach((f) => f()));
  return {
    load: async () => {
      const v = (await req((await tx("readonly")).get(RECORD))) as PairedBoard | undefined;
      return v && typeof v.keyId === "string" && v.key instanceof CryptoKey ? v : null;
    },
    save: async (p) => {
      await req((await tx("readwrite")).put({ keyId: p.keyId, key: p.key }, RECORD));
      emit();
    },
    clear: async () => {
      await req((await tx("readwrite")).delete(RECORD));
      emit();
    },
    onChange: (cb) => (subs.add(cb), () => void subs.delete(cb)),
  };
};
