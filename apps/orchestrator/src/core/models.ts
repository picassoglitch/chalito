import type { ModelsConfig } from "@chalito/config";
import type { EfficiencyProfile } from "@chalito/protocol";
import type { Speaker } from "./mesa.js";

/**
 * Which model a speaker uses, from models.yaml and the person's efficiency profile only (never
 * from the client). This service calls Anthropic; a profile whose companion is on another
 * provider (e.g. `low` → Gemini) falls back to that profile's Anthropic Mesa model, and other
 * providers' brain participants are unavailable until their adapters land.
 */
export type Resolved = { provider: "anthropic"; model: string } | { unavailable: string };

export const resolveModel = (
  models: ModelsConfig,
  profile: EfficiencyProfile,
  speaker: Speaker,
  defaults: { companion: string } = { companion: "claude-sonnet-5-5" },
): Resolved => {
  if (profile === "free_min") return { unavailable: "free_min" };
  const p = models.profiles[profile];
  if (!p) return { unavailable: `no profile ${profile}` };
  if (speaker.kind === "companion") {
    if (p.companion?.provider === "anthropic") return { provider: "anthropic", model: p.companion.model };
    const fallback = p.mesa?.anthropic;
    return { provider: "anthropic", model: fallback ?? defaults.companion };
  }
  if (speaker.provider !== "anthropic") return { unavailable: `provider ${speaker.provider} not available yet` };
  const m = p.mesa?.anthropic;
  return m ? { provider: "anthropic", model: m } : { unavailable: "no anthropic model in profile" };
};
