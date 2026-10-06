import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { generateSigningKeyPair } from "@chalito/crypto";
import { lineDiff, main, parseArgs, type CliIo } from "../src/cli.js";
import { AnchorStore } from "../src/anchor.js";
import { chalitoDir, readConfig, writeConfig } from "../src/config.js";
import { OnboardingError, type Daemon } from "../src/daemon.js";
import { AlreadyRunningError, EXIT_ALREADY_RUNNING, EXIT_NEEDS_SETUP } from "../src/instance-lock.js";
import { DevModeStore } from "../src/devmode.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import { FilePolicyHolder, policyToYaml } from "../src/policy-file.js";
import { DEFAULT_POLICY } from "../src/policy/index.js";
import type { ProcessRunner } from "../src/runner.js";
import { MemorySecretStore, SECRET_NAMES } from "../src/secrets.js";

type Run = { cmd: string; args: string[]; interactive: boolean };

const cli = (
  opts: {
    lines?: string[];
    /** stdin is a TTY (default true). */
    tty?: boolean;
    /** stdout is a TTY (default true). */
    outTty?: boolean;
    /** What /usr/bin/pkexec looks like (default: root-owned, 0755). */
    helperUid?: number;
    platform?: NodeJS.Platform;
    execPath?: string;
    runner?: (r: Run) => number;
    env?: Record<string, string>;
  } = {},
) => {
  const home = mkdtempSync(join(tmpdir(), "chalito-cli-"));
  const secrets = new MemorySecretStore();
  const runs: Run[] = [];
  const runner: ProcessRunner = {
    run: async (cmd, args, o) => {
      const r = { cmd, args, interactive: o?.interactive ?? false };
      runs.push(r);
      return { code: opts.runner?.(r) ?? 0, stdout: "", stderr: "boom" };
    },
  };
  let out = "";
  let err = "";
  const make = (lines = opts.lines ?? []): CliIo => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean };
    input.isTTY = opts.tty ?? true;
    input.end(lines.map((l) => `${l}\n`).join(""));
    const output = new PassThrough() as PassThrough & { isTTY?: boolean };
    output.isTTY = opts.outTty ?? true;
    return {
      out: (s) => void (out += s),
      err: (s) => void (err += s),
      tty: { input, output },
      osStat: () => ({ uid: opts.helperUid ?? 0, mode: 0o100755, isFile: () => true }),
      env: { LANG: "en_US.UTF-8", ...opts.env },
      home,
      platform: opts.platform ?? "linux",
      secrets,
      runner,
      fetch: async () => {
        throw new Error("no network in tests");
      },
      now: () => 1_790_000_000_000,
      execPath: opts.execPath ?? "/opt/chalito/chalito-agent",
      tmpdir: mkdtempSync(join(tmpdir(), "chalito-cli-tmp-")),
    };
  };
  return {
    home,
    dir: chalitoDir(home),
    secrets,
    runs,
    run: (argv: string[], lines?: string[]) => main(argv, make(lines)),
    out: () => out,
    err: () => err,
    reset: () => ((out = ""), (err = "")),
  };
};

describe("arg parsing", () => {
  it("handles positionals, boolean flags, --x v, --x=v, -h and --", () => {
    expect(parseArgs(["service", "install", "--bin", "/a/b", "--laptop"])).toEqual({
      positional: ["service", "install"],
      flags: { bin: "/a/b", laptop: true },
    });
    expect(parseArgs(["--bin=/x", "-h", "--", "--not-a-flag"])).toEqual({
      positional: ["--not-a-flag"],
      flags: { bin: "/x", help: true },
    });
  });

  it("lineDiff shows only removed and added lines", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc\nd")).toEqual(["- b", "+ B", "+ d"]);
    expect(lineDiff("same", "same")).toEqual([]);
  });
});

