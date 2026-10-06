import type { ProviderProcs } from "../src/provider-cli.js";
import type { RunResult } from "../src/runner.js";

export interface ProcCall {
  cmd: string;
  args: string[];
  env: Record<string, string | undefined>;
}

/**
 * Plays the providers' CLIs and npm: every call is recorded, and `answer` decides what a command
 * prints and exits with (by default `--version` prints a version and everything else exits 0).
 */
export const fakeProviderProcs = (answer: (c: ProcCall) => Partial<RunResult> & { lines?: string[] } = () => ({})) => {
  const calls: ProcCall[] = [];
  const acp: (ProcCall & { methodId: string })[] = [];
  const opened: string[] = [];
  const launched: ProcCall[] = [];
  const launchResult = { ok: true };
  const acpResult = { ok: true };
  const procs: ProviderProcs = {
    run: async (cmd, args, opts) => {
      const c = { cmd, args, env: opts.env };
      calls.push(c);
      const a = answer(c);
      for (const l of a.lines ?? []) opts.onLine?.(l);
      const version = args[0] === "--version" ? "1.2.3\n" : "";
      return { code: a.code ?? 0, stdout: a.stdout ?? version, stderr: a.stderr ?? "" };
    },
    acpAuthenticate: async (cmd, args, opts) => {
      acp.push({ cmd, args, env: opts.env, methodId: opts.methodId });
      return acpResult.ok;
    },
    openUrl: async (url) => void opened.push(url),
    launch: async (cmd, args, opts) => {
      launched.push({ cmd, args, env: opts.env });
      return launchResult.ok;
    },
  };
  return { procs, calls, acp, opened, acpResult, launched, launchResult };
};
