import type { ParticipantOutput } from "@chalito/protocol";

export type BrainProviderId = "anthropic" | "openai" | "xai" | "google";

/**
 * Token usage, split the way prices.yaml prices it. `input` is ordinary (uncached, unwritten)
 * input only; cache reads and writes are separate, whatever the provider reports them inside.
 */
export interface BrainUsage {
  input: number;
  output: number;
  cacheRead: number;
  /** Anthropic 5-minute writes; OpenAI's cache writes (one rate) also land here. */
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface BrainCall {
  model: string;
  /** Stable prefix (cached where the provider supports it). */
  persona: string;
  context: string;
  maxTokens: number;
}

export interface BrainResult {
  output: ParticipantOutput;
  usage: BrainUsage;
  /** The model's answer didn't validate and was replaced by a safe fallback. */
  repaired: boolean;
}

export interface Brain {
  readonly provider: BrainProviderId;
  call(c: BrainCall): Promise<BrainResult>;
}
