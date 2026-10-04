import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { OAuthConsent } from "@/components/OAuthConsent";

export const metadata: Metadata = { referrer: "no-referrer", robots: { index: false, follow: false } };

/** /(en/)oauth/consent?request=<id>: the MCP authorization server parks requests here (M10). */
export default async function ConsentPage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  return <OAuthConsent />;
}
