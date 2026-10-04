import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { Nav } from "@/components/Nav";
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
    icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" },
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
  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>
          <UiBridge>
            <Nav />
            <main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
          </UiBridge>
        </NextIntlClientProvider>
        <ServiceWorker />
      </body>
    </html>
  );
}
