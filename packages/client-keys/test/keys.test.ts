import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { deriveDeviceId, toB64url } from "@chalito/crypto";
import { KeyVault, generateDeviceKeys, publicKeys } from "../src/index.js";

const fresh = () => KeyVault.open("t", { indexedDB: new IDBFactory() });

describe("device keys", () => {
  it("derive the device id from the signing key", async () => {
    const k = await generateDeviceKeys();
    expect(k.deviceId).toBe(await deriveDeviceId(k.sign.publicKey));
    expect(k.deviceId).toMatch(/^dev_[A-Za-z0-9_-]{22}$/);
    const pub = await publicKeys(k);
    expect(pub.pubSign).toBe(await toB64url(k.sign.publicKey));
    expect(pub.fingerprint).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
  });
});

describe("KeyVault (IndexedDB + non-extractable AES-GCM)", () => {
  it("round-trips the keys and starts empty", async () => {
    const idb = new IDBFactory();
    const vault = await KeyVault.open("t", { indexedDB: idb });
    expect(await vault.load()).toBeNull();
    const k = await generateDeviceKeys();
    await vault.save(k);
    vault.close();
    const again = await KeyVault.open("t", { indexedDB: idb });
    expect(await again.load()).toEqual(k);
  });

  it("stores only ciphertext and a wrapping key that can't be exported", async () => {
    const idb = new IDBFactory();
    const vault = await KeyVault.open("t", { indexedDB: idb });
    const k = await generateDeviceKeys();
    await vault.save(k);
    const raw = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const open = idb.open("t");
      open.onsuccess = () => {
        const get = open.result.transaction("keys").objectStore("keys").get("device");
        get.onsuccess = () => resolve(get.result as Record<string, unknown>);
        get.onerror = () => reject(get.error);
      };
    });
    const wrapKey = raw.wrapKey as CryptoKey;
    expect(wrapKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", wrapKey)).rejects.toThrow();
    const ct = Buffer.from(raw.ct as Uint8Array);
    expect(ct.includes(Buffer.from(k.sign.secretKey.slice(0, 16)))).toBe(false);
    expect(ct.toString("latin1")).not.toContain(await toB64url(k.sign.secretKey));
  });

  it("refuses a record moved to another device id (AAD binding) and forgets on destroy", async () => {
    const vault = await fresh();
    const k = await generateDeviceKeys();
    await vault.save(k);
    const other = await generateDeviceKeys();
    // Same ciphertext, different claimed device id: AES-GCM authentication fails.
    const db = (vault as unknown as { db: IDBDatabase }).db;
    const rec = await new Promise<Record<string, unknown>>((resolve) => {
      const g = db.transaction("keys").objectStore("keys").get("device");
      g.onsuccess = () => resolve(g.result as Record<string, unknown>);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("keys", "readwrite");
      tx.objectStore("keys").put({ ...rec, deviceId: other.deviceId }, "device");
      tx.oncomplete = () => resolve();
    });
    await expect(vault.load()).rejects.toThrow();
    await vault.destroy();
    expect(await vault.load()).toBeNull();
  });
});
