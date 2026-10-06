import { terminalDriverFactory } from "../terminal/driver.js";
import { type DriverFactory, registerDriver } from "./registry.js";

/**
 * The engine's `terminal` factory: what remote terminal runs for a recipe with
 * `driver.terminal` (`{ terminal: TerminalLaunch }`), or null without one. The raw shell is never
 * a recipe (terminal/driver.ts `rawShellLaunch`, its own local toggle).
 */
export const terminalDriver: DriverFactory = (ctx) => {
  const terminal = terminalDriverFactory(ctx.recipe);
  return terminal ? { terminal } : null;
};

registerDriver("terminal", terminalDriver);
