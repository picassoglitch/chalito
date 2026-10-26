"use client";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { hubLaunchUrl } from "@/lib/hub";
import { signInAndReturn } from "@/lib/next-cookie";
import { useChalito } from "./ChalitoProvider";

/** /vincular. ADR 0032 — signing in approves this browser; this page only shows how that went. */
export const EndorseWait = () => {
  const t = useTranslations("endorse.wait");
  const { status, newDevice, enrolError, session } = useChalito();

  if (status === "ready")
    return (
      <div className="grid gap-3" data-testid="endorse-done">
        <h1 className="text-2xl font-bold">{t("doneTitle")}</h1>
        <p>{t("doneBody")}</p>
        <Link href="/bandeja" className="w-fit rounded-lg bg-emerald-700 px-4 py-2 text-white">
          {t("doneCta")}
        </Link>
      </div>
    );
  if (status === "loading")
    return (
      <p aria-live="polite" data-testid="endorse-enrolling">
        {session.status === "signed_in" ? t("enrolling") : t("loading")}
      </p>
    );
  if (status === "unpaired" && enrolError && newDevice)
    return (
      <div className="grid gap-4" data-testid="endorse-failed">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p role="alert" data-testid="endorse-error" data-reason={enrolError} className="text-red-800">
          {t(`error.${enrolError}`)}
        </p>
        <button
          data-testid="endorse-retry"
          className="w-fit rounded-lg bg-emerald-700 px-4 py-2 text-white"
          onClick={() => void newDevice()}
        >
          {t("retry")}
        </button>
      </div>
    );
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
};
