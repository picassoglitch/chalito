import { setRequestLocale } from "next-intl/server";
import { LiveGate } from "@/components/LiveGate";
import { SessionsList } from "@/components/Sessions";

export default async function SessionsPage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  return (
    <LiveGate>
      <SessionsList />
    </LiveGate>
  );
}
