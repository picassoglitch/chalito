"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { useChalito } from "./ChalitoProvider";

/**
 * "Protege tus aprobaciones con tu passkey": HIGH and CRITICAL approvals need this device's passkey
 * (the agent verifies the assertion, D-019). Shown after the first pairing and on /dispositivos.
 */
export const PasskeyEnroll = () => {
  const t = useTranslations("live.passkey");
  const { passkey } = useChalito();
  const [state, setState] = useState<"idle" | "busy" | "done" | "cancelled" | "replace_refused" | "error">("idle");
  if (!passkey.available) return <p className="text-sm text-neutral-600">{t("afterPairing")}</p>;
  if (passkey.enrolled)
    return (
      <div className="grid gap-2">
        <p data-testid="passkey-enrolled" className="text-emerald-800">
          {state === "done" ? t("replaced") : t("enrolled")}
        </p>
        {/* R-M11: changing it asks for the current passkey first. */}
        <button
          data-testid="passkey-replace"
          className="w-fit rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50"
          disabled={state === "busy"}
          onClick={() => {
            setState("busy");
            void passkey.enroll().then((r) => setState(r === "ok" ? "done" : r));
          }}
        >
          {t("replace")}
        </button>
        {state === "cancelled" || state === "replace_refused" || state === "error" ? (
          <p role="alert" data-testid="passkey-replace-error" className="text-sm text-red-800">
            {t(state === "replace_refused" ? "replaceRefused" : state)}
          </p>
        ) : null}
      </div>
    );
  return (
    <section
      id="passkey"
      data-testid="passkey-enroll"
      className="grid gap-2 rounded-xl border border-emerald-300 bg-emerald-50 p-4"
    >
      <h2 className="font-semibold">{t("title")}</h2>
      <p className="text-sm">{t("body")}</p>
      <button
        className="w-fit rounded-lg bg-emerald-700 px-4 py-2 text-white disabled:opacity-50"
        disabled={state === "busy"}
        onClick={() => {
          setState("busy");
          void passkey.enroll().then((r) => setState(r === "ok" ? "idle" : r === "replace_refused" ? "error" : r));
        }}
      >
        {t("create")}
      </button>
      {state === "cancelled" || state === "error" ? (
        <p role="alert" className="text-sm text-red-800">
          {t(state)}
        </p>
      ) : null}
    </section>
  );
};
