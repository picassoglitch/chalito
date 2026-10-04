import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

// Every string lives in packages/ui/messages (the brand lint scans them), except /descargar's,
// which ship with its component in @chalito/releases and are merged in as `download`.
const MESSAGES = {
  es: async () => ({
    ...(await import("@chalito/ui/messages/es.json")).default,
    download: (await import("@chalito/releases/messages/es.json")).default,
  }),
  en: async () => ({
    ...(await import("@chalito/ui/messages/en.json")).default,
    download: (await import("@chalito/releases/messages/en.json")).default,
  }),
};

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  return { locale, messages: await MESSAGES[locale]() };
});
