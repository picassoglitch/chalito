import { setRequestLocale } from "next-intl/server";
import { EndorseWait } from "@/components/EndorseWait";

export default async function LinkPage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  return <EndorseWait />;
}