describe("chalito CLI", () => {
  it("prints usage for help and an error for unknown commands", async () => {
    const c = cli();
    expect(await c.run(["--help"])).toBe(0);
    expect(c.out()).toContain("devmode on <toggle>");
    expect(await c.run(["bogus"])).toBe(1);
    expect(c.err()).toContain("Unknown command: bogus");
  });

  it("run: another agent running exits 75; a setup step missing exits 78 with its message", async () => {
    const c = cli();
    const io = (fail: Error) => ({
      out: () => undefined,
      err: (s: string) => void errs.push(s),
      tty: { input: new PassThrough(), output: new PassThrough() },
      env: {},
      home: c.home,
      platform: "linux" as const,
      secrets: c.secrets,
      runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      now: Date.now,
      execPath: "/x",
      tmpdir: tmpdir(),
      daemon: async () => {
        throw fail;
      },
    });
    const errs: string[] = [];
    expect(await main(["run"], io(new AlreadyRunningError(1234)))).toBe(EXIT_ALREADY_RUNNING);
    expect(errs.join("")).toMatch(/already running.*pid 1234/);
    expect(await main(["run"], io(new OnboardingError("Pin Claude Code first.")))).toBe(EXIT_NEEDS_SETUP);
    expect(errs.join("")).toContain("Pin Claude Code first.");
    expect([EXIT_ALREADY_RUNNING, EXIT_NEEDS_SETUP]).toEqual([75, 78]);
  });

  it("run: starts the daemon with the CLI's I/O and waits for it", async () => {
    const c = cli();
    let started = false;
    const io = {
      out: () => undefined,
      err: () => undefined,
      tty: { input: new PassThrough(), output: new PassThrough() },
      env: {},
      home: c.home,
      platform: "linux" as const,
      secrets: c.secrets,
      runner: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
      now: Date.now,
      execPath: "/x",
      tmpdir: tmpdir(),
      daemon: async (deps: { home?: string }) => {
        started = deps.home === c.home;
        return { done: Promise.resolve() } as unknown as Daemon;
      },
    };
    expect(await main(["run"], io)).toBe(0);
    expect(started).toBe(true);
  });

  describe("keys set", () => {
    it("saves the key in the keychain, never prints it", async () => {
      const c = cli();
      expect(await c.run(["keys", "set", "anthropic"], ["sk-ant-abcdefgh12345678"])).toBe(0);
      expect(await c.secrets.get(SECRET_NAMES.anthropicApiKey)).toBe("sk-ant-abcdefgh12345678");
      expect(c.out() + c.err()).not.toContain("abcdefgh");
      expect(c.out()).toMatch(/keychain/);
    });

    it("warns on an unexpected shape, refuses an empty key and unknown providers", async () => {
      const c = cli();
      expect(await c.run(["keys", "set", "xai"], ["not-an-xai-key"])).toBe(0);
      expect(c.err()).toMatch(/doesn't look like a xai key/);
      expect(await c.run(["keys", "set", "openai"], [""])).toBe(1);
      expect(await c.secrets.get(SECRET_NAMES.openaiApiKey)).toBeNull();
      expect(await c.run(["keys", "set", "gemini"], ["x"])).toBe(1);
    });
  });

  describe("devmode", () => {
    it("on: refuses without an interactive terminal", async () => {
      const c = cli({ tty: false });
      expect(await c.run(["devmode", "on", "allowSudo"])).toBe(1);
      expect(c.err()).toMatch(/terminal you're typing in/);
      expect(c.runs).toHaveLength(0);
    });

    it("reset: OS auth + typed RESET archives the log and leaves everything off", async () => {
      const c = cli();
      await c.run(["devmode", "on", "allowSudo"], ["y", "y", "y", "I ACCEPT"]);
      expect(await c.run(["devmode", "reset"], ["nope"])).toBe(1);
      expect(c.err()).toMatch(/Cancelled/);
      expect(await c.run(["devmode", "reset"], ["RESET"])).toBe(0);
      const id = await loadOrCreateIdentity(c.secrets);
      const store = new DevModeStore(c.dir, id.sign, id.deviceId, await new AnchorStore(c.secrets).load());
      expect(store.records()).toMatchObject([{ type: "devmode.reset", epoch: 1 }]);
      expect(store.inspect()).toMatchObject({ state: { on: false }, tampered: null });
    });

    it("on: OS auth + three confirmations + phrase writes a signed liability record", async () => {
      const c = cli({ tty: true });
      expect(await c.run(["devmode", "on", "autoApproveHigh"], ["y", "y", "y", "I ACCEPT"])).toBe(0);
      expect(c.runs).toEqual([{ cmd: "/usr/bin/pkexec", args: ["/bin/true"], interactive: true }]);
      const id = await loadOrCreateIdentity(c.secrets);
      const store = new DevModeStore(c.dir, id.sign, id.deviceId, await new AnchorStore(c.secrets).load());
      expect(store.read()).toMatchObject({ on: true, toggles: ["autoApproveHigh"] });
      expect(store.liabilityRecords()).toHaveLength(1);
      expect(c.out()).toMatch(/Developer mode ACTIVE/);
    });

    it("on: failed OS auth or a wrong phrase changes nothing", async () => {
      const denied = cli({ tty: true, runner: () => 126 });
      expect(await denied.run(["devmode", "on", "allowSudo"], ["y", "y", "y", "I ACCEPT"])).toBe(1);
      expect(denied.err()).toMatch(/OS authentication failed/);

      const c = cli({ tty: true });
      expect(await c.run(["devmode", "on", "allowSudo"], ["y", "y", "y", "i accept"])).toBe(1);
      expect(c.err()).toMatch(/Cancelled/);
      const id = await loadOrCreateIdentity(c.secrets);
      expect(new DevModeStore(c.dir, id.sign, id.deviceId).liabilityRecords()).toHaveLength(0);
    });

    it("on: Windows points at the desktop app", async () => {
      const c = cli({ tty: true, platform: "win32" });
      expect(await c.run(["devmode", "on", "allowSudo"])).toBe(1);
      expect(c.err()).toMatch(/Windows Hello/);
    });

    it("on: only the three toggles; bypassStyle and unknown names are refused", async () => {
      const c = cli({ tty: true });
      expect(await c.run(["devmode", "on", "bypassStyle"])).toBe(1);
      expect(await c.run(["devmode", "on"])).toBe(1);
      expect(c.err()).toContain("allowSudo|autoApproveHigh|autoApproveCritical");
    });

    it("off: turns one toggle or everything off, no auth needed", async () => {
      const c = cli({ tty: true });
      await c.run(["devmode", "on", "allowSudo"], ["y", "y", "y", "I ACCEPT"]);
      await c.run(["devmode", "on", "autoApproveHigh"], ["y", "y", "y", "I ACCEPT"]);
      const before = c.runs.length;
      expect(await c.run(["devmode", "off", "allowSudo"])).toBe(0);
      const id = await loadOrCreateIdentity(c.secrets);
      expect(new DevModeStore(c.dir, id.sign, id.deviceId).read().toggles).toEqual(["autoApproveHigh"]);
      expect(await c.run(["devmode", "off"])).toBe(0);
      expect(new DevModeStore(c.dir, id.sign, id.deviceId).read().on).toBe(false);
      expect(c.runs.length).toBe(before);
      expect(await c.run(["devmode", "off", "nope"])).toBe(1);
    });
  });

  describe("computer", () => {
    const policyOf = async (c: ReturnType<typeof cli>) =>
      new FilePolicyHolder(c.dir, (await loadOrCreateIdentity(c.secrets)).sign).get();

    it("enable: OS auth, two confirmations and the phrase turn it on in the signed policy", async () => {
      const c = cli({ tty: true });
      expect(await c.run(["computer", "status"])).toBe(0);
      expect(c.out()).toMatch(/Computer control: off/);
      expect(await c.run(["computer", "enable"], ["y", "y", "CONTROL MY COMPUTER"])).toBe(0);
      expect(c.runs).toEqual([{ cmd: "/usr/bin/pkexec", args: ["/bin/true"], interactive: true }]);
      expect(c.out()).toMatch(/Computer control is on/);
      expect((await policyOf(c)).computer).toEqual({ enabled: true, maxActionsPerMinute: 60 });
      expect(await c.run(["computer", "disable"])).toBe(0);
      expect((await policyOf(c)).computer).toEqual({ enabled: false, maxActionsPerMinute: 60 });
    });

    it("enable: failed OS auth, a no, or a wrong phrase change nothing", async () => {
      for (const [o, lines] of [
        [{ runner: () => 126 }, ["y", "y", "CONTROL MY COMPUTER"]],
        [{}, ["n"]],
        [{}, ["y", "n"]],
        [{}, ["y", "y", "control my computer"]],
      ] as const) {
        const c = cli({ tty: true, ...o });
        expect(await c.run(["computer", "enable"], [...lines])).toBe(1);
        expect((await policyOf(c)).computer).toBeUndefined();
      }
    });

    it("enable: macOS points at Screen Recording and Accessibility; Wayland is called out", async () => {
      const mac = cli({ tty: true, platform: "darwin" });
      expect(await mac.run(["computer", "enable"], ["y", "y", "CONTROL MY COMPUTER"])).toBe(0);
      expect(mac.out()).toMatch(/Screen Recording/);
      const wl = cli({ tty: true, env: { XDG_SESSION_TYPE: "wayland" } });
      expect(await wl.run(["computer", "enable"], ["y", "y", "CONTROL MY COMPUTER"])).toBe(0);
      expect(wl.err()).toMatch(/Wayland/);
    });

    it("policy edit can't turn it on", async () => {
      const on = policyToYaml({ ...DEFAULT_POLICY, computer: { enabled: true, maxActionsPerMinute: 60 } });
      const c = cli({ runner: (r) => (writeFileSync(r.args.at(-1)!, on), 0) });
      expect(await c.run(["policy", "edit"], ["y"])).toBe(1);
      expect(c.err()).toMatch(/chalito computer enable/);
      expect((await policyOf(c)).computer).toBeUndefined();
    });

    it("mcp: only with the session's socket and token", async () => {
      const c = cli({ tty: false, outTty: false, env: { CHALITO_SESSION: "1" } });
      expect(await c.run(["computer", "mcp"])).toBe(1);
      expect(c.err()).toMatch(/started by Chalito/);
    });
  });

  describe("screen", () => {
    const policyOf = async (c: ReturnType<typeof cli>) =>
      new FilePolicyHolder(c.dir, (await loadOrCreateIdentity(c.secrets)).sign).get();

    it("enable view, then control: OS auth, two confirmations and the phrase each time; disable steps down", async () => {
      const c = cli({ tty: true });
      expect(await c.run(["screen", "status"])).toBe(0);
      expect(c.out()).toMatch(/Remote screen: off/);
      expect(await c.run(["screen", "enable"], ["y", "y", "VIEW MY SCREEN"])).toBe(0);
      expect(c.runs).toEqual([{ cmd: "/usr/bin/pkexec", args: ["/bin/true"], interactive: true }]);
      expect((await policyOf(c)).screen).toMatchObject({ view: true, control: false });
      expect(await c.run(["screen", "enable", "control"], ["y", "y", "CONTROL MY SCREEN"])).toBe(0);
      expect((await policyOf(c)).screen).toMatchObject({ view: true, control: true });
      expect(await c.run(["screen", "disable", "control"])).toBe(0);
      expect((await policyOf(c)).screen).toMatchObject({ view: true, control: false });
      expect(await c.run(["screen", "disable"])).toBe(0);
      expect((await policyOf(c)).screen).toMatchObject({ view: false, control: false });
    });

    it("enable: failed OS auth, a no, or a wrong phrase change nothing", async () => {
      for (const [o, lines] of [
        [{ runner: () => 126 }, ["y", "y", "VIEW MY SCREEN"]],
        [{}, ["n"]],
        [{}, ["y", "y", "view my screen"]],
      ] as const) {
        const c = cli({ tty: true, ...o });
        expect(await c.run(["screen", "enable"], [...lines])).toBe(1);
        expect((await policyOf(c)).screen).toBeUndefined();
      }
    });

    it("policy edit can't turn it on, or view up to control", async () => {
      const on = policyToYaml({
        ...DEFAULT_POLICY,
        screen: { view: true, control: true, maxFps: 5, maxInputsPerMinute: 600, maxSessionMinutes: 60 },
      });
      const c = cli({ runner: (r) => (writeFileSync(r.args.at(-1)!, on), 0) });
      expect(await c.run(["policy", "edit"], ["y"])).toBe(1);
      expect(c.err()).toMatch(/chalito screen enable/);
      expect((await policyOf(c)).screen).toBeUndefined();
    });

    for (const argv of [
      ["screen", "enable"],
      ["screen", "disable"],
    ])
      it(`${argv.join(" ")}: refused with piped stdin or inside a session`, async () => {
        for (const o of [{ tty: false }, { env: { CHALITO_SESSION: "1" } }]) {
          const c = cli(o);
          expect(await c.run(argv, ["y", "y", "VIEW MY SCREEN"])).toBe(1);
          expect(c.runs).toHaveLength(0);
        }
      });
  });

  describe("policy", () => {
    const editTo = (text: string) => (r: Run) => {
      if (r.cmd !== "/usr/bin/pkexec") writeFileSync(r.args.at(-1)!, text);
      return 0;
    };
    const loosened = policyToYaml({ ...DEFAULT_POLICY, workspaces: [{ label: "code", path: "/home/u/code" }] });

    it("path and show", async () => {
      const c = cli();
      expect(await c.run(["policy", "path"])).toBe(0);
      expect(c.out()).toContain(join(c.dir, "policy.yaml"));
      expect(await c.run(["policy", "show"])).toBe(0);
      expect(c.out()).toMatch(/policyHash \(in force\): [0-9a-f]{64}/);
    });

    it("edit: $EDITOR on a temp copy → validate → diff → confirm → OS auth (loosening) → signed write", async () => {
      const c = cli({ runner: editTo(loosened), env: { EDITOR: "nano -w" } });
      expect(await c.run(["policy", "edit"], ["y"])).toBe(0);
      expect(c.runs[0]).toMatchObject({ cmd: "nano", interactive: true });
      expect(c.runs[1]).toMatchObject({ cmd: "/usr/bin/pkexec" });
      expect(c.out()).toMatch(/loosens the policy/);
      expect(c.runs[0]!.args[0]).toBe("-w");
      expect(c.runs[0]!.args[1]).not.toContain(c.dir);
      expect(c.out()).toContain("+   - label: code");
      const id = await loadOrCreateIdentity(c.secrets);
      const h = new FilePolicyHolder(c.dir, id.sign);
      expect(h.tampered).toBe(false);
      expect(h.get().workspaces).toEqual([{ label: "code", path: "/home/u/code" }]);
      expect(existsSync(c.runs[0]!.args[1]!)).toBe(false);
    });

    it("edit: declining, an invalid edit or a failed editor leaves the policy unchanged", async () => {
      for (const [runner, lines, msg] of [
        [editTo(loosened), ["n"], /Cancelled/],
        [editTo("version: 2\n"), [], /invalid and was not saved/],
        [() => 1, [], /editor exited with code 1/],
      ] as const) {
        const c = cli({ runner });
        expect(await c.run(["policy", "edit"], [...lines])).toBe(1);
        expect(c.out() + c.err()).toMatch(msg);
        const id = await loadOrCreateIdentity(c.secrets);
        expect(new FilePolicyHolder(c.dir, id.sign).get()).toEqual(DEFAULT_POLICY);
      }
    });

    it("edit: loosening without OS auth changes nothing; tightening needs none", async () => {
      const denied = cli({ runner: (r) => (r.cmd === "/usr/bin/pkexec" ? 126 : editTo(loosened)(r)) });
      expect(await denied.run(["policy", "edit"], ["y"])).toBe(1);
      expect(denied.err()).toMatch(/OS authentication failed/);
      const id = await loadOrCreateIdentity(denied.secrets);
      expect(new FilePolicyHolder(denied.dir, id.sign).get().workspaces).toEqual([]);

      // A user-owned fake pkexec is never trusted.
      const fake = cli({ runner: editTo(loosened), helperUid: 1000 });
      expect(await fake.run(["policy", "edit"], ["y"])).toBe(1);
      expect(fake.err()).toMatch(/not owned by root/);
      expect(fake.runs.map((r) => r.cmd)).not.toContain("/usr/bin/pkexec");

      const tighter = policyToYaml({ ...DEFAULT_POLICY, approvals: { ttlSeconds: 120 } });
      const t = cli({ runner: editTo(tighter) });
      expect(await t.run(["policy", "edit"], ["y"])).toBe(0);
      expect(t.runs.map((r) => r.cmd)).not.toContain("/usr/bin/pkexec");
    });

    it("edit: a hand edit that was refused can be reviewed and confirmed here (re-signs)", async () => {
      const c = cli({ runner: () => 0 });
      await c.run(["policy", "path"]);
      writeFileSync(join(c.dir, "policy.yaml"), loosened);
      const id = await loadOrCreateIdentity(c.secrets);
      expect(new FilePolicyHolder(c.dir, id.sign).tampered).toBe(true);
      expect(await c.run(["policy", "edit"], ["y"])).toBe(0);
      expect(new FilePolicyHolder(c.dir, id.sign).tampered).toBe(false);
    });
  });

  describe("service", () => {
    it("install writes the systemd user unit and runs systemctl --user; uninstall reverses it", async () => {
      const c = cli();
      expect(await c.run(["service", "install"])).toBe(0);
      const unit = join(c.home, ".config", "systemd", "user", "chalito-agent.service");
      expect(readFileSync(unit, "utf8")).toContain('ExecStart="/opt/chalito/chalito-agent" run');
      expect(statSync(unit).mode & 0o777).toBe(0o600);
      expect(c.runs.map((r) => [r.cmd, ...r.args].join(" "))).toEqual([
        "systemctl --user daemon-reload",
        "systemctl --user enable --now chalito-agent.service",
      ]);
      expect(await c.run(["service", "uninstall"])).toBe(0);
      expect(existsSync(unit)).toBe(false);
      expect(c.runs.at(-1)!.args).toEqual(["--user", "disable", "--now", "chalito-agent.service"]);
    });

    it("--passphrase-file: a 0600 file becomes a systemd credential; a readable one is refused", async () => {
      const c = cli();
      const pass = join(c.home, "pass");
      writeFileSync(pass, "pw\n", { mode: 0o600 });
      expect(await c.run(["service", "install", "--passphrase-file", pass])).toBe(0);
      const unit = join(c.home, ".config", "systemd", "user", "chalito-agent.service");
      expect(readFileSync(unit, "utf8")).toContain(`LoadCredential=chalito-secrets-passphrase:${pass}`);
      chmodSync(pass, 0o644);
      const again = cli();
      expect(await again.run(["service", "install", "--passphrase-file", pass])).toBe(1);
      expect(again.err()).toMatch(/chmod 600/);
    });

    it("macOS: LaunchAgent plist + launchctl bootstrap", async () => {
      const c = cli({ platform: "darwin" });
      expect(await c.run(["service", "install", "--bin", "/Applications/Chalito.app/agent"])).toBe(0);
      expect(existsSync(join(c.home, "Library", "LaunchAgents", "com.chalito.agent.plist"))).toBe(true);
      expect(c.runs[0]!.cmd).toBe("launchctl");
    });

    it("running from source needs --bin; a failing command is reported", async () => {
      const src = cli({ execPath: "/usr/bin/node" });
      expect(await src.run(["service", "install"])).toBe(1);
      expect(src.err()).toMatch(/--bin/);
      expect(src.runs).toHaveLength(0);

      const failing = cli({ runner: () => 1 });
      expect(await failing.run(["service", "install"])).toBe(1);
      expect(failing.err()).toMatch(/systemctl --user daemon-reload` failed: boom/);
    });
  });

  it("status: unpaired computer, no secrets printed", async () => {
    const c = cli();
    await c.secrets.set(SECRET_NAMES.anthropicApiKey, "sk-ant-zzzzzzzzzzzzzz");
    await c.run(["policy", "path"]);
    expect(await c.run(["status"])).toBe(0);
    const out = c.out();
    expect(out).toMatch(/Paired\s+no/);
    expect(out).toMatch(/anthropic: set, openai: missing, xai: missing/);
    expect(out).toMatch(/Developer mode\s+off/);
    expect(out).not.toContain("zzzz");
  });

  it("status: shows a refused policy edit and forged Developer-mode state", async () => {
    const c = cli();
    await c.run(["policy", "path"]);
    writeFileSync(join(c.dir, "policy.yaml"), policyToYaml({ ...DEFAULT_POLICY, approvals: { ttlSeconds: 30 } }));
    writeFileSync(join(c.dir, "devmode.json"), JSON.stringify({ on: true, toggles: ["allowSudo"], since: 1 }));
    c.reset();
    await c.run(["status"]);
    expect(c.out()).toMatch(/refused, signed policy in force/);
    expect(c.out()).toMatch(/Developer mode\s+off — devmode files failed verification \(state_signature\)/);
  });

  it("an attacker's key can't produce a lock the CLI accepts", async () => {
    const c = cli();
    await c.run(["policy", "path"]);
    await new FilePolicyHolder(c.dir, await generateSigningKeyPair()).set(
      { ...DEFAULT_POLICY, workspaces: [{ label: "r", path: "/" }] },
      "local",
    );
    const id = await loadOrCreateIdentity(c.secrets);
    expect(new FilePolicyHolder(c.dir, id.sign).get().workspaces).toEqual([]);
  });

  describe("only a human at a terminal can change anything (P2-1)", () => {
    const mutating: [string[], string[]][] = [
      [["pair"], []],
      [["keys", "set", "anthropic"], ["sk-ant-abcdefgh12345678"]],
      [["service", "install"], []],
      [["service", "uninstall"], []],
      [["policy", "edit"], ["y"]],
      [
        ["devmode", "on", "allowSudo"],
        ["y", "y", "y", "I ACCEPT"],
      ],
      [["devmode", "off"], []],
      [["devmode", "reset"], ["RESET"]],
      [["claude", "pin", "/usr/bin/true"], []],
      [["codex", "pin", "/usr/bin/true"], []],
      [
        ["computer", "enable"],
        ["y", "y", "CONTROL MY COMPUTER"],
      ],
      [["computer", "disable"], []],
    ];

    for (const [argv, lines] of mutating) {
      it(`${argv.join(" ")}: refused with piped stdin, a non-TTY stdout, or inside a session`, async () => {
        for (const o of [{ tty: false }, { outTty: false }, { env: { CHALITO_SESSION: "1" } }]) {
          const c = cli(o);
          expect(await c.run(argv, lines)).toBe(1);
          expect(c.err()).toMatch(o.env ? /inside a Chalito session/ : /terminal you're typing in/);
          expect(c.runs).toHaveLength(0);
          expect(await c.secrets.get(SECRET_NAMES.anthropicApiKey)).toBeNull();
        }
      });
    }

    it("read-only commands still work when piped", async () => {
      const c = cli({ tty: false, outTty: false });
      expect(await c.run(["status"])).toBe(0);
      expect(await c.run(["policy", "show"])).toBe(0);
    });
  });

  describe("claude pin", () => {
    const paired = async (c: ReturnType<typeof cli>) => {
      const id = await loadOrCreateIdentity(c.secrets);
      writeConfig(
        c.dir,
        {
          ...readConfig(c.dir, {
            CHALITO_API_BASE: "https://api.test",
            SUPABASE_URL: "http://127.0.0.1:54321",
            SUPABASE_PUBLISHABLE_KEY: "k",
            LANG: "en_US",
          }),
          owner: "hub-user-1",
          deviceId: id.deviceId,
        },
        id.sign,
      );
      return id;
    };

    it("pins path (symlinks resolved) + sha256 into the signed config", async () => {
      const c = cli();
      const id = await paired(c);
      const real = join(c.home, "claude-2.1");
      writeFileSync(real, "#!/bin/sh\n");
      symlinkSync(real, join(c.home, "claude"));
      expect(await c.run(["claude", "pin", join(c.home, "claude")])).toBe(0);
      const cfg = readConfig(c.dir, {}, { keys: id.sign });
      expect(cfg.claude).toEqual({ path: real, sha256: createHash("sha256").update("#!/bin/sh\n").digest("hex") });
      expect(c.out()).toMatch(/Claude Code pinned/);
    });

    it("needs a paired computer", async () => {
      const c = cli();
      expect(await c.run(["claude", "pin", "/usr/bin/true"])).toBe(1);
      expect(c.err()).toMatch(/Pair this computer first/);
    });

    it("codex pin: path + sha256 into the signed config, next to the Claude Code pin", async () => {
      const c = cli();
      const id = await paired(c);
      const real = join(c.home, "codex-0.162");
      writeFileSync(real, "#!/bin/sh\n# codex\n");
      symlinkSync(real, join(c.home, "codex"));
      expect(await c.run(["codex", "pin", join(c.home, "codex")])).toBe(0);
      const cfg = readConfig(c.dir, {}, { keys: id.sign });
      expect(cfg.codex).toEqual({
        path: real,
        sha256: createHash("sha256").update("#!/bin/sh\n# codex\n").digest("hex"),
      });
      expect(c.out()).toMatch(/Codex pinned/);
      c.reset();
      expect(await c.run(["status"])).toBe(0);
      expect(c.out()).toMatch(/Codex\s+.*codex-0\.162 \(pinned, sha256/);
    });

    it("codex pin: needs a paired computer, and says how to install Codex when it isn't found", async () => {
      const c = cli({ env: { PATH: "/nonexistent" } });
      expect(await c.run(["codex", "pin", "/usr/bin/true"])).toBe(1);
      expect(c.err()).toMatch(/then run `chalito codex pin`/);
      await paired(c);
      c.reset();
      expect(await c.run(["codex", "pin"])).toBe(1);
      expect(c.err()).toMatch(/`codex` wasn't found.*developers\.openai\.com\/codex/);
    });

    it("keys set openai pins the Codex found on PATH when nothing is pinned yet", async () => {
      const bin = mkdtempSync(join(tmpdir(), "chalito-cli-bin-"));
      writeFileSync(join(bin, "codex"), "#!/bin/sh\n");
      chmodSync(join(bin, "codex"), 0o755);
      const c = cli({ env: { PATH: bin } });
      const id = await paired(c);
      expect(await c.run(["keys", "set", "openai"], ["sk-proj-abcdefgh12345678"])).toBe(0);
      expect(readConfig(c.dir, {}, { keys: id.sign }).codex?.path).toBe(join(bin, "codex"));
      expect(c.out()).toMatch(/Codex pinned/);
    });
  });
});
