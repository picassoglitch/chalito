import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CommandBody } from "@chalito/protocol";
import { openSecretStore } from "../src/secret-choice.js";
import { EncryptedFileSecretStore, FILE_STORE_WARNING } from "../src/secrets-file.js";
import { MemorySecretStore } from "../src/secrets.js";

describe("openSecretStore", () => {
  it("uses the keychain when it works", async () => {
    const keyring = new MemorySecretStore();
    const warnings: string[] = [];
    const s = await openSecretStore({ env: {}, keyring, probe: async () => true, warn: (m) => warnings.push(m) });
    expect(s).toBe(keyring);
    expect(warnings).toEqual([]);
  });

  it("falls back to the encrypted file, with the warning, when there is no keychain", async () => {
    const warnings: string[] = [];
    const s = await openSecretStore({ env: {}, probe: async () => false, warn: (m) => warnings.push(m) });
    expect(s).toBeInstanceOf(EncryptedFileSecretStore);
    expect(warnings).toEqual([FILE_STORE_WARNING]);
  });

  it("CHALITO_SECRETS=file:<path> forces an encrypted file (dev/test), never probing the keychain", async () => {
    const path = join(tmpdir(), "chalito-e2e-secrets.enc");
    let probed = false;
    const warnings: string[] = [];
    const s = await openSecretStore({
      env: { CHALITO_SECRETS: `file:${path}`, CHALITO_SECRETS_PASSPHRASE: "pw" },
      probe: async () => ((probed = true), true),
      warn: (m) => warnings.push(m),
    });
    expect(s).toBeInstanceOf(EncryptedFileSecretStore);
    expect((s as EncryptedFileSecretStore).path).toBe(path);
    expect(probed).toBe(false);
    expect(warnings[0]).toMatch(/dev\/test only/);
  });

  it("rejects a malformed override and needs a passphrase source", async () => {
    await expect(openSecretStore({ env: { CHALITO_SECRETS: "keyring" }, warn: () => undefined })).rejects.toThrow(
      /file:<path>/,
    );
    const s = await openSecretStore({ env: { CHALITO_SECRETS: "file:/tmp/x.enc" }, warn: () => undefined });
    await expect(s.set("a", "b")).rejects.toThrow(/CHALITO_SECRETS_PASSPHRASE/);
  });
});

describe("command lifetime cap (P2-6)", () => {
  const body = (issuedAt: number, expiresAt: number) => ({
    v: 1,
    cid: "cid-12345678",
    uid: "hub-user-1",
    targetDeviceId: `dev_${"a".repeat(22)}`,
    origin: "local",
    nonce: "A".repeat(22),
    issuedAt,
    expiresAt,
    payload: { type: "devmode.off" },
  });

  it("accepts up to 10 minutes and refuses longer-lived commands", () => {
    const t = 1_790_000_000_000;
    expect(CommandBody.safeParse(body(t, t + 10 * 60_000)).success).toBe(true);
    expect(CommandBody.safeParse(body(t, t + 10 * 60_000 + 1)).success).toBe(false);
    expect(CommandBody.safeParse(body(t, t + 24 * 60 * 60_000)).success).toBe(false);
  });
});
