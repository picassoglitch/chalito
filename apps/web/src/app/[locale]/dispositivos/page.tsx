import { setRequestLocale } from "next-intl/server";
import { LiveGate } from "@/components/LiveGate";
import { Devices } from "@/components/Devices";

export default async function DevicesPage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  return (
    <LiveGate>
      <Devices />
    </LiveGate>
  );
}
