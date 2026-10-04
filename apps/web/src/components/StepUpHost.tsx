"use client";
import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

type Pending = { risk: string; resolve: (ok: boolean) => void } | null;
let pending: Pending = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/**
 * Asks the person to confirm a HIGH/CRITICAL approval with their device's step-up. Resolves
 * true on confirm (the caller then runs WebAuthn or the platform biometric), false on cancel.
 */
export const confirmStepUp = (risk: string): Promise<boolean> =>
  new Promise((resolve) => {
    pending?.resolve(false);
    pending = {
      risk,
      resolve: (ok) => {
        pending = null;
        emit();
        resolve(ok);
      },
    };
    emit();
  });

export const StepUpHost = () => {
  const t = useTranslations("live.stepUp");
  const p = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => pending,
    () => null,
  );
  if (!p) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="stepup-title"
      className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
    >
      <div className="grid max-w-sm gap-3 rounded-xl bg-white p-5 shadow-xl">
        <h2 id="stepup-title" className="text-lg font-semibold">
          {t("title")}
        </h2>
        <p>{t("body", { risk: p.risk })}</p>
        <div className="flex justify-end gap-2">
          <button className="rounded-lg border px-4 py-2" onClick={() => p.resolve(false)}>
            {t("cancel")}
          </button>
          <button className="rounded-lg bg-emerald-700 px-4 py-2 text-white" onClick={() => p.resolve(true)}>
            {t("confirm")}
          </button>
        </div>
      </div>
    </div>
  );
};
