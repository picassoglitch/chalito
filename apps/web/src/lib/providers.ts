import "server-only";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { AgentOption } from "@/components/Onboarding";

const AGENTS = ["claude-code", "codex", "grok-build"] as const;
const PROVIDERS = ["anthropic", "openai", "xai"] as const;

/**
 * Coding agents and their official auth paths, straight from packages/config/providers.yaml
 * (validated by @chalito/config's ProvidersConfig in that package's tests). Read at build time;
 * anything unexpected fails the build rather than showing made-up copy.
 */
export const agentOptions = (): AgentOption[] => {
  const raw = parse(readFileSync(join(process.cwd(), "../../packages/config/providers.yaml"), "utf8")) as {
    providers: Record<string, { subscriptionLocal?: unknown }>;
    codingAgents: Record<string, { provider: string; auth: string[] }>;
  };
  return Object.entries(raw.codingAgents).map(([agent, a]) => {
    if (!(AGENTS as readonly string[]).includes(agent) || !(PROVIDERS as readonly string[]).includes(a.provider))
      throw new Error(`providers.yaml: unexpected coding agent ${agent} (${a.provider})`);
    return {
      agent: agent as AgentOption["agent"],
      provider: a.provider as AgentOption["provider"],
      auth: [...a.auth],
      subscription: String(raw.providers[a.provider]?.subscriptionLocal ?? "off"),
    };
  });
};
