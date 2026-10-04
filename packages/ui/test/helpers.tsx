import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Locale } from "@chalito/protocol";
import es from "../messages/es.json" with { type: "json" };
import en from "../messages/en.json" with { type: "json" };
import { UiTextProvider } from "../src/text.js";

const MESSAGES = { es, en } as const;

/** A tiny ICU-less translator over the settings namespace ({var} placeholders only). */
export const translator = (locale: Locale) => (key: string, values?: Record<string, string | number>) => {
  let node: unknown = MESSAGES[locale].settings;
  for (const part of key.split(".")) node = (node as Record<string, unknown> | undefined)?.[part];
  if (typeof node !== "string") throw new Error(`missing message settings.${key} (${locale})`);
  return node.replace(/\{(\w+)\}/g, (_, k: string) => String(values?.[k] ?? `{${k}}`));
};

export const renderUi = (ui: ReactNode, locale: Locale = "es") =>
  render(
    <UiTextProvider t={translator(locale)} locale={locale}>
      {ui}
    </UiTextProvider>,
  );
