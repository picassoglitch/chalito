import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import es from "@chalito/ui/messages/es.json";
import { DEFAULT_SETTINGS, type SettingsValues } from "@chalito/ui";
import type { AvatarApi } from "@/lib/avatar";

/** Onboarding's companion step offers "Crea tu personaje con tu foto" next to the picker. */
const log: string[] = [];
const saved: SettingsValues[] = [];
const settings = {
  load: async () => ({ values: { ...DEFAULT_SETTINGS, avatar: "luna" }, onboarded: false }),
  save: async () => undefined,
  saveCompanion: async (v: SettingsValues) => {
    log.push(`saveCompanion:${v.avatar}`);
    saved.push(v);
  },
  markOnboarded: async () => undefined,
};
const avatar: AvatarApi = {
  quote: async () => ({ free: true, priceTokens: 217_750, dailyLeft: 5, active: null }),
  start: async (id, _t, attestation, opts) => {
    log.push(`start:${attestation.ageBand}:${opts?.useWhenReady === true}`);
    return {
      ok: true,
      creation: { creationId: id, status: "awaiting_upload", free: true, priceTokens: 0 },
      upload: { url: "https://storage.googleapis.com/b/u?sig", headers: {} },
    };
  },
  upload: async () => true,
  uploaded: async (id) => ({ creationId: id, status: "queued", free: true, priceTokens: 0 }),
  status: async (id) => ({ creationId: id, status: "generating", free: true, priceTokens: 0 }),
  use: async (id) => (log.push(`use:${id}`), "ok"),
  companion: async () => null,
  roomCards: async () => new Map(),
  kept: async () => [],
  remove: async () => "ok",
};

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/components/ChalitoProvider", () => ({
  useChalito: () => ({
    status: "ready",
    client: null,
    deviceId: null,
    settings,
    avatar,
    passkey: { available: false, enrolled: false, enroll: async () => "error" },
    phoneVerifier: { start: async () => ({ ok: true }), check: async () => ({ ok: true }) },
  }),
}));
vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "signed_in", session: { user: { app_metadata: { chalito: { tier: "pro" } } } } }),
  sessionTier: () => "pro",
}));
const { Onboarding } = await import("@/components/Onboarding");
const { UiBridge } = await import("@/components/UiBridge");

const renderWizard = () =>
  render(
    <NextIntlClientProvider locale="es" messages={es}>
      <UiBridge>
        <Onboarding agents={[]} />
      </UiBridge>
    </NextIntlClientProvider>,
  );
const step = () => document.querySelector("[data-step]")?.getAttribute("data-step");

describe("onboarding: create your character from your photo", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
    log.length = 0;
    saved.length = 0;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("is offered next to the companion picker; the companion is saved first, then the job runs while the wizard carries on", async () => {
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "Continuar" }));
    expect(step()).toBe("companion");
    expect(await screen.findByText("Crea tu personaje con tu foto (gratis la primera vez)")).toBeTruthy();

    fireEvent.change(screen.getByTestId("create-character-file"), {
      target: { files: [new File(["jpeg"], "me.jpg", { type: "image/jpeg" })] },
    });
    fireEvent.click(screen.getByTestId("create-character-own-photo"));
    fireEvent.click(screen.getByTestId("create-character-age-18_plus"));
    fireEvent.click(screen.getByTestId("create-character-go"));
    expect(await screen.findByTestId("create-character-carry-on")).toBeTruthy();
    // The companion exists (with the roster avatar picked so far) before the creation starts.
    expect(log.slice(0, 2)).toEqual(["saveCompanion:luna", "start:18_plus:true"]);

    // "Saltar" no longer resets the avatar (that would clear the card once it's on).
    fireEvent.click(screen.getByRole("button", { name: "Saltar" }));
    expect(step()).toBe("name");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(saved.every((v) => v.avatar === "luna")).toBe(true);
  });

  it("under 13 can't create from onboarding either", async () => {
    renderWizard();
    fireEvent.click(await screen.findByRole("button", { name: "Continuar" }));
    await screen.findByTestId("create-character");
    fireEvent.change(screen.getByTestId("create-character-file"), {
      target: { files: [new File(["jpeg"], "me.jpg", { type: "image/jpeg" })] },
    });
    fireEvent.click(screen.getByTestId("create-character-own-photo"));
    fireEvent.click(screen.getByTestId("create-character-age-under_13"));
    expect((screen.getByTestId("create-character-go") as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(screen.getByTestId("create-character-under13")).toBeTruthy());
    expect(log).toEqual([]);
  });
});
