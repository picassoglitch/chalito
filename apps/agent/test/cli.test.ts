import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { generateSigningKeyPair } from "@chalito/crypto";
import { lineDiff, main, parseArgs, type CliIo } from "../src/cli.js";
import { chalitoDir } from "../src/config.js";
import type { Daemon } from "../src/daemon.js";
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
    tty?: boolean;
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
    input.isTTY = opts.tty ?? false;
    input.end(lines.map((l) => `${l}\n`).join(""));
    return {
      out: (s) => void (out += s),
      err: (s) => void (err += s),
      tty: { input, output: new PassThrough() },
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
      expect(c.err()).toMatch(/interactive terminal/);
      expect(c.runs).toHaveLength(0);
    });

    it("on: OS auth + three confirmations + phrase writes a signed liability record", async () => {
      const c = cli({ tty: true });
      expect(await c.run(["devmode", "on", "autoApproveHigh"], ["y", "y", "y", "I ACCEPT"])).toBe(0);
      expect(c.runs).toEqual([{ cmd: "pkexec", args: ["/bin/true"], interactive: true }]);
      const id = await loadOrCreateIdentity(c.secrets);
      const store = new DevModeStore(c.dir, id.sign, id.deviceId);
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

  describe("policy", () => {
    const editTo = (text: string) => (r: Run) => {
      writeFileSync(r.args.at(-1)!, text);
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

    it("edit: $EDITOR on a temp copy → validate → diff → confirm → signed write", async () => {
      const c = cli({ runner: editTo(loosened), env: { EDITOR: "nano -w" } });
      expect(await c.run(["policy", "edit"], ["y"])).toBe(0);
      expect(c.runs[0]).toMatchObject({ cmd: "nano", interactive: true });
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
      expect(c.runs.map((r) => [r.cmd, ...r.args].join(" "))).toEqual([
        "systemctl --user daemon-reload",
        "systemctl --user enable --now chalito-agent.service",
      ]);
      expect(await c.run(["service", "uninstall"])).toBe(0);
      expect(existsSync(unit)).toBe(false);
      expect(c.runs.at(-1)!.args).toEqual(["--user", "disable", "--now", "chalito-agent.service"]);
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
});
