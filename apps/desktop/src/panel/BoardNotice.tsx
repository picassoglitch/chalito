import { useState, useSyncExternalStore } from "react";
import { useT } from "../lib/i18n.js";
import type { BoardLink, PairResult } from "../lib/board/link.js";

type Link = Pick<BoardLink, "subscribe" | "getSnapshot" | "pair" | "forget">;

/** A plugged-in LCD board: why it can't be used, or the opt-in to pair it (BOARD_LINK pairing). */
export const BoardNotice = ({ link }: { link: Link }) => {
  const t = useT();
  const snap = useSyncExternalStore(link.subscribe, link.getSnapshot);
  const [result, setResult] = useState<PairResult | null>(null);
  const { status } = snap;
  if (status.state === "permission") return <p role="alert">{t("board.permission", { port: status.port })}</p>;
  if (status.state === "error")
    return <p role="alert">{t("board.error", { port: status.port, message: status.message })}</p>;
  if (snap.pairing) return <p role="status">{t("board.code", { code: snap.pairing.code })}</p>;
  if (status.state !== "connected" || !snap.hello || snap.paired) return null;
  return (
    <p role="status">
      {result && result !== "paired" ? `${t("board.notPaired")} ` : ""}
      {t("board.found")}{" "}
      <button
        onClick={() => {
          setResult(null);
          void link.pair().then(setResult);
        }}
      >
        {t("board.pair")}
      </button>
    </p>
  );
};

/** Settings: the paired board, and forgetting it. */
export const BoardSettings = ({ link }: { link: Link }) => {
  const t = useT();
  const snap = useSyncExternalStore(link.subscribe, link.getSnapshot);
  if (!snap.hasPairing) return null;
  return (
    <p>
      {t("board.paired")} <button onClick={() => void link.forget()}>{t("board.forget")}</button>
    </p>
  );
};
