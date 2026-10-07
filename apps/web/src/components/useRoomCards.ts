"use client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { SignedCardsSource, type CardFiles } from "@chalito/scene/custom-card";
import { useChalito } from "./ChalitoProvider";

const noop = () => () => undefined;
const none = () => undefined;

/**
 * Co-members' custom cards in one room (GET /v1/avatar/rooms/:roomId/cards: the server signs them
 * only for members of that room, for 15 minutes; they're re-asked for before then and when a
 * drawing fails to load). Returns each member's files by companion id, or null: their roster avatar.
 * `memberKey` changes re-ask (someone joined, or changed what they wear).
 */
export const useRoomCards = (roomId: string, memberKey: string): ((companionId: string) => CardFiles | null) => {
  const { avatar } = useChalito();
  const source = useMemo(
    () =>
      avatar
        ? new SignedCardsSource({
            fetch: async () => {
              const m = await avatar.roomCards(roomId);
              if (m === "error") throw new Error("room cards unavailable");
              return m;
            },
          })
        : null,
    [avatar, roomId],
  );
  useEffect(() => () => source?.dispose(), [source]);
  useEffect(() => {
    if (source && memberKey) void source.refresh();
  }, [source, memberKey]);
  const snap = useSyncExternalStore(source?.subscribe ?? noop, source?.getSnapshot ?? none, none);
  return useMemo(() => (id: string) => (snap ? (source?.files(id) ?? null) : null), [snap, source]);
};
