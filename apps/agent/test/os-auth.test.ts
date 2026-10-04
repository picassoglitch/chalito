import { describe, expect, it } from "vitest";
import { OSASCRIPT, PKEXEC, WINDOWS_UNAVAILABLE, osAuthFor, trustedHelper, type StatFn } from "../src/os-auth.js";
import type { ProcessRunner } from "../src/runner.js";

const fakeRunner = (code: number) => {
  const calls: { cmd: string; args: string[]; interactive: boolean }[] = [];
  const runner: ProcessRunner = {
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, interactive: opts?.interactive ?? false });
      return { code, stdout: "", stderr: "" };
    },
  };
  return { runner, calls };
};

const rootOwned: StatFn = () => ({ uid: 0, mode: 0o104755, isFile: () => true });

describe("OS user authentication for Developer mode", () => {
  it("macOS: administrator prompt via osascript running `true`, reason escaped", async () => {
    const { runner, calls } = fakeRunner(0);
    expect(
      await osAuthFor("darwin", runner, () => undefined, "es", rootOwned).verify('Chalito: activar "allowSudo"'),
    ).toBe(true);
    expect(calls[0]!.cmd).toBe(OSASCRIPT);
    expect(calls[0]!.args[1]).toBe(
      'do shell script "true" with prompt "Chalito: activar \\"allowSudo\\"" with administrator privileges',
    );
  });

  it("Linux: pkexec /bin/true on the terminal; a non-zero exit (cancel, wrong password) fails", async () => {
    const ok = fakeRunner(0);
    expect(await osAuthFor("linux", ok.runner, () => undefined, "es", rootOwned).verify("x")).toBe(true);
    expect(ok.calls).toEqual([{ cmd: PKEXEC, args: ["/bin/true"], interactive: true }]);
    const denied = fakeRunner(126);
    expect(await osAuthFor("linux", denied.runner, () => undefined, "es", rootOwned).verify("x")).toBe(false);
    const missing = fakeRunner(127);
    expect(await osAuthFor("linux", missing.runner, () => undefined, "es", rootOwned).verify("x")).toBe(false);
  });

  it("Windows: refuses with a message pointing at the desktop app, runs nothing", async () => {
    const { runner, calls } = fakeRunner(0);
    const msgs: string[] = [];
    expect(await osAuthFor("win32", runner, (m) => msgs.push(m), "en").verify("x")).toBe(false);
    expect(msgs).toEqual([WINDOWS_UNAVAILABLE.en]);
    expect(msgs[0]).toMatch(/Windows Hello.*M7/);
    expect(calls).toHaveLength(0);
  });

  it("unknown platforms refuse", async () => {
    expect(await osAuthFor("freebsd", fakeRunner(0).runner, () => undefined).verify("x")).toBe(false);
  });

  it("helpers run by absolute path only, and only when root-owned and not group/world-writable", async () => {
    const cases: [StatFn, boolean][] = [
      [rootOwned, true],
      [() => ({ uid: 1000, mode: 0o100755, isFile: () => true }), false], // ~/.local/bin/pkexec style
      [() => ({ uid: 0, mode: 0o100775, isFile: () => true }), false], // group-writable
      [() => ({ uid: 0, mode: 0o100757, isFile: () => true }), false], // world-writable
      [() => ({ uid: 0, mode: 0o040755, isFile: () => false }), false],
      [
        () => {
          throw new Error("ENOENT");
        },
        false,
      ],
    ];
    for (const [stat, ok] of cases) expect(trustedHelper(PKEXEC, stat)).toBe(ok);

    const { runner, calls } = fakeRunner(0);
    const msgs: string[] = [];
    const untrusted: StatFn = () => ({ uid: 1000, mode: 0o100755, isFile: () => true });
    expect(await osAuthFor("linux", runner, (m) => msgs.push(m), "en", untrusted).verify("x")).toBe(false);
    expect(calls).toHaveLength(0);
    expect(msgs[0]).toMatch(/not owned by root/);
  });
});
