import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

// Every string lives in packages/ui/messages (the brand lint scans them).
const MESSAGES = {
  es: () => import("@chalito/ui/messages/es.json"),
  en: () => import("@chalito/ui/messages/en.json"),
};

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  return { locale, messages: (await MESSAGES[locale]()).default };
});
