import { AcpAdapter } from "@chalito/adapters/acp";
import { type DriverContext, registerDriver } from "./registry.js";

/**
 * The ACP driver: any recipe with `driver.acp` (Grok Build, Gemini CLI, Goose, OpenCode, Qwen
 * Code, …) runs on the one ACP adapter. Throws for a recipe that can't run safely (no ACP driver,
 * a flag that skips approvals, a key variable that isn't a key; D-064).
 */
export const acpDriver = (ctx: DriverContext): AcpAdapter => {
  // Only the pinned CLI runs, never whatever `command[0]` finds on PATH.
  if (!ctx.binPath) throw new Error(`${ctx.recipe.name} isn't pinned on this computer`);
  return new AcpAdapter(
    { ...ctx.recipe, driver: { acp: ctx.recipe.driver.acp } },
    {
      binPath: ctx.binPath,
      ...(ctx.apiKey ? { apiKey: ctx.apiKey } : { signIn: ctx.signIn ?? false }),
      home: ctx.home,
      env: ctx.env,
    },
  );
};

registerDriver("acp", acpDriver);
