import { createContext, useContext, type ReactNode } from "react";
import type { Locale } from "@chalito/protocol";
import { UiTextProvider, type Translate } from "@chalito/ui";
import uiEs from "@chalito/ui/messages/es.json";
import uiEn from "@chalito/ui/messages/en.json";
import es from "../../messages/es.json";
import en from "../../messages/en.json";

const UI = { es: uiEs, en: uiEn } as const;
const DESKTOP = { es, en } as const;

/** `{var}` placeholders only, like the shared UI's test translator; a missing key shows itself. */
export const translator =
  (catalog: unknown): Translate =>
  (key, values) => {
    let node: unknown = catalog;
    for (const part of key.split(".")) node = (node as Record<string, unknown> | undefined)?.[part];
    if (typeof node !== "string") return key;
    return node.replace(/\{(\w+)\}/g, (_, k: string) => String(values?.[k] ?? `{${k}}`));
  };

export const detectLocale = (lang = typeof navigator === "undefined" ? "es" : navigator.language): Locale =>
  lang.toLowerCase().startsWith("en") ? "en" : "es";

const DesktopText = createContext<Translate | null>(null);

export const useT = (): Translate => {
  const t = useContext(DesktopText);
  if (!t) throw new Error("useT needs <TextProviders>");
  return t;
};

/** The shared UI's `settings` namespace plus the desktop's own strings. */
export const TextProviders = ({ locale, children }: { locale: Locale; children: ReactNode }) => (
  <UiTextProvider t={translator(UI[locale].settings)} locale={locale}>
    <DesktopText.Provider value={translator(DESKTOP[locale])}>{children}</DesktopText.Provider>
  </UiTextProvider>
);
