/**
 * The usage page's read API: GET /v1/usage/daily on apps/orchestrator, with this device's
 * bearer (client role). Costs come back too (internal: the hub sells tokens), and the page
 * shows tokens only.
 */
export interface UsageDay {
  day: string;
  managed: { work: { tokens: number }; comms: { tokens: number } };
  byo: { tokens: number };
  /** Communication's share of that day's managed spend (like the period ratio); null on a quiet day. */
  commsShare: number | null;
}

export interface Usage {
  days: UsageDay[];
  totals: { managedTokens: number; byoTokens: number };
  /** Communication's share of Chalito's own (managed) spend; null when nothing was spent. */
  commsOverheadRatio: number | null;
  /** The share communication should stay under (0.1). */
  target: number;
}

export type UsageApi = (days: number) => Promise<Usage | "error">;

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : NaN);

/** Keeps only what the page shows; anything malformed is an error, not zeros. */
export const parseUsage = (body: unknown): Usage | null => {
  const b = body as {
    days?: unknown;
    totals?: { managedTokens?: unknown; byoTokens?: unknown };
    commsOverheadRatio?: unknown;
    target?: unknown;
  } | null;
  if (!b || !Array.isArray(b.days)) return null;
  const days: UsageDay[] = [];
  for (const d of b.days as Record<string, unknown>[]) {
    type Part = { tokens?: unknown; costUsdMicros?: unknown };
    const m = d?.managed as { work?: Part; comms?: Part } | undefined;
    // Costs stay internal: used only for the share, never kept or shown.
    const workCost = count(m?.work?.costUsdMicros);
    const commsCost = count(m?.comms?.costUsdMicros);
    const spent = workCost + commsCost;
    const day = {
      day: typeof d?.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.day) ? d.day : "",
      managed: { work: { tokens: count(m?.work?.tokens) }, comms: { tokens: count(m?.comms?.tokens) } },
      byo: { tokens: count((d?.byo as { tokens?: unknown } | undefined)?.tokens) },
      commsShare: spent > 0 ? commsCost / spent : null,
    };
    if (!day.day || [day.managed.work.tokens, day.managed.comms.tokens, day.byo.tokens, spent].some(Number.isNaN))
      return null;
    days.push(day);
  }
  const managedTokens = count(b.totals?.managedTokens);
  const byoTokens = count(b.totals?.byoTokens);
  const ratio = b.commsOverheadRatio;
  const target = typeof b.target === "number" && b.target > 0 && b.target < 1 ? b.target : 0.1;
  if (Number.isNaN(managedTokens) || Number.isNaN(byoTokens)) return null;
  if (ratio !== null && !(typeof ratio === "number" && ratio >= 0 && ratio <= 1)) return null;
  return { days, totals: { managedTokens, byoTokens }, commsOverheadRatio: ratio, target };
};

export const httpUsage =
  (base: string, token: () => Promise<string | null>, fetchImpl: typeof fetch = (...a) => fetch(...a)): UsageApi =>
  async (days) => {
    const n = Math.min(31, Math.max(1, Math.round(days)));
    const bearer = await token();
    if (!base || !bearer) return "error";
    try {
      const r = await fetchImpl(`${base}/v1/usage/daily?days=${n}`, {
        headers: { authorization: `Bearer ${bearer}` },
        cache: "no-store",
      });
      if (!r.ok) return "error";
      return parseUsage(await r.json()) ?? "error";
    } catch {
      return "error";
    }
  };
