import type { MetadataRoute } from "next";

/** Installable PWA (brief M5: Lighthouse PWA installable). ES is the start URL; EN users land on /en via the nav. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Chalito",
    short_name: "Chalito",
    description: "Tu compañero que dirige a tu equipo de IA.",
    lang: "es",
    start_url: "/inicio",
    scope: "/",
    display: "standalone",
    background_color: "#fafafa",
    theme_color: "#047857",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
