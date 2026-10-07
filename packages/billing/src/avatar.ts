import type { PricesConfig } from "@chalito/config";
import type { HubUsageEvent } from "@chalito/protocol";
import { usageEvent } from "./billable.js";
import { imageCostMicros } from "./cost.js";
import { HUB_MARGIN_PERCENT, reserveTokens, type ReserveBasis } from "./reserve-basis.js";

/**
 * Custom companions (a photo → the roster's five drawings). The first creation per user is free;
 * every later one is billed at the provider's real cost through the hub, which adds its margin
 * (160% by default), so the user pays cost + 160%. Only successful creations are billed.
 */
export const AVATAR_EMOTIONS = ["happy", "sad", "surprised", "tired"] as const;
/** Image calls in one successful creation: the neutral drawing plus one edit per emotion. */
export const AVATAR_IMAGES = 1 + AVATAR_EMOTIONS.length;

export interface AvatarModel {
  provider: string;
  model: string;
}

export interface AvatarQuote {
  /** Provider cost of one successful creation (µ$). */
  costMicros: number;
  /** `est_tokens` for the hub admit (follows HUB_RESERVE_BASIS). */
  estTokens: number;
  /** What the hub bills for it at the default margin: what the UI shows. */
  priceTokens: number;
}

export const avatarQuote = (
  prices: PricesConfig,
  m: AvatarModel,
  basis: ReserveBasis,
  marginPercent = HUB_MARGIN_PERCENT,
): AvatarQuote => {
  const costMicros = imageCostMicros(prices, m.provider, m.model, AVATAR_IMAGES);
  return {
    costMicros,
    estTokens: reserveTokens(costMicros, basis, marginPercent),
    priceTokens: Math.max(1, Math.ceil((costMicros * (1 + marginPercent / 100)) / 4)),
  };
};

/**
 * The usage event of a successful PAID creation: the real cost of the images it made. One per
 * creation (`avatar:<creationId>`), so a retried report is the same event. Free creations and
 * failures never produce one.
 */
export const avatarUsageEvent = (p: {
  owner: string;
  creationId: string;
  images: number;
  costMicros: number;
  reservationId: string;
  model: AvatarModel;
  occurredAt: number;
}): HubUsageEvent =>
  usageEvent(
    { owner: p.owner, billingMode: "managed", origin: "avatar.job" },
    {
      kind: "image.generations",
      provider: p.model.provider,
      amount: p.images,
      costUsdMicros: p.costMicros,
      occurredAt: p.occurredAt,
      sourceId: `avatar:${p.creationId}`,
      reservationId: p.reservationId,
      metadata: { model: p.model.model },
    },
  )!;
