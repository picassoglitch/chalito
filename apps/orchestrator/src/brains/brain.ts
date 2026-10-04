import type { ParticipantOutput } from "@chalito/protocol";

export interface BrainUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface BrainCall {
  model: string;
  /** Stable prefix (cached). */
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
  call(c: BrainCall): Promise<BrainResult>;
}
