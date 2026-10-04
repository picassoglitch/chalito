import { setRequestLocale } from "next-intl/server";
import { Credits } from "@/components/Credits";

export default async function CreditsPage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  return <Credits />;
}
