import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { ChalitoProvider } from "@/components/ChalitoProvider";
import { DevModeBanner } from "@/components/DevModeBanner";
import { Nav } from "@/components/Nav";
import { StepUpHost } from "@/components/StepUpHost";
import { TestModeBanner } from "@/components/TestModeBanner";
import { ServiceWorker } from "@/components/ServiceWorker";
import { UiBridge } from "@/components/UiBridge";
import "../globals.css";

export const generateStaticParams = () => routing.locales.map((locale) => ({ locale }));

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "pwa" });
  return {
    title: "Chalito",
    description: t("description"),
    manifest: "/manifest.webmanifest",
    icons: {
      icon: [
        { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
        { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      ],
      apple: { url: "/icons/apple-touch-icon.png", sizes: "180x180" },
    },
    appleWebApp: { capable: true, title: "Chalito", statusBarStyle: "default" },
  };
}

export const viewport: Viewport = { themeColor: "#047857", width: "device-width", initialScale: 1 };

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  // Per-request CSP nonce (src/proxy.ts): reading the request makes every page render dynamically,
  // which is what lets Next stamp the nonce on its scripts.
  await headers();
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>
          <UiBridge>
            <ChalitoProvider>
              <TestModeBanner />
              <DevModeBanner />
              <Nav />
              <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
              <StepUpHost />
            </ChalitoProvider>
          </UiBridge>
        </NextIntlClientProvider>
        <ServiceWorker />
      </body>
    </html>
  );
}
