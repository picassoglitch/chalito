"use client";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { hubLaunchUrl } from "@/lib/hub";
import { signInAndReturn } from "@/lib/next-cookie";
import { Link } from "@/i18n/navigation";
import { useChalito, useLive } from "./ChalitoProvider";

/** Live screens need a signed-in, paired, connected device; otherwise say what's missing. */
export const LiveGate = ({ children }: { children: ReactNode }) => {
  const t = useTranslations("live.gate");
  const { status, newDevice } = useChalito();
  const live = useLive();
  // Revoked: at sign-in (the api refused the device) or while connected (the live store saw it).
  // The provider has already forgotten the agents this browser trusted.
  if (status === "revoked" || (status === "ready" && live.status === "revoked"))
    return (
      <div role="alert" data-testid="gate-revoked" className="grid gap-3 rounded-lg bg-red-50 p-4 text-red-900">
        <p>{t("revoked")}</p>
        <Link href="/vincular" className="w-fit rounded-lg border border-red-800 px-4 py-2">
          {t("repair")}
        </Link>
      </div>
    );
  if (status === "ready") return <>{children}</>;
  if (status === "loading") return <p aria-live="polite">{t("loading")}</p>;
  return (
    <div className="grid gap-3 rounded-lg border p-4" data-testid={`gate-${status}`}>
      <p>{t(status)}</p>
      {status === "unpaired" && newDevice ? (
        <Link href="/vincular" data-testid="gate-link" className="w-fit rounded-lg bg-emerald-700 px-4 py-2 text-white">
          {t("link")}
        </Link>
      ) : null}
      {status === "signed_out" && hubLaunchUrl() ? (
        <a
          className="w-fit rounded-lg bg-emerald-700 px-4 py-2 text-white"
          href={hubLaunchUrl()!}
          onClick={(e) => {
            e.preventDefault();
            signInAndReturn(window.location.pathname + window.location.search);
          }}
        >
          {t("signIn")}
        </a>
      ) : null}
    </div>
  );
};
