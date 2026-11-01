import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  const run = (over: Partial<Parameters<typeof stableHookBinary>[0]> = {}) =>
    stableHookBinary({ execPath, env, home, platform: "linux", ...over });
  return { root, appDir, execPath, home, env, run };
};

describe("stable agent path for AI app hooks (#132)", () => {
  it("copies an AppImage's agent out of its temporary mount and refreshes it on update", async () => {
    const s = setup();
    const got = await s.run();
    expect(got).toEqual({ path: stableAgentPath(s.home), ephemeral: false });
    expect(readFileSync(got.path, "utf8")).toBe("agent v1");
    expect(statSync(got.path).mode & 0o777).toBe(0o755);
    // Same bytes on the next start: the copy is left as is.
    const ino = statSync(got.path).ino;
    await s.run();
    expect(statSync(got.path).ino).toBe(ino);
    // The mount goes away with the app; the copy stays.
    rmSync(s.appDir, { recursive: true });
    expect(readFileSync(got.path, "utf8")).toBe("agent v1");
    // A new version (same size, different bytes) replaces the copy.
    mkdirSync(join(s.appDir, "usr", "bin"), { recursive: true });
    writeFileSync(s.execPath, "agent v2", { mode: 0o755 });
    await s.run();
    expect(readFileSync(got.path, "utf8")).toBe("agent v2");
  });

  it.each(["not ours", "agent v1"])(
    "replaces a symlink at the copy's spot (target holding %j) instead of trusting or writing through it",
    async (bytes) => {
      const s = setup();
      const elsewhere = join(s.root, "elsewhere");
      writeFileSync(elsewhere, bytes);
      mkdirSync(join(s.home, ".local", "share", "chalito"), { recursive: true });
      symlinkSync(elsewhere, stableAgentPath(s.home));
      await s.run();
      expect(readFileSync(elsewhere, "utf8")).toBe(bytes);
      expect(lstatSync(stableAgentPath(s.home)).isSymbolicLink()).toBe(false);
      expect(readFileSync(stableAgentPath(s.home), "utf8")).toBe("agent v1");
    },
  );

  it("leaves fixed installs alone: .deb, macOS, Windows, or an APPIMAGE env the agent isn't inside", async () => {
    const s = setup();
    const cases: [string, NodeJS.ProcessEnv, NodeJS.Platform][] = [
      ["/usr/bin/chalito-agent", {}, "linux"],
      [s.execPath, s.env, "darwin"],
      [s.execPath, s.env, "win32"],
      [s.execPath, { APPDIR: s.appDir }, "linux"],
      ["/usr/bin/chalito-agent", s.env, "linux"],
      [s.execPath.replace(".mount_ChalitAbc", ".mount_ChalitAbcd"), s.env, "linux"],
    ];
    for (const [execPath, env, platform] of cases)
      expect(await s.run({ execPath, env, platform })).toEqual({ path: execPath, ephemeral: false });
    expect(readdirSync(s.home)).toEqual([]);
    // A trailing slash on APPDIR is still the same mount.
    expect((await s.run({ env: { ...s.env, APPDIR: `${s.appDir}/` } })).path).toBe(stableAgentPath(s.home));
  });

  it("marks the mount as ephemeral, and says so, when no copy can be made", async () => {
    const s = setup();
    writeFileSync(join(s.home, ".local"), "a file where a folder should be");
    const logs: string[] = [];
    const got = await s.run({ log: (event) => void logs.push(event) });
    expect(got).toEqual({ path: s.execPath, ephemeral: true });
    expect(logs).toEqual(["native.stable_copy_failed"]);
  });

  it("keeps an older copy, never the mount, when refreshing fails, and leaves no temp file", async () => {
    const s = setup();
    await s.run();
    writeFileSync(s.execPath, "agent v2", { mode: 0o755 });
    // A rename can't replace a non-empty folder: simulate by turning the target into one.
    const target = stableAgentPath(s.home);
    rmSync(target);
    mkdirSync(join(target, "busy"), { recursive: true });
    expect((await s.run()).ephemeral).toBe(true);
    rmSync(target, { recursive: true });
    writeFileSync(target, "agent v1", { mode: 0o755 });
    const dir = join(s.home, ".local", "share", "chalito");
    statSync(dir);
    // Read-only folder: the copy fails, the older one is kept.
    const { chmodSync } = await import("node:fs");
    chmodSync(dir, 0o500);
    try {
      expect(await s.run()).toEqual({ path: target, ephemeral: false });
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readFileSync(target, "utf8")).toBe("agent v1");
    expect(readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});
