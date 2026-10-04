"use client";
import { useLocale, useTranslations } from "next-intl";
import { PRODUCT_NAME, formatCompanionTitle } from "@chalito/brand";
import { Link } from "@/i18n/navigation";
import { hubLaunchUrl } from "@/lib/hub";
import { useSettings } from "./useSettings";
import { useSession } from "@/lib/session";
import type { AppLocale } from "@/i18n/routing";

export const Home = () => {
  const t = useTranslations("home");
  const ts = useTranslations("settings");
  const locale = useLocale() as AppLocale;
  const session = useSession();
  const { values: settings } = useSettings();
  const title = settings
    ? formatCompanionTitle(settings.companionName.name, settings.companionName.isRenamed, locale)
    : null;
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-bold">{t("title", { name: title?.title ?? PRODUCT_NAME })}</h1>
      {title?.credit ? <p className="text-sm text-neutral-600">{title.credit}</p> : null}
      <p>{t("subtitle")}</p>
      {settings ? (
        <p data-testid="home-companion">{t("companion", { name: ts(`companions.${settings.avatar}`) })}</p>
      ) : null}
      {session.status === "signed_out" ? (
        <div className="grid gap-2">
          <p>{t("signedOut")}</p>
          {hubLaunchUrl() ? (
            <a className="w-fit rounded-lg bg-emerald-700 px-4 py-2 text-white" href={hubLaunchUrl()!}>
              {t("signIn")}
            </a>
          ) : null}
        </div>
      ) : null}
      <Link href="/bienvenida" className="w-fit rounded-lg border px-4 py-2">
        {t("startOnboarding")}
      </Link>
    </div>
  );
};
