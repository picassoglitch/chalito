"use client";
import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { UiTextProvider } from "@chalito/ui";
import type { AppLocale } from "@/i18n/routing";

/** Hands next-intl's `settings` translator to the shared UI package (which has no next-intl dependency). */
export const UiBridge = ({ children }: { children: ReactNode }) => {
  const t = useTranslations("settings");
  const locale = useLocale() as AppLocale;
  return (
    <UiTextProvider t={(key, values) => t(key, values)} locale={locale}>
      {children}
    </UiTextProvider>
  );
};
