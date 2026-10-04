"use client";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { hubLaunchUrl } from "@/lib/hub";
import { signInAndReturn } from "@/lib/next-cookie";
import { useChalito, useLive } from "./ChalitoProvider";

/** Live screens need a signed-in, paired, connected device; otherwise say what's missing. */
export const LiveGate = ({ children }: { children: ReactNode }) => {
  const t = useTranslations("live.gate");
  const { status } = useChalito();
  const live = useLive();
  if (status === "ready" && live.status === "revoked")
    return (
      <p role="alert" className="rounded-lg bg-red-50 p-4 text-red-900">
        {t("revoked")}
      </p>
    );
  if (status === "ready") return <>{children}</>;
  if (status === "loading") return <p aria-live="polite">{t("loading")}</p>;
  return (
    <div className="grid gap-3 rounded-lg border p-4" data-testid={`gate-${status}`}>
      <p>{t(status)}</p>
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
