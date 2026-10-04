import { setRequestLocale } from "next-intl/server";
import { Landing } from "@/components/landing/Landing";

/** The public landing. The signed-in app's home is /inicio. */
export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  return <Landing />;
}
