import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateBoxKeyPair, generateSigningKeyPair, toB64url, TrustedClientList } from "@chalito/crypto";
import { TrustStore } from "../src/trust-store.js";

describe("TrustStore", () => {
  it("round-trips a signed list and refuses a tampered file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chalito-trust-"));
    const agent = await generateSigningKeyPair();
    const store = new TrustStore(dir, agent, "dev_agent");
    const phone = await generateSigningKeyPair();
    const list = new TrustedClientList("dev_agent");
    await list.addConfirmed(
      {
        deviceId: "phone1",
        pubSign: await toB64url(phone.publicKey),
        pubBox: await toB64url((await generateBoxKeyPair()).publicKey),
      },
      1,
    );
    await store.save(list);
    const loaded = await store.load();
    expect(loaded.tampered).toBe(false);
    expect(loaded.list.has("phone1")).toBe(true);

    // Someone appends their own key to the file.
    const evil = await generateSigningKeyPair();
    const doc = JSON.parse(readFileSync(store.file, "utf8"));
    doc.clients.push({
      deviceId: "evil",
      pubSign: await toB64url(evil.publicKey),
      pubBox: doc.clients[0].pubBox,
      via: "local_confirmation",
      addedAt: 2,
    });
    writeFileSync(store.file, JSON.stringify(doc));
    const after = await store.load();
    expect(after.tampered).toBe(true);
    expect(after.list.has("evil")).toBe(false);
    expect(after.list.has("phone1")).toBe(false);
  });
});
