import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AlreadyRunningError, acquireInstanceLock, lockPath } from "../src/instance-lock.js";

const dir = () => mkdtempSync(join(tmpdir(), "chalito-lock-"));

describe("one agent per computer (agent.lock)", () => {
  it("takes the lock with its pid and releases it", () => {
    const d = dir();
    const release = acquireInstanceLock(d, { pid: 4242 });
    expect(readFileSync(lockPath(d), "utf8")).toBe("4242");
    release();
    expect(existsSync(lockPath(d))).toBe(false);
  });

  it("a second agent is refused while the first is alive", () => {
    const d = dir();
    acquireInstanceLock(d, { pid: 1001 });
    expect(() => acquireInstanceLock(d, { pid: 1002, isAlive: () => true })).toThrow(AlreadyRunningError);
    expect(() => acquireInstanceLock(d, { pid: 1002, isAlive: () => true })).toThrow(/pid 1001/);
  });

  it("a lock left by a dead process (or garbage) is taken over", () => {
    const d = dir();
    writeFileSync(lockPath(d), "1001");
    acquireInstanceLock(d, { pid: 1002, isAlive: () => false })();
    writeFileSync(lockPath(d), "not a pid");
    acquireInstanceLock(d, { pid: 1003, isAlive: () => true });
    expect(readFileSync(lockPath(d), "utf8")).toBe("1003");
  });

  it("releasing never removes another agent's lock", () => {
    const d = dir();
    const release = acquireInstanceLock(d, { pid: 1001 });
    writeFileSync(lockPath(d), "2002");
    release();
    expect(readFileSync(lockPath(d), "utf8")).toBe("2002");
  });
});
