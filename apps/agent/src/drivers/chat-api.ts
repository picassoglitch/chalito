import { ChatApiAdapter, connectMcpTools } from "@chalito/adapters/chat-api";
import { type DriverFactory, registerDriver } from "./registry.js";

/**
 * The engine's `chat-api` factory (ADR 0022 §4): a session adapter for any recipe with
 * `driver.chatApi` (an OpenAI-compatible endpoint). The person's own key comes from this
 * computer's keychain (`app.connect` with a key, the same storage as every other app's key);
 * an endpoint that needs none (a local Ollama or LM Studio) runs without one. Null when the
 * recipe needs a key and none is stored. Tools: only the session's gated computer-control MCP
 * server, and only when the recipe says the provider does tool calls.
 */
export const chatApiDriverFactory: DriverFactory = (ctx) => {
  if (!ctx.recipe.driver.chatApi) return null;
  if (ctx.recipe.apiKey && !ctx.auth.apiKey) return null;
  return {
    adapter: new ChatApiAdapter(ctx.recipe, {
      ...(ctx.auth.apiKey ? { apiKey: ctx.auth.apiKey } : {}),
      connectTools: connectMcpTools,
    }),
  };
};

registerDriver("chat-api", chatApiDriverFactory);
