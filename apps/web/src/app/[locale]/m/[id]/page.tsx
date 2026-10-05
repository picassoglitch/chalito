import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { LiveGate } from "@/components/LiveGate";
import { Mesa } from "@/components/Mesa";

const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** /(en/)m/{mid}: one Mesa (deep links from notifications land here). */
export default async function MesaPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  if (!ID.test(id)) notFound();
  return (
    <LiveGate>
      <Mesa mid={id} />
    </LiveGate>
  );
}
