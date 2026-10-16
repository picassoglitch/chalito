import { A2aAdapter } from "@chalito/adapters/a2a";
import { type DriverFactory, registerDriver } from "./registry.js";

/**
 * The engine's `a2a` factory (ADR 0022 §4): a remote A2A v1.0 agent (`driver.a2a.url`, its Agent
 * Card at `/.well-known/agent-card.json`) as a session adapter. The person's token for it, if the
 * agent needs one, is the keychain key; it's sent only to the recipe's own origin. Null when the
 * recipe needs a key and none is stored.
 */
export const a2aDriverFactory: DriverFactory = (ctx) => {
  if (!ctx.recipe.driver.a2a) return null;
  if (ctx.recipe.apiKey && !ctx.auth.apiKey) return null;
  return { adapter: new A2aAdapter(ctx.recipe, ctx.auth.apiKey ? { apiKey: ctx.auth.apiKey } : {}) };
};

registerDriver("a2a", a2aDriverFactory);
