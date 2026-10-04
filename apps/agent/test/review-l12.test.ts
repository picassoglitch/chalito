/** Review R-L12 (agent/ops): headless passphrase, the service unit's mode, ~/.chalito permissions. */
import { chmodSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureChalitoDir } from "../src/config.js";
import { openSecretStore, passphraseFileProblem } from "../src/secret-choice.js";
import { PASSPHRASE_CREDENTIAL, servicePlan, systemdUnit } from "../src/service.js";

const scratch = () => mkdtempSync(join(tmpdir(), "chalito-l12-"));
const mode = (p: string) => statSync(p).mode & 0o777;

// Each round trip runs argon2id several times: slow under a full parallel run.
describe("the secrets passphrase without an environment variable", { timeout: 30_000 }, () => {
  const roundTrip = async (env: Record<string, string>) => {
    const path = join(scratch(), "secrets.enc");
    const s = await openSecretStore({ env: { CHALITO_SECRETS: `file:${path}`, ...env }, warn: () => undefined });
    await s.set("k", "v");
    // Reopen with the same passphrase given the dev way: proves which passphrase was used.
    const again = await openSecretStore({
      env: { CHALITO_SECRETS: `file:${path}`, CHALITO_SECRETS_PASSPHRASE: "correct horse" },
      warn: () => undefined,
    });
    return again.get("k");
  };

  it("from the systemd credential ($CREDENTIALS_DIRECTORY)", async () => {
    const creds = scratch();
    writeFileSync(join(creds, PASSPHRASE_CREDENTIAL), "correct horse\n", { mode: 0o400 });
    expect(await roundTrip({ CREDENTIALS_DIRECTORY: creds })).toBe("v");
  });

  it("from CHALITO_SECRETS_PASSPHRASE_FILE, only if it's 0600 and ours", async () => {
    const dir = scratch();
    const file = join(dir, "pass");
    writeFileSync(file, "correct horse\n", { mode: 0o600 });
    expect(await roundTrip({ CHALITO_SECRETS_PASSPHRASE_FILE: file })).toBe("v");
    chmodSync(file, 0o644);
    expect(passphraseFileProblem(file)).toMatch(/chmod 600/);
    await expect(roundTrip({ CHALITO_SECRETS_PASSPHRASE_FILE: file })).rejects.toThrow(/chmod 600/);
    expect(passphraseFileProblem(join(dir, "missing"))).toMatch(/doesn't exist/);
    expect(passphraseFileProblem(dir)).toMatch(/regular file/);
  });
});

describe("the systemd unit", () => {
  it("never carries the passphrase; --passphrase-file adds a LoadCredential line", () => {
    expect(systemdUnit("/opt/chalito/agent")).not.toMatch(/Environment|PASSPHRASE|LoadCredential/);
    const unit = systemdUnit("/opt/chalito/agent", { passphraseFile: "/home/a/.config/chalito/pass" });
    expect(unit).toContain(`LoadCredential=${PASSPHRASE_CREDENTIAL}:/home/a/.config/chalito/pass`);
    expect(unit).not.toMatch(/Environment/);
    expect(servicePlan("linux", "/opt/x", { home: "/home/a", passphraseFile: "/p" }).files[0]!.content).toContain(
      "LoadCredential=",
    );
  });
});

describe("~/.chalito is tightened at start", () => {
  it("an existing tree gets 0700 directories and 0600 files, and says how many it fixed", () => {
    const home = scratch();
    const dir = join(home, ".chalito");
    mkdirSync(join(dir, "logs"), { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
    chmodSync(join(dir, "logs"), 0o755);
    writeFileSync(join(dir, "config.json"), "{}", { mode: 0o644 });
    writeFileSync(join(dir, "logs", "agent.log"), "", { mode: 0o664 });
    writeFileSync(join(dir, "trust.json"), "[]", { mode: 0o600 });
    const outside = join(home, "elsewhere.txt");
    writeFileSync(outside, "x", { mode: 0o644 });
    symlinkSync(outside, join(dir, "link"));
    const seen: number[] = [];
    ensureChalitoDir(dir, (n) => seen.push(n));
    expect([mode(dir), mode(join(dir, "logs"))]).toEqual([0o700, 0o700]);
    expect([
      mode(join(dir, "config.json")),
      mode(join(dir, "logs", "agent.log")),
      mode(join(dir, "trust.json")),
    ]).toEqual([0o600, 0o600, 0o600]);
    expect(mode(outside)).toBe(0o644); // symlinks aren't followed
    expect(seen).toEqual([4]);
    // Nothing to fix the second time: no log line.
    ensureChalitoDir(dir, (n) => seen.push(n));
    expect(seen).toEqual([4]);
  });
});
