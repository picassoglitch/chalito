// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { decideMac, hmacKey, idbPairStore, keyIdOf, newPairing, verifyDecideMac } from "../src/lib/board/pairing.js";

it("keeps the paired board as a non-extractable key across reopen, and forgets it", async () => {
  const idb = new IDBFactory();
  const { secret } = newPairing();
  const keyId = await keyIdOf(secret);
  const key = await hmacKey(secret);
  expect(key.extractable).toBe(false);
  let changes = 0;
  const store = idbPairStore(idb);
  store.onChange(() => changes++);
  await store.save({ keyId, key });
  const again = await idbPairStore(idb).load();
  expect(again?.keyId).toBe(keyId);
  await expect(crypto.subtle.exportKey("raw", again!.key)).rejects.toThrow();
  const mac = await decideMac(again!.key, "a1", "t".repeat(16), true);
  expect(await verifyDecideMac(key, { aid: "a1", ticket: "t".repeat(16), allow: true }, mac)).toBe(true);
  expect(await verifyDecideMac(key, { aid: "a1", ticket: "t".repeat(16), allow: false }, mac)).toBe(false);
  expect(await verifyDecideMac(key, { aid: "a1", ticket: "t".repeat(16), allow: true }, mac.toUpperCase())).toBe(false);
  await store.clear();
  expect(await idbPairStore(idb).load()).toBeNull();
  expect(changes).toBe(2);
});

it("makes 6-digit codes and 32-byte secrets", () => {
  for (let i = 0; i < 50; i++) {
    const { secret, code } = newPairing();
    expect(secret).toHaveLength(32);
    expect(code).toMatch(/^\d{6}$/);
  }
});

it("opens IndexedDB again after a failed open instead of failing forever", async () => {
  const real = new IDBFactory();
  let fail = true;
  const flaky = {
    open: (name: string, version?: number) => {
      if (!fail) return real.open(name, version);
      fail = false;
      const r = {
        error: new DOMException("blocked"),
        onerror: null as null | (() => void),
      } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => (r.onerror as unknown as () => void)());
      return r;
    },
  } as unknown as IDBFactory;
  const store = idbPairStore(flaky);
  await expect(store.load()).rejects.toThrow("blocked");
  expect(await store.load()).toBeNull();
});
