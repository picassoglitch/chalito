import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { LiveGate } from "@/components/LiveGate";
import { SessionDetail } from "@/components/Sessions";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export default async function SessionPage({ params }: { params: Promise<{ locale: string; sid: string }> }) {
  const { locale, sid } = await params;
  setRequestLocale(locale);
  if (!ID.test(sid)) notFound();
  return (
    <LiveGate>
      <SessionDetail sid={sid} />
    </LiveGate>
  );
}
