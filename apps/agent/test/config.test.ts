import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateSigningKeyPair } from "@chalito/crypto";
import {
  ConfigError,
  ConfigTamperedError,
  configPath,
  envLocale,
  isPaired,
  readConfig,
  requirePaired,
  writeConfig,
} from "../src/config.js";

const DEVICE = `dev_${"a".repeat(22)}`;
const KEYS = await generateSigningKeyPair();
const ENDPOINTS = {
  apiBase: "https://api.chalito.test/",
  firebase: { projectId: "demo-chalito", apiKey: "AIzaTest" },
};

describe("config.json", () => {
  it("validates, normalises and defaults (locale es, database chalito, unpaired)", () => {
    const dir = mkdtempSync(join(tmpdir(), "chalito-cfg-"));
    writeFileSync(configPath(dir), JSON.stringify(ENDPOINTS));
    const c = readConfig(dir, {});
    expect(c).toMatchObject({
      apiBase: "https://api.chalito.test",
      owner: null,
      deviceId: null,
      locale: "es",
      firebase: { databaseId: "chalito" },
    });
    expect(isPaired(c)).toBe(false);
    expect(() => requirePaired(c)).toThrow(/chalito pair/);
  });

  it("can come from the environment before a file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "chalito-cfg-"));
    const c = readConfig(dir, {
      CHALITO_API_BASE: "http://localhost:8080",
      CHALITO_FIREBASE_PROJECT_ID: "demo-chalito",
      CHALITO_FIREBASE_API_KEY: "k",
      LANG: "en_US.UTF-8",
    });
    expect(c.apiBase).toBe("http://localhost:8080");
    expect(c.locale).toBe("en");
  });

  it("with the Firebase emulators set, the project defaults to demo-chalito", () => {
    const dir = mkdtempSync(join(tmpdir(), "chalito-cfg-"));
    const c = readConfig(dir, { CHALITO_API_BASE: "http://127.0.0.1:8080", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8085" });
    expect(c.firebase).toMatchObject({ projectId: "demo-chalito", databaseId: "chalito" });
  });

  it("names the missing fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "chalito-cfg-"));
    expect(() => readConfig(dir, {})).toThrow(ConfigError);
    expect(() => readConfig(dir, {})).toThrow(/apiBase/);
    writeFileSync(configPath(dir), "{nope");
    expect(() => readConfig(dir, {})).toThrow(/not valid JSON/);
  });

  it("rejects ids that aren't derived device ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "chalito-cfg-"));
    writeFileSync(configPath(dir), JSON.stringify({ ...ENDPOINTS, owner: "u1", deviceId: "laptop" }));
    expect(() => readConfig(dir, {})).toThrow(/deviceId/);
  });

  it("writes atomically with mode 0600, signed, and round-trips a paired config", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "chalito-cfg-")), ".chalito");
    const c = { ...readConfigFrom(ENDPOINTS), owner: "hub-user-1", deviceId: DEVICE };
    writeConfig(dir, c, KEYS);
    expect(readConfig(dir, {}, { keys: KEYS })).toMatchObject({ owner: "hub-user-1" });
    expect(statSync(configPath(dir)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const back = readConfig(dir, {});
    expect(requirePaired(back)).toMatchObject({ owner: "hub-user-1", deviceId: DEVICE });
    expect(JSON.parse(readFileSync(configPath(dir), "utf8")).locale).toBe("es");
  });

  it("with keys, an unsigned or edited config.json is refused (claude path, endpoints)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chalito-cfg-"));
    const pinned = { path: "/home/u/.local/share/claude/versions/2.1/claude", sha256: "a".repeat(64) };
    writeConfig(dir, { ...readConfigFrom(ENDPOINTS), owner: "u1", deviceId: DEVICE, claude: pinned }, KEYS);
    const raw = JSON.parse(readFileSync(configPath(dir), "utf8"));
    writeFileSync(configPath(dir), JSON.stringify({ ...raw, claude: { ...pinned, path: "/tmp/evil" } }));
    expect(() => readConfig(dir, {}, { keys: KEYS })).toThrow(ConfigTamperedError);
    // Without keys (CLI locale, pre-pair) it still reads.
    expect(readConfig(dir, {}).claude?.path).toBe("/tmp/evil");

    writeFileSync(configPath(dir), JSON.stringify({ ...ENDPOINTS }));
    expect(() => readConfig(dir, {}, { keys: KEYS })).toThrow(ConfigTamperedError);
    const other = await generateSigningKeyPair();
    writeConfig(dir, { ...readConfigFrom(ENDPOINTS), owner: "u1", deviceId: DEVICE }, other);
    expect(() => readConfig(dir, {}, { keys: KEYS })).toThrow(ConfigTamperedError);
  });

  it("envLocale: en only when the environment says so", () => {
    expect(envLocale({ LANG: "en_GB.UTF-8" })).toBe("en");
    expect(envLocale({ LANG: "es_MX.UTF-8" })).toBe("es");
    expect(envLocale({})).toBe("es");
    expect(envLocale({ CHALITO_LOCALE: "en", LANG: "es_MX" })).toBe("en");
  });
});

function readConfigFrom(raw: object) {
  const dir = mkdtempSync(join(tmpdir(), "chalito-cfg-"));
  writeFileSync(configPath(dir), JSON.stringify(raw));
  return readConfig(dir, {});
}
