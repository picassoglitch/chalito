import type { ModelsConfig } from "@chalito/config";
import type { EfficiencyProfile } from "@chalito/protocol";
import type { BrainProviderId } from "../brains/brain.js";
import type { Speaker } from "./mesa.js";

/**
 * Which provider and model a speaker uses: models.yaml and the person's efficiency profile only,
 * never the client. Brain participants use `profiles[p].mesa[provider]`; the companion uses
 * `profiles[p].companion`, falling back to the profile's Claude model when its provider isn't
 * configured here.
 */
export type Resolved = { provider: BrainProviderId; model: string } | { unavailable: string };

/** The provider a speaker would use under a profile (before checking what's configured). */
export const providerFor = (
  models: ModelsConfig,
  profile: Exclude<EfficiencyProfile, "free_min">,
  speaker: Speaker,
): BrainProviderId | null =>
  speaker.kind === "companion" ? (models.profiles[profile]?.companion?.provider ?? null) : speaker.provider;

export const resolveModel = (
  models: ModelsConfig,
  profile: EfficiencyProfile,
  speaker: Speaker,
  has: (p: BrainProviderId) => boolean,
): Resolved => {
  if (profile === "free_min") return { unavailable: "free_min" };
  const p = models.profiles[profile];
  if (!p) return { unavailable: `no profile ${profile}` };
  if (speaker.kind === "companion") {
    if (p.companion && has(p.companion.provider)) return { provider: p.companion.provider, model: p.companion.model };
    if (p.mesa?.anthropic && has("anthropic")) return { provider: "anthropic", model: p.mesa.anthropic };
    return { unavailable: "no companion model configured" };
  }
  const model = p.mesa?.[speaker.provider];
  if (!model) return { unavailable: `no ${speaker.provider} model in profile ${profile}` };
  if (!has(speaker.provider)) return { unavailable: `provider ${speaker.provider} not configured` };
  return { provider: speaker.provider, model };
};
