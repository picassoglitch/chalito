/**
 * Names at a Mesa appear in briefs outside the quoted-data blocks, so the orchestrator accepts only
 * letters, digits, spaces and . _ ' - (apps/orchestrator core/mesa.ts SafeName). Anything else is
 * dropped here; an empty result falls back.
 */
const SAFE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u;

export const safeName = (raw: string, fallback: string): string => {
  const cleaned = raw
    .replace(/[^\p{L}\p{N} ._'-]/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .slice(0, 40)
    .trim();
  return SAFE.test(cleaned) ? cleaned : fallback;
};

/** A brain's Mesa name: the provider's label (integrations.*), else its id. */
export const brainName = (label: string, provider: string): string => safeName(label, provider);

/** Fresh client-side id for an input turn (a retry with the same id is refused, never re-spent). */
export const newTid = (): string => `t_${crypto.randomUUID().replace(/-/g, "")}`;
