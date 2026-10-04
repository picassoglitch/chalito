import { describe, expect, it } from "vitest";
import { WINDOWS_UNAVAILABLE, osAuthFor } from "../src/os-auth.js";
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

describe("OS user authentication for Developer mode", () => {
  it("macOS: administrator prompt via osascript running `true`, reason escaped", async () => {
    const { runner, calls } = fakeRunner(0);
    expect(await osAuthFor("darwin", runner, () => undefined).verify('Chalito: activar "allowSudo"')).toBe(true);
    expect(calls[0]!.cmd).toBe("osascript");
    expect(calls[0]!.args[1]).toBe(
      'do shell script "true" with prompt "Chalito: activar \\"allowSudo\\"" with administrator privileges',
    );
  });

  it("Linux: pkexec /bin/true on the terminal; a non-zero exit (cancel, wrong password) fails", async () => {
    const ok = fakeRunner(0);
    expect(await osAuthFor("linux", ok.runner, () => undefined).verify("x")).toBe(true);
    expect(ok.calls).toEqual([{ cmd: "pkexec", args: ["/bin/true"], interactive: true }]);
    const denied = fakeRunner(126);
    expect(await osAuthFor("linux", denied.runner, () => undefined).verify("x")).toBe(false);
    const missing = fakeRunner(127);
    expect(await osAuthFor("linux", missing.runner, () => undefined).verify("x")).toBe(false);
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
});
