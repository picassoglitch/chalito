import { accessSync, constants, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { RAW_SHELL_APP_ID } from "@chalito/protocol";
import { which } from "../runner.js";

/**
 * The `terminal` driver (registered with `registerDriver("terminal", …)`, drivers/terminal.ts): from a
 * recipe's `driver.terminal.command` to what the PTY runs. The command comes from the recipe on
 * this device (Chalito's signed catalog or the person's own local recipe), never from the remote
 * command, which only names the recipe.
 */

/** The part of a recipe (packages/protocol recipe.ts) the terminal driver reads. */
export interface TerminalRecipe {
  id: string;
  name?: string;
  driver: { terminal?: unknown } & Record<string, unknown>;
}

export const TerminalDriverSpec = z.object({
  command: z.array(z.string().min(1).max(4096)).min(1).max(64),
});

export interface TerminalLaunch {
  appId: string;
  name: string;
  /** argv; [0] is a program name looked up on PATH, or an absolute path. */
  command: string[];
  rawShell: boolean;
}

export const terminalDriverFactory = (recipe: TerminalRecipe): TerminalLaunch | null => {
  if (recipe.id === RAW_SHELL_APP_ID) return null; // the raw shell is built in (rawShellLaunch), never a recipe
  const spec = TerminalDriverSpec.safeParse(recipe.driver.terminal);
  if (!spec.success) return null;
  return { appId: recipe.id, name: recipe.name ?? recipe.id, command: spec.data.command, rawShell: false };
};

const LOGIN_SHELLS = new Set(["bash", "zsh", "fish", "sh", "dash", "ksh", "mksh", "tcsh", "csh"]);

/** The person's own shell, as a login shell where it supports `-l`. */
export const rawShellLaunch = (
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): TerminalLaunch => {
  if (platform === "win32")
    return { appId: RAW_SHELL_APP_ID, name: "PowerShell", command: ["powershell.exe", "-NoLogo"], rawShell: true };
  const shell = env.SHELL && env.SHELL.startsWith("/") ? env.SHELL : "/bin/sh";
  return {
    appId: RAW_SHELL_APP_ID,
    name: "Shell",
    command: LOGIN_SHELLS.has(basename(shell)) ? [shell, "-l"] : [shell],
    rawShell: true,
  };
};

/** A recipe's argv[0] → the executable to run: an absolute path that exists, or a PATH lookup. */
export const resolveProgram = (
  program: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  if (!isAbsolute(program)) return which(program, env, platform);
  try {
    if (!statSync(program).isFile()) return null;
    if (platform !== "win32") accessSync(program, constants.X_OK);
    return program;
  } catch {
    return null;
  }
};
