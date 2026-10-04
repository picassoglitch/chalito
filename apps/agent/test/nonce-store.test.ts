import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileNonceStore } from "../src/nonce-store.js";
import { createLogger } from "../src/redact.js";

const T = 1_790_000_000_000;
const fresh = () => mkdtempSync(join(tmpdir(), "chalito-nonces-"));

describe("FileNonceStore", () => {
  it("accepts a nonce once and rejects the replay", async () => {
    const s = new FileNonceStore(fresh());
    expect(await s.claim("n1", T + 60_000, T)).toBe(true);
    expect(await s.claim("n1", T + 60_000, T + 1)).toBe(false);
    expect(await s.claim("n2", T + 60_000, T + 1)).toBe(true);
  });

  it("a restart inside the expiry window still rejects the replay", async () => {
    const dir = fresh();
    expect(await new FileNonceStore(dir).claim("cmd-nonce", T + 10 * 60_000, T)).toBe(true);
    const afterRestart = new FileNonceStore(dir);
    expect(await afterRestart.claim("cmd-nonce", T + 10 * 60_000, T + 5 * 60_000)).toBe(false);
  });

  it("rejects already-expired messages and prunes entries at expiry", async () => {
    const dir = fresh();
    const s = new FileNonceStore(dir);
    expect(await s.claim("old", T, T)).toBe(false);
    await s.claim("a", T + 1000, T);
    await s.claim("b", T + 5000, T);
    expect(s.size).toBe(2);
    await s.claim("c", T + 9000, T + 2000);
    expect(s.size).toBe(2);
    expect(Object.keys(JSON.parse(readFileSync(s.file, "utf8")))).toEqual(["b", "c"]);
    expect(new FileNonceStore(dir).size).toBe(2);
  });

  it("writes 0600 and survives a corrupt file by starting empty (logged)", async () => {
    const dir = fresh();
    const s = new FileNonceStore(dir);
    await s.claim("x", T + 1000, T);
    expect(statSync(s.file).mode & 0o777).toBe(0o600);
    writeFileSync(s.file, "{not json");
    const logs: string[] = [];
    const again = new FileNonceStore(
      dir,
      createLogger((l) => void logs.push(l)),
    );
    expect(again.size).toBe(0);
    expect(logs.join()).toContain("nonces.unreadable");
  });
});
