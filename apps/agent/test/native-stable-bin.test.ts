import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stableAgentPath, stableHookBinary } from "../src/native/stable-bin.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "chalito-stable-bin-"));
  roots.push(root);
  const appDir = join(root, ".mount_ChalitAbc");
  mkdirSync(join(appDir, "usr", "bin"), { recursive: true });
  const execPath = join(appDir, "usr", "bin", "chalito-agent");
  writeFileSync(execPath, "agent v1", { mode: 0o755 });
  const home = join(root, "home");
  mkdirSync(home);
  const env = { APPIMAGE: join(root, "Chalito.AppImage"), APPDIR: appDir };
  return { root, appDir, execPath, home, env };
};

describe("stable agent path for AI app hooks (#132)", () => {
  it("copies an AppImage's agent out of its temporary mount and refreshes it on update", async () => {
    const s = setup();
    const got = await stableHookBinary({ execPath: s.execPath, env: s.env, home: s.home, platform: "linux" });
    expect(got).toBe(stableAgentPath(s.home));
    expect(readFileSync(got, "utf8")).toBe("agent v1");
    expect(statSync(got).mode & 0o777).toBe(0o755);
    // The mount goes away with the app; the copy stays.
    rmSync(s.appDir, { recursive: true });
    expect(readFileSync(got, "utf8")).toBe("agent v1");
    // A new version (same size, different bytes) replaces the copy.
    mkdirSync(join(s.appDir, "usr", "bin"), { recursive: true });
    writeFileSync(s.execPath, "agent v2", { mode: 0o755 });
    await stableHookBinary({ execPath: s.execPath, env: s.env, home: s.home, platform: "linux" });
    expect(readFileSync(got, "utf8")).toBe("agent v2");
  });

  it("replaces a symlink at the copy's spot instead of writing through it", async () => {
    const s = setup();
    const elsewhere = join(s.root, "elsewhere");
    writeFileSync(elsewhere, "not ours");
    mkdirSync(join(s.home, ".local", "share", "chalito"), { recursive: true });
    symlinkSync(elsewhere, stableAgentPath(s.home));
    await stableHookBinary({ execPath: s.execPath, env: s.env, home: s.home, platform: "linux" });
    expect(readFileSync(elsewhere, "utf8")).toBe("not ours");
    expect(readFileSync(stableAgentPath(s.home), "utf8")).toBe("agent v1");
  });

  it("leaves fixed installs alone: .deb, macOS, Windows, or an APPIMAGE env the agent isn't inside", async () => {
    const s = setup();
    for (const [execPath, env, platform] of [
      ["/usr/bin/chalito-agent", {}, "linux"],
      ["/Applications/Chalito.app/Contents/MacOS/chalito-agent", s.env, "darwin"],
      ["C:\\Program Files\\Chalito\\chalito-agent.exe", s.env, "win32"],
      ["/usr/bin/chalito-agent", s.env, "linux"],
      [s.execPath.replace(".mount_ChalitAbc", ".mount_ChalitAbcd"), s.env, "linux"],
    ] as const)
      expect(await stableHookBinary({ execPath, env, home: s.home, platform })).toBe(execPath);
  });

  it("falls back to the running path, and says so, when the copy can't be made", async () => {
    const s = setup();
    writeFileSync(join(s.home, ".local"), "a file where a folder should be");
    const logs: string[] = [];
    const got = await stableHookBinary({
      execPath: s.execPath,
      env: s.env,
      home: s.home,
      platform: "linux",
      log: (event) => void logs.push(event),
    });
    expect(got).toBe(s.execPath);
    expect(logs).toEqual(["native.stable_copy_failed"]);
  });
});
