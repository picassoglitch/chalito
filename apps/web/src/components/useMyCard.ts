"use client";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { signedThumb, type CardFiles, type SignedCard } from "@chalito/scene/custom-card";
import { useChalito } from "./ChalitoProvider";

const noop = () => () => undefined;
const none = () => undefined;
/** A drawing that fails again this soon after a refresh means the card can't be shown: roster avatar. */
const RETRY_WINDOW_MS = 60_000;

export interface MyCard {
  /** The custom card to draw, or null: draw the roster avatar (none, not loaded yet, or broken). */
  card: SignedCard | null;
  /** The same card for @chalito/scene's loaders (late-bound URLs, stable while the card is the same). */
  files: CardFiles | null;
  /** The neutral drawing's URL and the 128 px thumbnail's. */
  drawing: string | null;
  thumb: string | null;
  /** True once the api answered (with or without a card). */
  known: boolean;
  /** The companion wears a custom card (even one that can't be drawn right now). */
  wearing: boolean;
  /** For <img onError>: refreshes the signed URLs once; failing again falls back to the roster avatar. */
  onError: () => void;
  /** Re-fetch now (after "use", or after picking a roster avatar). */
  refresh: () => Promise<void>;
}

/**
 * The person's OWN companion's custom card (the ChalitoProvider's CustomCardSource). Only for
 * drawing the viewer's own companion: co-members are always drawn from their roster avatar.
 */
export const useMyCard = (): MyCard => {
  const { myCard: source } = useChalito();
  const snap = useSyncExternalStore(source?.subscribe ?? noop, source?.getSnapshot ?? none, none);
  const [broken, setBroken] = useState<string | null>(null);
  const lastTry = useRef(0);
  const card = snap && broken !== snap.assetId ? snap : null;
  const onError = useCallback(() => {
    if (!source || !snap) return;
    const now = Date.now();
    if (now - lastTry.current > RETRY_WINDOW_MS) {
      lastTry.current = now;
      void source.refresh();
    } else setBroken(snap.assetId);
  }, [source, snap]);
  const refresh = useCallback(async () => {
    setBroken(null);
    await source?.refresh();
  }, [source]);
  return {
    card,
    files: card ? (source?.files() ?? null) : null,
    drawing: card ? (card.urls[card.manifest.emotions.src.neutral!] ?? null) : null,
    thumb: card ? (signedThumb(card, 128) ?? null) : null,
    known: snap !== undefined,
    wearing: !!snap,
    onError,
    refresh,
  };
};
