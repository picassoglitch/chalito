import { setRequestLocale } from "next-intl/server";
import { LiveGate } from "@/components/LiveGate";
import { Usage } from "@/components/Usage";

export default async function UsagePage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  return (
    <LiveGate>
      <Usage />
    </LiveGate>
  );
}
