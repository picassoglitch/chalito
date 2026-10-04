import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KeyringStore, KeyringUnavailableError, MemorySecretStore } from "../src/secrets.js";
import {
  EncryptedFileSecretStore,
  FILE_STORE_WARNING,
  SecretsFileError,
  chooseSecretStore,
  keyringProbe,
} from "../src/secrets-file.js";

// Fast argon2id limits for most tests; one test uses the MODERATE defaults.
const FAST = { opslimit: 1, memlimit: 8 * 1024 * 1024 };
const tmpPath = () => join(mkdtempSync(join(tmpdir(), "chalito-secrets-")), ".chalito", "secrets.enc");

describe("EncryptedFileSecretStore", () => {
  it("round-trips across instances with the MODERATE defaults", async () => {
    const path = tmpPath();
    const a = new EncryptedFileSecretStore({ path, passphrase: "correct horse" });
    expect(await a.get("device-identity")).toBeNull();
    await a.set("device-identity", '{"k":1}');
    await a.set("byo-openai-api-key", "sk-test");
    await a.delete("byo-openai-api-key");

    let prompts = 0;
    const b = new EncryptedFileSecretStore({ path, passphrase: async () => (prompts++, "correct horse") });
    expect(await b.get("device-identity")).toBe('{"k":1}');
    expect(await b.get("byo-openai-api-key")).toBeNull();
    await b.get("device-identity");
    expect(prompts).toBe(1);

    const header = JSON.parse(readFileSync(path, "utf8"));
    expect(header.kdf.alg).toBe("argon2id13");
    expect(readFileSync(path, "utf8")).not.toContain("sk-test");
  }, 30_000);

  it("rejects a wrong passphrase", async () => {
    const path = tmpPath();
    await new EncryptedFileSecretStore({ path, passphrase: "right", kdf: FAST }).set("a", "1");
    const wrong = new EncryptedFileSecretStore({ path, passphrase: "wrong", kdf: FAST });
    await expect(wrong.get("a")).rejects.toBeInstanceOf(SecretsFileError);
    await expect(wrong.set("b", "2")).rejects.toThrow(/Wrong passphrase/);
  });

  it("rejects a tampered file (ciphertext, nonce or header)", async () => {
    const path = tmpPath();
    await new EncryptedFileSecretStore({ path, passphrase: "pw", kdf: FAST }).set("a", "1");
    const orig = JSON.parse(readFileSync(path, "utf8"));
    const flip = (b64: string) => (b64[0] === "A" ? "B" : "A") + b64.slice(1);
    for (const mutate of [
      (f: typeof orig) => ({ ...f, ct: flip(f.ct) }),
      (f: typeof orig) => ({ ...f, nonce: flip(f.nonce) }),
      (f: typeof orig) => ({ ...f, kdf: { ...f.kdf, salt: flip(f.kdf.salt) } }),
    ]) {
      writeFileSync(path, JSON.stringify(mutate(orig)));
      await expect(new EncryptedFileSecretStore({ path, passphrase: "pw" }).get("a")).rejects.toBeInstanceOf(
        SecretsFileError,
      );
    }
    writeFileSync(path, "not json");
    await expect(new EncryptedFileSecretStore({ path, passphrase: "pw" }).get("a")).rejects.toThrow(
      /not a Chalito secrets file/,
    );
  });

  it.skipIf(process.platform === "win32")("writes the file 0600 in a 0700 directory", async () => {
    const path = tmpPath();
    const s = new EncryptedFileSecretStore({ path, passphrase: "pw", kdf: FAST });
    await s.set("a", "1");
    await s.set("b", "2");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
  });
});

describe("chooseSecretStore", () => {
  it("uses the keyring when the probe passes", async () => {
    const keyring = new MemorySecretStore();
    const r = await chooseSecretStore({ keyring, fileStore: () => new MemorySecretStore(), probe: async () => true });
    expect(r).toEqual({ kind: "keyring", store: keyring });
  });

  it("falls back to the encrypted file with an explicit warning", async () => {
    const file = new MemorySecretStore();
    const r = await chooseSecretStore({
      keyring: new MemorySecretStore(),
      fileStore: () => file,
      probe: async () => false,
    });
    expect(r.kind).toBe("file");
    expect(r.store).toBe(file);
    expect(r.kind === "file" && r.warning).toBe(FILE_STORE_WARNING);
    expect(FILE_STORE_WARNING).toMatch(/secrets\.enc/);
  });
});

describe("keychain addon missing (broken build): fail closed", () => {
  const missing = () => Promise.reject(new Error("Cannot find module '@napi-rs/keyring-darwin-x64'"));

  it("the probe reports addon_missing, not 'no keychain'", async () => {
    expect(await keyringProbe(missing)).toBe("addon_missing");
  });

  it("chooseSecretStore refuses, and never opens the file store", async () => {
    const fileStore = vi.fn(() => new MemorySecretStore());
    await expect(
      chooseSecretStore({ keyring: new MemorySecretStore(), fileStore, probe: async () => "addon_missing" }),
    ).rejects.toBeInstanceOf(KeyringUnavailableError);
    expect(fileStore).not.toHaveBeenCalled();
  });

  it("KeyringStore throws a clear error instead of reading 'no value' or writing anywhere else", async () => {
    const s = new KeyringStore(missing);
    await expect(s.get("device.sign")).rejects.toBeInstanceOf(KeyringUnavailableError);
    await expect(s.set("device.sign", "secret")).rejects.toThrow(
      /Reinstall Chalito from https:\/\/chalito\.chalyb\.com\/descargar/,
    );
    await expect(s.delete("device.sign")).rejects.toBeInstanceOf(KeyringUnavailableError);
  });

  it("the message names the platform and says nothing is stored elsewhere", () => {
    const e = new KeyringUnavailableError(new Error("x"));
    expect(e.message).toContain(`${process.platform}-${process.arch}`);
    expect(e.message).toMatch(/won't store its keys anywhere else/);
  });
});
