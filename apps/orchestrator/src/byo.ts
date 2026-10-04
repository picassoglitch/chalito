import { AnthropicBrain } from "./brains/anthropic.js";
import type { Brain, BrainProviderId } from "./brains/brain.js";
import { GeminiBrain } from "./brains/gemini.js";
import { ResponsesBrain } from "./brains/responses.js";
import { brainKeyAad, type KeyWrapper } from "./kms.js";
import type { MesaStore } from "./store.js";

/** A brain on a given provider key (the person's own, for BYO cloud turns). */
export const brainForKey = (provider: BrainProviderId, apiKey: string): Brain => {
  switch (provider) {
    case "anthropic":
      return new AnthropicBrain({ apiKey });
    case "openai":
    case "xai":
      return new ResponsesBrain(provider, { apiKey });
    case "google":
      return GeminiBrain.apiKey(apiKey);
  }
};

/**
 * BYO brains: only when the person opted in to cloud turns for that provider (a KMS-wrapped copy
 * exists). The key is unwrapped per call and never stored in plaintext or logged.
 */
export const byoBrains =
  (p: { store: Pick<MesaStore, "wrappedBrainKey">; wrapper: KeyWrapper; make?: typeof brainForKey }) =>
  async (owner: string, provider: BrainProviderId): Promise<Brain | null> => {
    const wrapped = await p.store.wrappedBrainKey(owner, provider);
    if (!wrapped) return null;
    const key = await p.wrapper.unwrap(wrapped, brainKeyAad(owner, provider));
    return (p.make ?? brainForKey)(provider, key);
  };
