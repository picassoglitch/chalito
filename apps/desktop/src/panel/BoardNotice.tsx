import { useState, useSyncExternalStore } from "react";
import { useT } from "../lib/i18n.js";
import type { ApprovalProblem, BoardLink, ForgetResult, PairResult } from "../lib/board/link.js";

type Link = Pick<BoardLink, "subscribe" | "getSnapshot" | "pair" | "forget">;

const APPROVAL_TEXT: Record<ApprovalProblem, string> = {
  send_failed: "board.approval.sendFailed",
  phone_required: "board.approval.phoneRequired",
  write_failed: "board.approval.writeFailed",
};

/** A plugged-in LCD board: why it can't be used, what went wrong with it, or the opt-in to pair it
 * (BOARD_LINK pairing). */
export const BoardNotice = ({ link }: { link: Link }) => {
  const t = useT();
  const snap = useSyncExternalStore(link.subscribe, link.getSnapshot);
  const [result, setResult] = useState<PairResult | null>(null);
  // Mac failures already answered by pairing again.
  const [rejectedSeen, setRejectedSeen] = useState(0);
  const { status } = snap;
  const pair = () => {
    setResult(null);
    link.pair().then(
      (r) => {
        setResult(r);
        if (r === "paired") setRejectedSeen(link.getSnapshot().rejected);
      },
      (e: unknown) => {
        console.error("board: pairing failed", e);
        setResult("failed");
      },
    );
  };
  if (status.state === "permission") return <p role="alert">{t("board.permission", { port: status.port })}</p>;
  if (status.state === "error")
    return <p role="alert">{t("board.error", { port: status.port, message: status.message })}</p>;
  if (snap.pairing && status.state === "connected")
    return <p role="status">{t("board.code", { code: snap.pairing.code, port: status.port })}</p>;
  const found = status.state === "connected" && !!snap.hello;
  const notes: string[] = [];
  if (snap.pairingError) notes.push(t("board.pairingError", { message: snap.pairingError }));
  if (found && snap.paired && snap.cardError) notes.push(t("board.cardFailed", { reason: snap.cardError }));
  if (found && snap.paired && snap.approvalProblem) notes.push(t(APPROVAL_TEXT[snap.approvalProblem]));
  const rejected = snap.rejected > rejectedSeen;
  const offer = found && !snap.paired;
  if (!notes.length && !rejected && !offer) return null;
  const failed =
    result === "save-failed" ? t("board.saveFailed") : result && result !== "paired" ? t("board.notPaired") : "";
  return (
    <>
      {notes.map((n) => (
        <p role="alert" key={n}>
          {n}
        </p>
      ))}
      {rejected && !offer && (
        <p role="alert">
          {t("board.rejected")} <button onClick={pair}>{t("board.pair")}</button>
        </p>
      )}
      {offer && (
        <p role="status">
          {failed ? `${failed} ` : ""}
          {t("board.found")} <button onClick={pair}>{t("board.pair")}</button>
        </p>
      )}
    </>
  );
};

/** Settings: the paired board, and forgetting it. */
export const BoardSettings = ({ link }: { link: Link }) => {
  const t = useT();
  const snap = useSyncExternalStore(link.subscribe, link.getSnapshot);
  const [forgot, setForgot] = useState<ForgetResult | null>(null);
  const note =
    forgot === "board-unconfirmed"
      ? t("board.forgetUnconfirmed")
      : forgot === "failed"
        ? t("board.forgetFailed")
        : null;
  if (!snap.hasPairing && !note) return null;
  const forget = () => {
    setForgot(null);
    link.forget().then(setForgot, (e: unknown) => {
      console.error("board: forgetting the board failed", e);
      setForgot("failed");
    });
  };
  return (
    <>
      {snap.hasPairing && (
        <p>
          {t("board.paired")} <button onClick={forget}>{t("board.forget")}</button>
        </p>
      )}
      {note && <p role="alert">{note}</p>}
    </>
  );
};
