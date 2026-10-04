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

/**
 * A client device's identity (ADR 0003): Ed25519 for signing, X25519 for sealed content.
 * The device id is derived from the signing key, so a key can't claim another device's id.
 */
export interface DeviceKeys {
  deviceId: string;
  sign: SigningKeyPair;
  box: BoxKeyPair;
}

export const generateDeviceKeys = async (): Promise<DeviceKeys> => {
  const sign = await generateSigningKeyPair();
  return { deviceId: await deriveDeviceId(sign.publicKey), sign, box: await generateBoxKeyPair() };
};

/** Public half, as the API and agents see it. */
export const publicKeys = async (k: DeviceKeys) => ({
  deviceId: k.deviceId,
  pubSign: await toB64url(k.sign.publicKey),
  pubBox: await toB64url(k.box.publicKey),
  fingerprint: await fingerprint(k.sign.publicKey),
});

// ---------------------------------------------------------------- at-rest protection
const DB_VERSION = 1;
const STORE = "keys";
const RECORD = "device";
const AGENTS = "agents";
const AAD_CTX = "chalito.keyvault.v1:";

interface VaultRecord {
  /** Non-extractable AES-GCM-256 key; IndexedDB stores the handle, never its bytes. */
  wrapKey: CryptoKey;
  deviceId: string;
  iv: Uint8Array;
  ct: Uint8Array;
}

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("indexeddb request failed"));
  });

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexeddb transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("indexeddb transaction aborted"));
  });

const aad = (deviceId: string) => new TextEncoder().encode(AAD_CTX + deviceId);
const agentsAad = (deviceId: string) => new TextEncoder().encode(`chalito.trusted-agents.v1:${deviceId}`);

/** An agent this client verified itself (signed glyph + the user's fingerprint confirmation). */
export interface TrustedAgent {
  deviceId: string;
  pubSign: string;
  pubBox: string;
  fingerprint: string;
  label: string;
  confirmedAt: number;
}

/**
 * Keeps the device's libsodium secrets in IndexedDB, encrypted with a NON-extractable WebCrypto
 * AES-GCM key that lives in the same database (browsers persist CryptoKey handles without
 * exposing their bytes to script). A copy of the database is useless without the browser's own
 * key storage, and no script can export the wrapping key. The plaintext secrets exist in memory
 * only while the app uses them (ADR 0003: libsodium keys wrapped by a non-extractable key).
 */
export class KeyVault {
  private constructor(
    private readonly db: IDBDatabase,
    private readonly subtle: SubtleCrypto,
  ) {}

  static async open(
    name = "chalito-keys",
    env: { indexedDB?: IDBFactory; subtle?: SubtleCrypto } = {},
  ): Promise<KeyVault> {
    const idb = env.indexedDB ?? globalThis.indexedDB;
    const subtle = env.subtle ?? globalThis.crypto?.subtle;
    if (!idb || !subtle) throw new Error("KeyVault needs IndexedDB and WebCrypto");
    const open = idb.open(name, DB_VERSION);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    return new KeyVault(await req(open), subtle);
  }

  /** Wraps and stores the device keys, replacing any previous identity. */
  async save(keys: DeviceKeys): Promise<void> {
    // A new identity starts with no trusted agents (they were confirmed by the old key).
    const wrapKey = await this.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const secrets = new TextEncoder().encode(
      JSON.stringify({
        signPk: await toB64url(keys.sign.publicKey),
        signSk: await toB64url(keys.sign.secretKey),
        boxPk: await toB64url(keys.box.publicKey),
        boxSk: await toB64url(keys.box.secretKey),
      }),
    );
    const ct = new Uint8Array(
      await this.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(keys.deviceId) }, wrapKey, secrets),
    );
    secrets.fill(0);
    const tx = this.db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ wrapKey, deviceId: keys.deviceId, iv, ct } satisfies VaultRecord, RECORD);
    tx.objectStore(STORE).delete(AGENTS);
    await done(tx);
  }

  /** The stored keys, or null when this browser has no device identity yet. */
  async load(): Promise<DeviceKeys | null> {
    const tx = this.db.transaction(STORE, "readonly");
    const rec = (await req(tx.objectStore(STORE).get(RECORD))) as VaultRecord | undefined;
    if (!rec) return null;
    const plain = new Uint8Array(
      await this.subtle.decrypt(
        { name: "AES-GCM", iv: rec.iv as Uint8Array<ArrayBuffer>, additionalData: aad(rec.deviceId) },
        rec.wrapKey,
        rec.ct as Uint8Array<ArrayBuffer>,
      ),
    );
    const s = JSON.parse(new TextDecoder().decode(plain)) as Record<"signPk" | "signSk" | "boxPk" | "boxSk", string>;
    plain.fill(0);
    const keys: DeviceKeys = {
      deviceId: rec.deviceId,
      sign: { publicKey: await fromB64url(s.signPk), secretKey: await fromB64url(s.signSk) },
      box: { publicKey: await fromB64url(s.boxPk), secretKey: await fromB64url(s.boxSk) },
    };
    if ((await deriveDeviceId(keys.sign.publicKey)) !== keys.deviceId) throw new Error("key vault: device id mismatch");
    return keys;
  }

  /**
   * The agents this client trusts, encrypted with the same non-extractable key (so the list
   * can't be edited in IndexedDB without failing authentication). Needs a saved identity.
   */
  async saveTrustedAgents(agents: TrustedAgent[]): Promise<void> {
    const rec = await this.#record();
    if (!rec) throw new Error("key vault: no device identity");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await this.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: agentsAad(rec.deviceId) },
        rec.wrapKey,
        new TextEncoder().encode(JSON.stringify(agents)),
      ),
    );
    const tx = this.db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ iv, ct }, AGENTS);
    await done(tx);
  }

  async loadTrustedAgents(): Promise<TrustedAgent[]> {
    const rec = await this.#record();
    if (!rec) return [];
    const tx = this.db.transaction(STORE, "readonly");
    const a = (await req(tx.objectStore(STORE).get(AGENTS))) as { iv: Uint8Array; ct: Uint8Array } | undefined;
    if (!a) return [];
    const plain = await this.subtle.decrypt(
      { name: "AES-GCM", iv: a.iv as Uint8Array<ArrayBuffer>, additionalData: agentsAad(rec.deviceId) },
      rec.wrapKey,
      a.ct as Uint8Array<ArrayBuffer>,
    );
    return JSON.parse(new TextDecoder().decode(plain)) as TrustedAgent[];
  }

  async #record(): Promise<VaultRecord | undefined> {
    const tx = this.db.transaction(STORE, "readonly");
    return (await req(tx.objectStore(STORE).get(RECORD))) as VaultRecord | undefined;
  }

  /** Forgets the identity and its trusted agents (sign-out of this device, or after revocation). */
  async destroy(): Promise<void> {
    const tx = this.db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(RECORD);
    tx.objectStore(STORE).delete(AGENTS);
    await done(tx);
  }

  close(): void {
    this.db.close();
  }
}
