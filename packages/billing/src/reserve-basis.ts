/**
 * What `est_tokens` on a hub admit means. Hub commit 5f62bfb ("reservations hold the engine's
 * estimate plus the margin", on claude/consumption-caps) made the hub add the margin itself when it
 * reserves, so engines send the provider cost in tokens before the margin (cost ÷ 4 µ$). Before it
 * (a5733df alone) the hub reserved est_tokens as sent, so the estimate had to include the margin.
 *
 * - `pre_margin` (default): ceil(cost / 4). For a hub that includes 5f62bfb.
 * - `post_margin`: ceil(cost × (1 + margin) / 4). Only for a hub that merged a5733df alone.
 *
 * Store purchases don't go through this: their estimate is the price, and the hub reserves it as-is
 * (hub patch 02).
 */
export const RESERVE_BASES = ["pre_margin", "post_margin"] as const;
export type ReserveBasis = (typeof RESERVE_BASES)[number];

/** HUB_RESERVE_BASIS: unset means pre_margin; anything else unknown throws, so a typo fails at startup. */
export const parseReserveBasis = (raw: string | undefined): ReserveBasis => {
  if (raw === undefined || raw === "") return "pre_margin";
  if ((RESERVE_BASES as readonly string[]).includes(raw)) return raw as ReserveBasis;
  throw new Error(`HUB_RESERVE_BASIS=${raw} is not one of ${RESERVE_BASES.join(", ")}`);
};

/** The hub's default margin (hub 0049, DEFAULT_USAGE_MARGIN_PERCENT). */
export const HUB_MARGIN_PERCENT = 160;

/** `est_tokens` for an admit covering `costMicros` of provider cost. */
export const reserveTokens = (costMicros: number, basis: ReserveBasis, marginPercent = HUB_MARGIN_PERCENT): number =>
  basis === "pre_margin" ? Math.ceil(costMicros / 4) : Math.ceil((costMicros * (1 + marginPercent / 100)) / 4);
