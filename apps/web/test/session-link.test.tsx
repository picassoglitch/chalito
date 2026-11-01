import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionDetail } from "../src/components/Sessions";

const state = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key, useLocale: () => "en" }));
vi.mock("../src/components/ChalitoProvider", () => ({
  useChalito: () => ({ client: { actions: { prompt: state.prompt } } }),
  useLive: () => ({
    status: "live",
    sessions: [{ sid: "session-123", card: null, label: "work", state: "idle" }],
    events: {},
    drafts: {},
  }),
}));
vi.mock("../src/components/SharingToggle", () => ({ SharingToggle: () => null }));
vi.mock("@/i18n/navigation", () => ({ Link: "a" }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("the phone session view recognizes /link locally and exposes an authenticated session URL", () => {
  render(<SessionDetail sid="session-123" />);
  fireEvent.change(screen.getByLabelText("prompt"), { target: { value: "/link" } });
  fireEvent.click(screen.getByRole("button", { name: "send" }));
  expect(state.prompt).not.toHaveBeenCalled();
  expect(screen.getByRole("link").getAttribute("href")).toBe(
    "https://www.chalyb.com/en/app/chalito/sesiones/session-123",
  );
  expect(screen.getByText("linkHint")).toBeTruthy();
});
