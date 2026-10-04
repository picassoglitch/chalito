import { setRequestLocale } from "next-intl/server";
import { LiveGate } from "@/components/LiveGate";
import { Rooms } from "@/components/Rooms";

export default async function RoomsPage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  return (
    <LiveGate>
      <Rooms />
    </LiveGate>
  );
}
