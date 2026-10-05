import { setRequestLocale } from "next-intl/server";
import { LiveGate } from "@/components/LiveGate";
import { Mesas } from "@/components/Mesas";

/** /(en/)m: the person's Mesas and "Nueva Mesa". */
export default async function MesasPage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  return (
    <LiveGate>
      <Mesas />
    </LiveGate>
  );
}
