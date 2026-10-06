import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { Provider } from "@chalito/protocol";
import type { RunResult } from "./runner.js";
import { SECRET_NAMES } from "./secrets.js";

/**
 * Each provider's official coding-agent CLI, and how Chalito drives it (connect contract,
 * 2026-10-05). Official tools only: the npm package the vendor publishes, the vendor's own login
 * command (the person signs in on their own machine, in their browser), and the vendor's own
 * status/logout commands. Chalito never implements a provider's consumer OAuth, never scrapes a
 * web session, and never reads or copies a token out of a CLI's storage.
 *
 * Claude Code and Codex sign in to Chalito's own profile (CLAUDE_CONFIG_DIR, CODEX_HOME under
 * ~/.chalito), so signing in or out here never touches the person's own setup. Grok Build and
 * Gemini CLI sign in to the person's own login (~/.grok, ~/.gemini), which is what the ACP
 * adapter's sign-in sessions use (packages/adapters/src/acp/profiles.ts).
 *
 * Checked against the CLIs' own --help on 2026-10-06: Claude Code 2.1.291, codex-cli 0.160.1,
 * grok 1.0.46, Gemini CLI 0.62.0 (bundle source for its ACP `authenticate`).
 */
export interface ProviderCli {
  bin: "claude" | "codex" | "grok" | "gemini";
  /** The vendor's own npm package (`npm install -g`). */
  npmPackage: string;
  /** Keychain slot for a BYO API key. */
  secret: string;
  /** What a key usually looks like; a mismatch is only logged (the CLI's `keys set` only warns too). */
  keyShape: RegExp;
  /** Chalito's own profile for this CLI, or {} when the CLI has no documented way to move it. */
  profileEnv(chalitoDir: string): Record<string, string>;
  /**
   * The official sign-in. `args`: a CLI command that opens the browser (or prints a link) and
   * exits 0 once signed in. `acp`: the CLI's ACP `authenticate` with this method id.
   */
  login: { args: string[] } | { acp: { args: string[]; methodId: string } };
  /**
   * The official "am I signed in" check, or null when the CLI has none: then the agent trusts
   * only its own record of a sign-in that finished here.
   */
  status: { args: string[]; signedIn(r: RunResult): boolean } | null;
  /** Sign out of the profile the sign-in used; null: the CLI has no sign-out command. */
  logout: { args: string[] } | null;
  /** Hosts whose links the agent may open for the person while a sign-in waits (see `openLinks`). */
  linkHosts: string[];
  /** Whether the agent opens those links itself: the CLI prints them without opening a browser. */
  openLinks: boolean;
}

export const PROVIDER_CLI: Record<Provider, ProviderCli> = {
  anthropic: {
    bin: "claude",
    npmPackage: "@anthropic-ai/claude-code",
    secret: SECRET_NAMES.anthropicApiKey,
    keyShape: /^sk-ant-/,
    profileEnv: (dir) => ({ CLAUDE_CONFIG_DIR: join(dir, "claude") }),
    // `claude auth login` (Claude subscription is the default; --claudeai makes it explicit).
    // Anthropic's own flow; the credentials stay in that profile and Chalito never sees them.
    login: { args: ["auth", "login", "--claudeai"] },
    status: {
      args: ["auth", "status", "--json"],
      signedIn: (r) => {
        try {
          return r.code === 0 && (JSON.parse(r.stdout) as { loggedIn?: unknown }).loggedIn === true;
        } catch {
          return false;
        }
      },
    },
    logout: { args: ["auth", "logout"] },
    linkHosts: ["claude.ai", "claude.com", "console.anthropic.com"],
    openLinks: false,
  },
  openai: {
    bin: "codex",
    npmPackage: "@openai/codex",
    secret: SECRET_NAMES.openaiApiKey,
    keyShape: /^sk-/,
    // The adapter runs Codex with the same CODEX_HOME (daemon.ts).
    profileEnv: (dir) => ({ CODEX_HOME: join(dir, "codex") }),
    login: { args: ["login"] },
    // "Not logged in" exits 1.
    status: { args: ["login", "status"], signedIn: (r) => r.code === 0 },
    logout: { args: ["logout"] },
    linkHosts: ["auth.openai.com"],
    openLinks: false,
  },
  xai: {
    bin: "grok",
    npmPackage: "@xai-official/grok",
    secret: SECRET_NAMES.xaiApiKey,
    keyShape: /^xai-/,
    // No documented way to move ~/.grok, so a Grok sign-in is the person's own Grok Build login.
    profileEnv: () => ({}),
    // Without a terminal, `grok login` prints an accounts.x.ai link and code and waits.
    login: { args: ["login"] },
    status: null,
    logout: { args: ["logout"] },
    linkHosts: ["accounts.x.ai", "auth.x.ai"],
    openLinks: true,
  },
  google: {
    bin: "gemini",
    npmPackage: "@google/gemini-cli",
    secret: SECRET_NAMES.googleApiKey,
    keyShape: /^AIza/,
    // The person's own ~/.gemini: the ACP adapter's sign-in sessions use the saved Google login.
    profileEnv: () => ({}),
    // Gemini CLI has no login subcommand. Its ACP agent's `authenticate` with "oauth-personal"
    // ("Login with Google") opens the browser and caches the login like `gemini` → /auth does.
    login: { acp: { args: ["--acp"], methodId: "oauth-personal" } },
    status: null,
    // No sign-out command; it's the person's own login, so Chalito only forgets it here.
    logout: null,
    linkHosts: ["accounts.google.com"],
    openLinks: false,
  },
};

