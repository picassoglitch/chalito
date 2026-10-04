import { setRequestLocale } from "next-intl/server";
import { Onboarding } from "@/components/Onboarding";
import { agentOptions } from "@/lib/providers";

export default async function OnboardingPage({ params }: { params: Promise<{ locale: string }> }) {
  setRequestLocale((await params).locale);
  return <Onboarding agents={agentOptions()} />;
}
