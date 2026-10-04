"use client";
import { useCallback, useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { timeLeft, type DeletionStatus } from "@/lib/account";
import { Link } from "@/i18n/navigation";
import { useChalito, useNow } from "./ChalitoProvider";

type Note =
  | "cancelled_step_up"
  | "passkey_required"
  | "step_up_failed"
  | "already_scheduled"
  | "failed"
  | "cancelled"
  | "export_failed";

/**
 * Ajustes → Privacidad: delete my Chalito account. Asking needs this paired device and its passkey;
 * the api writes an export first and deletes after 7 days, cancellable until then. Only Chalito's
 * data goes; the Chalyb account stays.
 */
export const AccountDeletion = () => {
  const t = useTranslations("live.account");
  const format = useFormatter();
  const { account, status: conn, passkey, assertPasskey } = useChalito();
  const now = useNow(60_000);
  const [state, setState] = useState<DeletionStatus | "loading" | "error">("loading");
  const [confirming, setConfirming] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const load = useCallback(async () => {
    if (!account) return;
    setState(await account.status());
  }, [account]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!account || state === "loading") return null;

  const request = async () => {
    if (!assertPasskey) return;
    setBusy(true);
    setNote(null);
    let stepUp: unknown;
    try {
      stepUp = await assertPasskey();
    } catch {
      setBusy(false);
      return setNote("cancelled_step_up");
    }
    const r = await account.request(stepUp);
    setBusy(false);
    if (!r.ok) return setNote(r.reason);
    setConfirming(false);
    setAck(false);
    await load();
  };

  const cancel = async () => {
    setBusy(true);
    setNote(null);
    const r = await account.cancel();
    setBusy(false);
    if (r === "failed") return setNote("failed");
    setNote("cancelled");
    await load();
  };

  const download = async () => {
    setNote(null);
    const blob = await account.export();
    if (blob === "none" || blob === "failed") return setNote("export_failed");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "chalito-export.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const scheduled = state !== "error" && state.status === "scheduled" ? state : null;
  const hasExport = state !== "error" && state.status !== "none";
  const left = scheduled ? timeLeft(scheduled.dueAt, now) : null;

  return (
    <section
      data-testid="account-deletion"
      data-state={state === "error" ? "error" : state.status}
      className="grid gap-3 rounded-lg border border-red-200 p-4"
    >
      <h2 className="font-semibold">{t("title")}</h2>
      {state === "error" ? <p role="alert">{t("loadFailed")}</p> : null}
      {scheduled && left ? (
        <div className="grid gap-2 rounded-md bg-red-50 p-3 text-red-900">
          <p data-testid="deletion-due">
            {t("scheduled", { date: format.dateTime(scheduled.dueAt, { dateStyle: "long", timeStyle: "short" }) })}
          </p>
          <p data-testid="deletion-countdown">{t("countdown", { days: left.days, hours: left.hours })}</p>
          <button
            className="w-fit rounded-lg bg-white px-4 py-2 text-red-900 ring-1 ring-red-800 disabled:opacity-50"
            disabled={busy}
            onClick={() => void cancel()}
          >
            {t("cancel")}
          </button>
        </div>
      ) : state !== "error" ? (
        <>
          <p className="text-sm text-neutral-700">{t("explain")}</p>
          {!confirming ? (
            <button
              className="w-fit rounded-lg border border-red-800 px-4 py-2 text-red-900"
              onClick={() => setConfirming(true)}
            >
              {t("start")}
            </button>
          ) : conn !== "ready" ? (
            <p role="note">{t("needsPairing")}</p>
          ) : !passkey.enrolled ? (
            <p role="note">
              {t("needsPasskey")}{" "}
              <Link href="/dispositivos" className="text-emerald-700 underline">
                {t("setUpPasskey")}
              </Link>
            </p>
          ) : (
            <div className="grid gap-2 rounded-md bg-red-50 p-3 text-red-900">
              <ul className="list-disc pl-5 text-sm">
                <li>{t("what.data")}</li>
                <li>{t("what.grace")}</li>
                <li>{t("what.export")}</li>
                <li>{t("what.hub")}</li>
              </ul>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                {t("ack")}
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded-lg bg-red-800 px-4 py-2 text-white disabled:opacity-50"
                  disabled={!ack || busy}
                  onClick={() => void request()}
                >
                  {t("confirm")}
                </button>
                <button className="rounded-lg border px-4 py-2" onClick={() => setConfirming(false)}>
                  {t("back")}
                </button>
              </div>
            </div>
          )}
        </>
      ) : null}
      {hasExport ? (
        <button className="w-fit text-emerald-700 underline" onClick={() => void download()}>
          {t("download")}
        </button>
      ) : null}
      {note ? (
        <p role={note === "cancelled" ? "status" : "alert"} data-testid="account-note">
          {t(`note.${note}`)}
        </p>
      ) : null}
    </section>
  );
};
