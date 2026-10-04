"use client";
import { SettingsPanel } from "@chalito/ui";
import { env } from "@/lib/env";
import { useChalito } from "./ChalitoProvider";
import { useLocale, useTranslations } from "next-intl";
import { Link, getPathname } from "@/i18n/navigation";
import { useSettings } from "./useSettings";
import { PushOptIn } from "./PushOptIn";
import { AccountDeletion } from "./AccountDeletion";

export const Settings = () => {
  const t = useTranslations("settings");
  const tw = useTranslations("live.settings");
  const ti = useTranslations("integrations");
  const { phoneVerifier } = useChalito();
  const { values, set, error, persisted } = useSettings();
  const locale = useLocale();
  if (!values) return null;
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <p data-testid="persisted" data-where={persisted} className="text-sm text-neutral-600">
        {tw(persisted)}
      </p>
      {error ? (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-900">
          {tw(`error.${error}`)}
        </p>
      ) : null}
      <PushOptIn />
      <Link href="/conexiones" className="w-fit text-emerald-700 underline">
        {tw("connectedApps")}
      </Link>
      <SettingsPanel
        shell="web"
        values={values}
        onChange={set}
        providerLabel={(p) => ti(`${p}.name`)}
        hubPlansUrl={env.hubUrl || "#"}
        usageHref={getPathname({ href: "/uso", locale })}
        phoneVerifier={phoneVerifier}
      />
      <AccountDeletion />
    </div>
  );
};
