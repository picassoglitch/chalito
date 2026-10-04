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
  const [state, setState] = useState<"idle" | "busy" | "cancelled" | "error">("idle");
  if (!passkey.available) return <p className="text-sm text-neutral-600">{t("afterPairing")}</p>;
  if (passkey.enrolled)
    return (
      <p data-testid="passkey-enrolled" className="text-emerald-800">
        {t("enrolled")}
      </p>
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
          void passkey.enroll().then((r) => setState(r === "ok" ? "idle" : r));
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
