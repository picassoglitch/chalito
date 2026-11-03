import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { z } from "zod";
import type { TeamMessage } from "./delivery/types.js";

/** One turn for an app that no open session can take: its CLI answers the waiting messages. */
export interface ResponderJob {
  /** Passed as CHALITO_TEAM_RUN, so the CLI's own team server is known as this run. */
  run: string;
  provider: string;
  workspace: string;
  cwd: string;
  messages: TeamMessage[];
}

const PROMPT = "{prompt}";
/** One-turn headless command per app, prompt at {prompt}, with the app's default permissions.
 *  ~/.chalito/team-responders.json can replace one (e.g. to add the app's own flags). */
export const RESPONDER_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  claude: ["claude", "-p", PROMPT],
  codex: ["codex", "exec", "--skip-git-repo-check", PROMPT],
  cursor: ["cursor-agent", "-p", PROMPT, "--trust", "--output-format", "text"],
  grok: ["grok", "-p", PROMPT],
  gemini: ["gemini", "-p", PROMPT],
  qwen: ["qwen", "-p", PROMPT],
  opencode: ["opencode", "run", PROMPT],
};

/** ~/.chalito/team-responders.json: {"<app id>": ["cli", "arg", "{prompt}", ...]} adds or replaces apps. */
const Custom = z.record(
  z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  z
    .array(z.string().max(512))
    .min(1)
    .max(32)
    .refine((a) => a.includes(PROMPT)),
);

export const responderPrompt = (job: ResponderJob): string => {
  const lines = job.messages.map((m) => `[${m.kind} from ${m.provider} (${m.from})]\n${m.text}`);
  return [
    `You are ${job.provider}, one of the AIs on the user's Chalito team, working in ${job.cwd}.`,
    "Teammates (other AIs, not the user) sent you these messages through Chalito:",
    "",
    ...lines,
    "",
    "Answer them. Your final answer is sent back to them automatically as your result, so end with a",
    "short, concrete reply. If you have the chalito_team tools you may also use team_send, but don't",
    "repeat your final answer there.",
  ].join("\n");
};

export interface CommandResponderOptions {
  home: string;
  /** The daemon's PATH; an app's CLI is often installed outside it (nvm, ~/.local/bin). */
  path?: string;
  /** Folder holding team-responders.json. */
  chalitoDir: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  log?: (event: string, meta: Record<string, unknown>) => void;
}

const nvmBins = (home: string): string[] => {
  const root = join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(root)
      .sort()
      .reverse()
      .map((v) => join(root, v, "bin"));
  } catch {
    return [];
  }
};

/** Runs the user's AI CLIs for one turn; never through a shell, so a message can't become a command. */
export class CommandResponder {
  #children = new Set<{ kill(sig: NodeJS.Signals): void }>();
  constructor(private readonly o: CommandResponderOptions) {}

  #commands(): Record<string, readonly string[]> {
    const file = join(this.o.chalitoDir, "team-responders.json");
    if (!existsSync(file)) return { ...RESPONDER_COMMANDS };
    try {
      const custom = Custom.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (custom.success) return { ...RESPONDER_COMMANDS, ...custom.data };
    } catch {
      /* reported below */
    }
    this.o.log?.("team.responder_config_invalid", { file });
    return { ...RESPONDER_COMMANDS };
  }

  #dirs(): string[] {
    const h = this.o.home;
    const fromPath = (this.o.path ?? process.env.PATH ?? "").split(delimiter).filter(Boolean);
    const extra = [
      join(h, ".local", "bin"),
      ...nvmBins(h),
      join(h, ".npm-global", "bin"),
      join(h, ".bun", "bin"),
      join(h, ".grok", "bin"),
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
    ];
    return [...new Set([...fromPath, ...extra])];
  }

  #find(bin: string): string | null {
    if (bin.includes("/") || bin.includes("\\")) return existsSync(bin) ? bin : null;
    // Windows .cmd shims would need a shell; only real executables run there.
    const name = (this.o.platform ?? process.platform) === "win32" ? `${bin}.exe` : bin;
    for (const dir of this.#dirs()) {
      const full = join(dir, name);
      try {
        if (statSync(full).isFile()) return full;
      } catch {
        /* not here */
      }
    }
    return null;
  }

  has(provider: string): boolean {
    const argv = this.#commands()[provider];
    return !!argv && !!this.#find(argv[0]!);
  }

  run(job: ResponderJob): Promise<string | null> {
    const argv = this.#commands()[job.provider];
    const bin = argv && this.#find(argv[0]!);
    if (!argv || !bin) return Promise.resolve(null);
    const prompt = responderPrompt(job);
    const args = argv.slice(1).map((a) => a.split(PROMPT).join(prompt));
    // Its own folder first: npm CLIs start with `#!/usr/bin/env node`.
    const env = { ...process.env, PATH: [dirname(bin), ...this.#dirs()].join(delimiter), CHALITO_TEAM_RUN: job.run };
    return new Promise((resolve) => {
      const posix = (this.o.platform ?? process.platform) !== "win32";
      // Its own process group, so a timeout also stops what the CLI started.
      const child = spawn(bin, args, { cwd: job.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: posix });
      const kill = (sig: NodeJS.Signals) => {
        try {
          if (posix && child.pid) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch {
          /* already gone */
        }
      };
      const handle = { kill };
      this.#children.add(handle);
      let out = "",
        err = "";
      const cap = (s: string, add: Buffer) => (s.length > 200_000 ? s : s + add.toString("utf8"));
      child.stdout.on("data", (d: Buffer) => (out = cap(out, d)));
      child.stderr.on("data", (d: Buffer) => (err = cap(err, d)));
      const timer = setTimeout(
        () => {
          kill("SIGTERM");
          setTimeout(() => kill("SIGKILL"), 5000).unref();
        },
        this.o.timeoutMs ?? 15 * 60_000,
      );
      timer.unref();
      let settled = false;
      const done = (code: number | null, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#children.delete(handle);
        const answer = out.trim();
        this.o.log?.("team.responder_exit", { provider: job.provider, code, bytes: answer.length });
        if (code === 0 && answer) return resolve(answer);
        // The asker hears why, instead of waiting for an answer that never comes.
        const why = error?.message ?? (err.trim().split("\n").slice(-3).join(" ").slice(0, 400) || "no output");
        resolve(`(${job.provider} could not answer: exit ${code ?? "killed"}: ${why})${answer ? `\n${answer}` : ""}`);
      };
      child.on("error", (e) => done(null, e));
      child.on("close", (code) => done(code));
    });
  }

  close() {
    for (const c of this.#children) c.kill("SIGTERM");
  }
}
