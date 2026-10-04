import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import es from "@chalito/ui/messages/es.json";
import { DEFAULT_COMPANION } from "@chalito/ui";
import { UiBridge } from "@/components/UiBridge";
import { Onboarding, type AgentOption } from "@/components/Onboarding";

const push = vi.fn();
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push }),
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/components/ChalitoProvider", () => ({
  useChalito: () => ({
    status: "signed_out",
    client: null,
    deviceId: null,
    settings: null,
    phoneVerifier: {
      start: async () => ({ ok: true }),
      check: async (_e: string, code: string) =>
        code === "123456" ? { ok: true } : { ok: false, reason: "wrong_code" },
    },
  }),
}));
vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "signed_in", session: { user: { app_metadata: { chalito: { tier: "pro" } } } } }),
  sessionTier: () => "pro",
}));

const AGENTS: AgentOption[] = [
  { agent: "claude-code", provider: "anthropic", auth: ["api_key"], subscription: "off" },
  { agent: "codex", provider: "openai", auth: ["api_key", "chatgpt_plan"], subscription: "owner_only" },
  { agent: "grok-build", provider: "xai", auth: ["api_key", "grok_login"], subscription: "on" },
];

const renderWizard = () =>
  render(
    <NextIntlClientProvider locale="es" messages={es}>
      <UiBridge>
        <Onboarding agents={AGENTS} />
      </UiBridge>
    </NextIntlClientProvider>,
  );

afterEach(() => {
  cleanup();
  localStorage.clear();
  push.mockReset();
});

const step = () => document.querySelector("[data-step]")?.getAttribute("data-step");
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("onboarding", () => {
  it("runs all 7 steps; 'Saltar' on the companion step keeps the default companion", async () => {
    localStorage.setItem("chalito.settings.v1", JSON.stringify({ avatar: "luna" }));
    renderWizard();
    expect(await screen.findByTestId("signed-in")).toBeTruthy();
    click("Continuar");
    expect(step()).toBe("companion");
    click("Saltar");
    expect(step()).toBe("name");
    expect(JSON.parse(localStorage.getItem("chalito.settings.v1")!).avatar).toBe(DEFAULT_COMPANION);

    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Pepe" } });
    expect(screen.getByTestId("credit-line").textContent).toContain("impulsado por Chalito Bot");
    click("Continuar");

    expect(step()).toBe("connect");
    click("Tengo Claude");
    expect(screen.getByTestId("howto-claude-code").textContent).toMatch(/solo con tu API key/);
    click("Tengo ChatGPT");
    expect(screen.getByText(/solo equipo de Chalito/)).toBeTruthy();
    click("Continuar");

    expect(step()).toBe("billing");
    expect(screen.getByText("Tu nivel en Chalyb: pro")).toBeTruthy();
    click("Continuar");

    expect(step()).toBe("phone");
    fireEvent.change(screen.getByLabelText("Número"), { target: { value: "55 1234 5678" } });
    click("Enviar código");
    fireEvent.change(await screen.findByLabelText("Código"), { target: { value: "123456" } });
    click("Verificar");
    expect(await screen.findByTestId("phone-verified")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Entiendo que pueden aplicar cargos."));
    fireEvent.click(screen.getByRole("switch", { name: /Avisos por WhatsApp/ }));
    expect(screen.getAllByTestId("charges-notice")[0]!.textContent).toBe("Pueden aplicar cargos.");
    click("Continuar");

    expect(step()).toBe("pair");
    expect(screen.getByRole("link", { name: "Ir a Descargar" }).getAttribute("href")).toBe("/descargar");
    click("Terminar");
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/"));
    expect(localStorage.getItem("chalito.onboarded.v1")).toBe("true");
    const saved = JSON.parse(localStorage.getItem("chalito.settings.v1")!);
    expect(saved).toMatchObject({
      avatar: "chalito",
      phone: { e164: "+525512345678", verified: true },
      chargesAck: true,
      whatsapp: true,
    });
  });
});