/** The CLIs and the agent's own child processes. Injected so tests never run a real CLI. */
export interface ProviderProcs {
  /**
   * Runs `cmd` to completion with no terminal (stdin closed), killing it after `timeoutMs`
   * (code 124, like `timeout`). `onLine` sees each output line as it comes.
   */
  run(
    cmd: string,
    args: string[],
    opts: { env: Record<string, string | undefined>; timeoutMs: number; onLine?: (line: string) => void },
  ): Promise<RunResult>;
  /**
   * ACP over stdio: `initialize`, then `authenticate {methodId}`. True when the agent answers
   * the authenticate request without an error.
   */
  acpAuthenticate(
    cmd: string,
    args: string[],
    opts: { env: Record<string, string | undefined>; timeoutMs: number; methodId: string },
  ): Promise<boolean>;
  /** Opens a link in the person's default browser on this computer. */
  openUrl(url: string): Promise<void>;
}

const opener = (platform: NodeJS.Platform, url: string): [string, string[]] =>
  platform === "darwin"
    ? ["open", [url]]
    : platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : ["xdg-open", [url]];

export const spawnProviderProcs = (platform: NodeJS.Platform = process.platform): ProviderProcs => ({
  run: (cmd, args, opts) =>
    new Promise((resolve) => {
      // npm and the CLIs' launchers are .cmd files on Windows, which need a shell.
      const child = spawn(cmd, args, {
        env: opts.env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: platform === "win32" && /\.(cmd|bat)$/i.test(cmd),
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, opts.timeoutMs);
      const lines = (stream: NodeJS.ReadableStream | null, sink: (s: string) => void) => {
        if (!stream) return;
        createInterface({ input: stream, crlfDelay: Infinity }).on("line", (l) => {
          sink(`${l}\n`);
          opts.onLine?.(l);
        });
      };
      lines(child.stdout, (s) => (stdout += s));
      lines(child.stderr, (s) => (stderr += s));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: err.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr });
      });
    }),

  acpAuthenticate: (cmd, args, opts) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, {
        env: opts.env,
        stdio: ["pipe", "pipe", "ignore"],
        shell: platform === "win32" && /\.(cmd|bat)$/i.test(cmd),
        windowsHide: true,
      });
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdin.end();
        child.kill();
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), opts.timeoutMs);
      const send = (m: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
      child.on("error", () => done(false));
      child.on("close", () => done(false));
      child.stdin.on("error", () => undefined);
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
        let msg: { id?: unknown; result?: unknown; error?: unknown };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          return;
        }
        if (msg.id === 0) {
          if (msg.error) return done(false);
          send({ id: 1, method: "authenticate", params: { methodId: opts.methodId } });
        } else if (msg.id === 1) done(!msg.error);
      });
      send({
        id: 0,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
      });
    }),

  openUrl: async (url) => {
    const [cmd, args] = opener(platform, url);
    await new Promise<void>((resolve) => {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
      child.on("error", () => resolve());
      child.on("spawn", () => {
        child.unref();
        resolve();
      });
    });
  },
});

/** The first https link in a CLI's output line, if it's on one of `hosts` (or a subdomain). */
export const officialLink = (line: string, hosts: string[]): string | null => {
  for (const m of line.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try {
      const u = new URL(m[0]);
      if (hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return u.toString();
    } catch {
      /* not a URL */
    }
  }
  return null;
};

/** `x.y.z` (with any pre-release tail) from a `--version` line, at most 64 characters. */
export const parseVersion = (out: string): string | null => {
  const m = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/.exec(out);
  return m ? m[0].slice(0, 64) : null;
};
