/**
 * The owner's hub balance in tokens (GET /v1/billing/balance on apps/api, cached there ~30 s).
 * Tokens only: prices and currency live on the hub.
 */
export interface Balance {
  remaining: number;
  unlimited: boolean;
  monthlyAllocation: number;
  bonus: number;
  monthlyUsed: number;
  /** Held by work in progress (reservations), not spent yet. */
  reserved: number;
  /** When the current monthly period started (ms). */
  periodStart: number;
}

/** The hub didn't answer (503 hub_unavailable), or anything else went wrong. */
export type BalanceApi = () => Promise<Balance | "unavailable" | "error">;

const count = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export const parseBalance = (body: unknown): Balance | null => {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b.unlimited !== "boolean") return null;
  const nums = [b.remaining, b.monthlyAllocation, b.bonus, b.monthlyUsed, b.reserved];
  // `remaining` may go below zero on the hub (usage after the last check); show it as zero.
  if (typeof b.remaining !== "number" || !Number.isFinite(b.remaining) || !nums.slice(1).every(count)) return null;
  const start = typeof b.periodStart === "string" ? Date.parse(b.periodStart) : NaN;
  if (Number.isNaN(start)) return null;
  return {
    remaining: Math.max(0, b.remaining),
    unlimited: b.unlimited,
    monthlyAllocation: b.monthlyAllocation as number,
    bonus: b.bonus as number,
    monthlyUsed: b.monthlyUsed as number,
    reserved: b.reserved as number,
    periodStart: start,
  };
};

export const httpBalance =
  (base: string, token: () => Promise<string | null>, fetchImpl: typeof fetch = (...a) => fetch(...a)): BalanceApi =>
  async () => {
    const bearer = await token();
    if (!base || !bearer) return "error";
    try {
      const r = await fetchImpl(`${base}/v1/billing/balance`, {
        headers: { authorization: `Bearer ${bearer}` },
        cache: "no-store",
      });
      if (r.status === 503) return "unavailable";
      if (!r.ok) return "error";
      return parseBalance(await r.json().catch(() => null)) ?? "error";
    } catch {
      return "error";
    }
  };
