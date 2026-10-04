import { defineRouting } from "next-intl/routing";

/** ADR 0015 / D-018: ES is the bare `/`, EN lives under `/en`, and the locale comes from the URL only. */
export const routing = defineRouting({
  locales: ["es", "en"],
  defaultLocale: "es",
  localePrefix: "as-needed",
  localeDetection: false,
  pathnames: {
    "/": "/",
    "/bienvenida": { es: "/bienvenida", en: "/welcome" },
    "/ajustes": { es: "/ajustes", en: "/settings" },
    "/descargar": { es: "/descargar", en: "/download" },
    "/bandeja": { es: "/bandeja", en: "/inbox" },
    "/sesiones": { es: "/sesiones", en: "/sessions" },
    "/sesiones/[sid]": { es: "/sesiones/[sid]", en: "/sessions/[sid]" },
    "/dispositivos": { es: "/dispositivos", en: "/devices" },
    "/dispositivos/nuevo": { es: "/dispositivos/nuevo", en: "/devices/new" },
    "/vincular": { es: "/vincular", en: "/link" },
    "/conexiones": { es: "/conexiones", en: "/connections" },
    "/oauth/consent": "/oauth/consent",
    "/creditos": "/creditos",
    "/auth/sso": "/auth/sso",
    "/a/[id]": "/a/[id]",
    "/m/[id]": "/m/[id]",
    "/r/[id]": "/r/[id]",
    "/n/[nid]": "/n/[nid]",
  },
});

export type AppLocale = (typeof routing.locales)[number];
