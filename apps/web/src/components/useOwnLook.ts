"use client";
import { useEffect, useState } from "react";
import { CARD_WAIT_MS, loadLastLook, ownLook, saveLastLook, type OwnLook } from "@/lib/own-look";
import { ownerOf, useChalito } from "./ChalitoProvider";
import { useMyCard, type MyCard } from "./useMyCard";

/**
 * The person's own custom card and what to draw for their companion now (see lib/own-look):
 * pending until the api answers (or CARD_WAIT_MS passes), then one look, remembered per account.
 */
export const useOwnLook = (): { mine: MyCard; look: OwnLook } => {
  const { myCard: source, session } = useChalito();
  const owner = session.status === "signed_in" ? ownerOf(session.session) : undefined;
  const mine = useMyCard();
  const [waitOver, setWaitOver] = useState(false);
  useEffect(() => {
    if (!source || mine.known) return;
    const t = setTimeout(() => setWaitOver(true), CARD_WAIT_MS);
    return () => clearTimeout(t);
  }, [source, mine.known]);
  // Read after hydration: the server renders the stand-in.
  const [last, setLast] = useState<ReturnType<typeof loadLastLook>>(null);
  useEffect(() => setLast(loadLastLook(owner)), [owner]);
  const card = mine.card ? "custom" : mine.known || waitOver ? "none" : "unknown";
  const look = ownLook(card, last);
  const settled = card !== "unknown";
  useEffect(() => {
    if (settled && owner && look !== "pending") saveLastLook({ owner, kind: look });
  }, [settled, owner, look]);
  return { mine, look };
};
