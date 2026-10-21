import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import es from "@chalito/ui/messages/es.json";
import { Credits } from "@/components/Credits";

const tier = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/components/ChalitoProvider", () => ({
  useChalito: () => ({
    status: "signed_in",
    balance: null,
    settings: { load: async () => ({ values: { planCredits: { tier: tier.value, trialEndsAt: null } } }) },
  }),
}));

const shown = async (value: string | null) => {
  tier.value = value;
  render(
    <NextIntlClientProvider locale="es" messages={es}>
      <Credits />
    </NextIntlClientProvider>,
  );
  return (await screen.findByTestId("credits-tier")).textContent;
};

afterEach(cleanup);

describe("/creditos plan name", () => {
  it.each([
    ["free", "Tu plan: Chalyb Gratis"],
    ["pro", "Tu plan: Chalyb Pro"],
    ["vip", "Tu plan: Chalyb VIP"],
  ])("names the tier the hub stores (%s)", async (value, text) => {
    expect(await shown(value)).toBe(text);
  });

  it.each([
    ["PRO", "Tu plan: Chalyb Pro"],
    [" Vip ", "Tu plan: Chalyb VIP"],
    ["FREE", "Tu plan: Chalyb Gratis"],
  ])("reads users.tier %j case-insensitively, like the api's limits and the notifier's caps", async (value, text) => {
    expect(await shown(value)).toBe(text);
  });

  it.each([null, "gold", "  "])("still says it can't see the plan for %j", async (value) => {
    expect(await shown(value)).toBe("No pudimos ver tu plan.");
  });
});
