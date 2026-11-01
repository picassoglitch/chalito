import {
  CustomCardSource,
  SignedCardsSource,
  parseRoomCards,
  parseSignedCard,
  type SignedCard,
} from "@chalito/scene/custom-card";
import type { RoomWindowDeps } from "./room-window.js";

/** The avatar bucket's signed-URL host (tauri.conf.json img-src allows it). */
const SIGNED = /^https:\/\/storage\.googleapis\.com\//;

/**
 * GET /v1/avatar/companion through the panel's borrowed device session: the companion's custom
 * card, or null when it wears a roster avatar or is explicitly signed out. Throws when it can't
 * tell (the source keeps what it had and retries).
 */
export const companionCardFetcher =
  (
    deps: () => Promise<Pick<RoomWindowDeps, "companionCard"> | null>,
    now: () => number = Date.now,
    hasAccount: () => boolean = () => true,
  ) =>
  async (): Promise<SignedCard | null> => {
    if (!hasAccount()) return null;
    const d = await deps();
    if (!d?.companionCard) throw new Error("companion session is not ready");
    const c = parseSignedCard(await d.companionCard(), { now: now(), isUrl: (u) => SIGNED.test(u) });
    if (c === "invalid") throw new Error("unusable custom card");
    return c;
  };

/** The person's own custom card for the pet and the room window, with its signed URLs kept fresh. */
export const companionCardSource = (
  deps: () => Promise<Pick<RoomWindowDeps, "companionCard"> | null>,
  hasAccount: () => boolean = () => true,
) => new CustomCardSource({ fetch: companionCardFetcher(deps, Date.now, hasAccount), waitOnFailure: true });

/** A room's members' custom cards by companion id (the server signs them for members only, 15 min). */
export const roomCardsFetcher =
  (roomCards: (roomId: string) => Promise<unknown>, roomId: string, now: () => number = Date.now) =>
  async (): Promise<Map<string, SignedCard>> => {
    const m = parseRoomCards(await roomCards(roomId), { now: now(), isUrl: (u) => SIGNED.test(u) });
    if (m === "invalid") throw new Error("unusable room cards");
    return m;
  };

export const roomCardsSource = (roomCards: (roomId: string) => Promise<unknown>, roomId: string) =>
  new SignedCardsSource({ fetch: roomCardsFetcher(roomCards, roomId) });
