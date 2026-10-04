"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { env } from "@/lib/env";
import { pushState, type PushState } from "@/lib/push";
import { useChalito } from "./ChalitoProvider";

/**
 * Ajustes → Notificaciones: Web Push on THIS browser. Per device, so it isn't a synced setting
 * (packages/ui's registry); it needs this browser paired, since the subscription row is its own.
 */
export const PushOptIn = () => {
  const t = useTranslations("live.push");
  const { status, push } = useChalito();
  const [state, setState] = useState<PushState | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void pushState(env.vapidPublicKey).then((s) => alive && setState(s));
    return () => {
      alive = false;
    };
  }, []);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setFailed(false);
    const r = await fn();
    setBusy(false);
    if (r === "failed") setFailed(true);
    else setState(r as PushState);
  };

  return (
    <section data-testid="push-optin" data-state={state} className="grid gap-2 rounded-lg border p-4">
      <h2 className="font-semibold">{t("title")}</h2>
      <p className="text-sm text-neutral-600">{t("hint")}</p>
      {state === "loading" ? null : state === "unsupported" ? (
        <p role="note">{t("unsupported")}</p>
      ) : state === "denied" ? (
        <p role="note">{t("denied")}</p>
      ) : !push ? (
        <p role="note">{status === "loading" ? t("loading") : t("needsPairing")}</p>
      ) : state === "on" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p data-testid="push-on">{t("on")}</p>
          <button className="rounded border px-3 py-1" disabled={busy} onClick={() => void run(push.disable)}>
            {t("disable")}
          </button>
        </div>
      ) : (
        <button
          className="w-fit rounded-lg bg-emerald-700 px-4 py-2 text-white disabled:opacity-50"
          disabled={busy}
          onClick={() => void run(push.enable)}
        >
          {t("enable")}
        </button>
      )}
      {failed ? <p role="alert">{t("failed")}</p> : null}
    </section>
  );
};
