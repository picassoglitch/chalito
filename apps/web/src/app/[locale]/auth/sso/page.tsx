import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { SsoLanding } from "@/components/SsoLanding";

// The launch token is in the URL: no referrer, no indexing.
export const metadata: Metadata = { referrer: "no-referrer", robots: { index: false, follow: false } };

export default async function SsoPage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  return <SsoLanding />;
}
