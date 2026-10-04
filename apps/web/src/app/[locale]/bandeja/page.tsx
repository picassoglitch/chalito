import { setRequestLocale } from "next-intl/server";
import { LiveGate } from "@/components/LiveGate";
import { Inbox } from "@/components/Approvals";

export default async function InboxPage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  return (
    <LiveGate>
      <Inbox />
    </LiveGate>
  );
}
