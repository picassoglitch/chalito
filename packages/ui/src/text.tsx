import { createContext, useContext, type ReactNode } from "react";
import type { Locale } from "@chalito/protocol";

/**
 * Translation function for shared UI. The web app passes next-intl's `t`; the desktop
 * panel passes its own. Keys are relative to the `settings` namespace of messages/*.json.
 */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

const UiText = createContext<{ t: Translate; locale: Locale } | null>(null);

export const UiTextProvider = ({ t, locale, children }: { t: Translate; locale: Locale; children: ReactNode }) => (
  <UiText.Provider value={{ t, locale }}>{children}</UiText.Provider>
);

export const useUiText = (): { t: Translate; locale: Locale } => {
  const v = useContext(UiText);
  if (!v) throw new Error("useUiText needs a <UiTextProvider>");
  return v;
};
