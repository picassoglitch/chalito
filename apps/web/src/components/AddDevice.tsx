"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import type { EndorseTarget } from "@chalito/client-keys";
import { Link } from "@/i18n/navigation";
import type { AddError } from "@/lib/endorse";
import { useChalito, useNow } from "./ChalitoProvider";
import { GlyphScanner } from "./Glyph";

type Step =
  | { s: "input" }
  | { s: "scanning" }
  | { s: "busy" }
  | { s: "confirm"; target: EndorseTarget; at: number }
  | { s: "approving"; target: EndorseTarget; at: number }
  | { s: "done"; name: string };

/**
 * "Añadir un dispositivo" (/dispositivos/nuevo): this trusted browser vouches for a new one. The
 * person types the short code (or scans the ring), compares the fingerprint shown on both screens,
 * and approves; with a passkey on this device, the approval asks for it.
 */
export const AddDevice = () => {
  const t = useTranslations("endorse.add");
  const { addDevice, passkey } = useChalito();
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>({ s: "input" });
  const [error, setError] = useState<AddError | null>(null);
  const now = useNow();

  if (!addDevice) return null;

  const resolve = async (input: { glyph: unknown } | { shortCode: string }) => {
    setError(null);
    setStep({ s: "busy" });
    const r = await addDevice.resolve(input);
    if (!r.ok) {
      setError(r.reason);
      return setStep({ s: "input" });
    }
    setStep({ s: "confirm", target: r.target, at: Date.now() });
  };

  const approve = async (target: EndorseTarget, at: number) => {
    setError(null);
    setStep({ s: "approving", target, at });
    const r = await addDevice.approve(target);
    if (!r.ok) {
      setError(r.reason);
      // A refused step-up can be retried on the same code; anything else starts over.
      return setStep(r.reason === "step_up" ? { s: "confirm", target, at } : { s: "input" });
    }
    setStep({ s: "done", name: target.display.name });
  };

  const errorLine = error ? (
    <p role="alert" data-testid="add-error" data-reason={error} className="text-red-800">
      {t(`error.${error}`)}
    </p>
  ) : null;

  if (step.s === "done")
    return (
      <div className="grid gap-3" data-testid="add-done">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p role="status">{t("done", { name: step.name })}</p>
        <Link href="/dispositivos" className="w-fit rounded-lg border px-4 py-2">
          {t("back")}
        </Link>
      </div>
    );

  if (step.s === "confirm" || step.s === "approving") {
    const d = step.target.display;
    const left = Math.max(0, Math.ceil((d.expiresInMs - (now - step.at)) / 1000));
    return (
      <div className="grid gap-4" data-testid="add-confirm">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <div className="grid gap-2 rounded-xl border bg-white p-4">
          <p className="font-medium" data-testid="add-name">
            {d.name}
          </p>
          <p className="text-sm text-neutral-600">{t(`kind.${d.kind === "phone" ? "phone" : "web"}`)}</p>
          <p className="text-sm">{t("compare")}</p>
          <p data-testid="add-fingerprint" className="font-mono text-xl font-bold tracking-wide">
            {d.fingerprint}
          </p>
          <p className="text-sm text-neutral-600">
            {t("expiresIn", { minutes: Math.floor(left / 60), seconds: String(left % 60).padStart(2, "0") })}
          </p>
        </div>
        <p className="text-sm">{passkey.enrolled ? t("withPasskey") : t("withoutPasskey")}</p>
        <div className="flex flex-wrap gap-2">
          <button
            data-testid="add-approve"
            className="rounded-lg bg-emerald-700 px-4 py-2 text-white disabled:opacity-50"
            disabled={step.s === "approving" || left === 0}
            onClick={() => void approve(step.target, step.at)}
          >
            {t("approve")}
          </button>
          <button
            className="rounded-lg border px-4 py-2"
            disabled={step.s === "approving"}
            onClick={() => {
              setError(null);
              setStep({ s: "input" });
            }}
          >
            {t("notMine")}
          </button>
        </div>
        {errorLine}
      </div>
    );
  }

  return (
    <div className="grid gap-4" data-testid="add-input">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p>{t("body")}</p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void resolve({ shortCode: code });
        }}
      >
        <label className="grid gap-1">
          <span className="text-sm font-medium">{t("codeLabel")}</span>
          <input
            data-testid="add-code"
            className="rounded-lg border px-3 py-2 font-mono uppercase tracking-widest"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={12}
            placeholder="XXXX-XXXX"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <button
          data-testid="add-find"
          className="rounded-lg bg-emerald-700 px-4 py-2 text-white disabled:opacity-50"
          disabled={step.s === "busy" || code.trim().length < 8}
        >
          {t("find")}
        </button>
      </form>
      {step.s === "scanning" ? (
        <GlyphScanner
          onPayload={(glyph) => void resolve({ glyph })}
          labels={{
            starting: t("scan.starting"),
            scanning: t("scan.scanning"),
            denied: t("scan.denied"),
            unavailable: t("scan.unavailable"),
          }}
        />
      ) : (
        <button
          data-testid="add-scan"
          className="w-fit rounded-lg border px-4 py-2"
          disabled={step.s === "busy"}
          onClick={() => setStep({ s: "scanning" })}
        >
          {t("scan.start")}
        </button>
      )}
      {errorLine}
    </div>
  );
};
