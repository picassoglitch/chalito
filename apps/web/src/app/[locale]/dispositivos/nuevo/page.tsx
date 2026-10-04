import { setRequestLocale } from "next-intl/server";
import { AddDevice } from "@/components/AddDevice";
import { LiveGate } from "@/components/LiveGate";

export default async function AddDevicePage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  return (
    <LiveGate>
      <AddDevice />
    </LiveGate>
  );
}
