"use client";
import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { GlyphPayload } from "@chalito/protocol";
import { Link } from "@/i18n/navigation";
import { browserName, type WaitError, type Waiting } from "@/lib/endorse";
import { hubLaunchUrl } from "@/lib/hub";
import { signInAndReturn } from "@/lib/next-cookie";
import { useChalito, useNow } from "./ChalitoProvider";
import { GlyphCanvas } from "./Glyph";

type Step =
  { s: "name" } | { s: "opening" } | { s: "waiting"; w: Waiting } | { s: "done" } | { s: "failed"; reason: WaitError };

/**
 * "Esperando aprobación" (/vincular): a new browser, signed in as the person, asks a trusted
 * device to vouch for its keys. It shows a short code and the glyph it signed; once a trusted
 * device approves, it enrols and signs in as itself.
 */
export const EndorseWait = () => {
  const t = useTranslations("endorse.wait");
  const locale = useLocale();
  const { status, newDevice } = useChalito();
  const [name, setName] = useState("");
  const [step, setStep] = useState<Step>({ s: "name" });
  const current = useRef<Waiting | null>(null);
  const now = useNow();

  useEffect(() => setName((n) => n || browserName(navigator.userAgent, locale)), [locale]);
  // Leaving the page cancels the code (the api lets it expire anyway).
  useEffect(() => () => current.current?.cancel(), []);

  const start = async () => {
    if (!newDevice) return;
    setStep({ s: "opening" });
    const w = await newDevice(name.trim() || browserName(navigator.userAgent, locale));
    if ("error" in w) return setStep({ s: "failed", reason: w.error });
    current.current = w;
    setStep({ s: "waiting", w });
    const r = await w.result;
    current.current = null;
    if (!r.ok) return setStep(r.reason === "cancelled" ? { s: "name" } : { s: "failed", reason: r.reason });
    setStep({ s: "done" });
  };

  if (step.s === "done" || status === "ready")
    return (
      <div className="grid gap-3" data-testid="endorse-done">
        <h1 className="text-2xl font-bold">{t("doneTitle")}</h1>
        <p>{t("doneBody")}</p>
        <Link href="/bandeja" className="w-fit rounded-lg bg-emerald-700 px-4 py-2 text-white">
          {t("doneCta")}
        </Link>
      </div>
    );
  if (status === "loading") return <p aria-live="polite">{t("loading")}</p>;
  if (status === "signed_out" || ((status === "unpaired" || status === "revoked") && !newDevice))
    return (
      <div className="grid gap-3" data-testid="endorse-signin">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p>{t("signInFirst")}</p>
        {hubLaunchUrl() ? (
          <a
            className="w-fit rounded-lg bg-emerald-700 px-4 py-2 text-white"
            href={hubLaunchUrl()!}
            onClick={(e) => {
              e.preventDefault();
              signInAndReturn(window.location.pathname);
            }}
          >
            {t("signIn")}
          </a>
        ) : null}
      </div>
    );
  if (!newDevice)
    return (
      <p role="alert" data-testid="endorse-unavailable">
        {t("unavailable")}
      </p>
    );

  if (step.s === "waiting") {
    const { display, fingerprint } = step.w;
    const left = Math.max(0, Math.ceil((display.expiresAt - now) / 1000));
    return (
      <div className="grid gap-4" data-testid="endorse-waiting">
        <h1 className="text-2xl font-bold">{t("waitingTitle")}</h1>
        <p>{t("waitingBody")}</p>
        <div className="grid justify-items-center gap-3 rounded-xl border bg-white p-4">
          {display.glyph ? <GlyphCanvas glyph={display.glyph as GlyphPayload} label={t("glyphLabel")} /> : null}
          <p className="text-sm text-neutral-600">{t("orType")}</p>
          <p data-testid="endorse-code" className="font-mono text-3xl font-bold tracking-widest">
            {display.shortCode}
          </p>
          <p className="text-sm">
            {t("fingerprint")}{" "}
            <span data-testid="endorse-own-fingerprint" className="font-mono">
              {fingerprint}
            </span>
          </p>
          <p aria-live="off" className="text-sm text-neutral-600">
            {t("expiresIn", { minutes: Math.floor(left / 60), seconds: String(left % 60).padStart(2, "0") })}
          </p>
        </div>
        <p className="text-sm text-neutral-600">{t("whereToApprove")}</p>
        <button className="w-fit rounded-lg border px-4 py-2" onClick={() => step.w.cancel()}>
          {t("cancel")}
        </button>
      </div>
    );
  }

  return (
    <div className="grid gap-4" data-testid="endorse-start">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p>{t("body")}</p>
      <label className="grid gap-1">
        <span className="text-sm font-medium">{t("nameLabel")}</span>
        <input
          data-testid="endorse-name"
          className="rounded-lg border px-3 py-2"
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <button
        data-testid="endorse-start-button"
        className="w-fit rounded-lg bg-emerald-700 px-4 py-2 text-white disabled:opacity-50"
        disabled={step.s === "opening"}
        onClick={() => void start()}
      >
        {t("start")}
      </button>
      {step.s === "failed" ? (
        <p role="alert" data-testid="endorse-error" data-reason={step.reason} className="text-red-800">
          {t(`error.${step.reason}`)}
        </p>
      ) : null}
    </div>
  );
};
