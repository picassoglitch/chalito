"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useChalito } from "./ChalitoProvider";

/**
 * "Compartir tarjeta con apps conectadas" for one session or device. Off by default; turning it on
 * stores the card in plaintext for the connected apps, so it shows that warning and needs an ack.
 */
export const SharingToggle = ({ scope, target }: { scope: "session" | "device"; target: string }) => {
  const t = useTranslations("mcp.sharing");
  const { mcp, readSharing } = useChalito();
  const [on, setOn] = useState(false);
  const [asking, setAsking] = useState(false);
  const [ack, setAck] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    void readSharing?.(scope, target)
      .then(setOn)
      .catch(() => undefined);
  }, [readSharing, scope, target]);
  if (!mcp) return null;
  const send = async (enabled: boolean) => {
    setFailed(false);
    const r = await mcp.setSharing({
      ...(scope === "session" ? { sessionId: target } : { deviceId: target }),
      enabled,
      ...(enabled ? { plaintextAck: true } : {}),
    });
    if (r === true) {
      setOn(enabled);
      setAsking(false);
      setAck(false);
    } else setFailed(true);
  };
  return (
    <div data-testid={`sharing-${scope}`} className="grid gap-2 rounded-lg border p-3 text-sm">
      <label className="flex items-center justify-between gap-3">
        <span className="font-medium">{t("label")}</span>
        <input
          type="checkbox"
          role="switch"
          checked={on || asking}
          onChange={(e) => (e.target.checked ? setAsking(true) : on ? void send(false) : setAsking(false))}
        />
      </label>
      {asking && !on ? (
        <div className="grid gap-2 rounded-md bg-amber-50 p-2 text-amber-900">
          <p role="note">{t("warning")}</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            {t("ack")}
          </label>
          <div className="flex gap-2">
            <button
              className="rounded bg-amber-700 px-2 py-1 text-white disabled:opacity-50"
              disabled={!ack}
              onClick={() => void send(true)}
            >
              {t("confirm")}
            </button>
            <button className="rounded border px-2 py-1" onClick={() => setAsking(false)}>
              {t("cancel")}
            </button>
          </div>
        </div>
      ) : null}
      {failed ? <p role="alert">{t("failed")}</p> : null}
    </div>
  );
};
