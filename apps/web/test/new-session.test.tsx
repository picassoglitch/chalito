import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DeviceView, Snapshot } from "@chalito/client";
import { NewSession } from "../src/components/NewSession";

const state = vi.hoisted(() => ({ snapshot: null as unknown, startSession: vi.fn(), push: vi.fn() }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("../src/components/ChalitoProvider", () => ({
  useChalito: () => ({ client: { actions: { startSession: state.startSession } } }),
  useLive: () => state.snapshot,
}));
vi.mock("@/i18n/navigation", () => ({ useRouter: () => ({ push: state.push }), Link: "a" }));
vi.mock("../src/components/Sessions", () => ({ REMOTE_MODES: ["default", "plan"] }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const snapshot = (): Snapshot => ({
  status: "live",
  approvals: [],
  sessions: [],
  events: {},
  drafts: {},
  notifications: [],
  devModeActive: false,
  devices: [
    {
      deviceId: "pc-a",
      name: "Work PC",
      role: "agent",
      online: true,
      revoked: false,
      setup: { adapters: ["gemini"], labels: ["work"], workspaces: 1 },
    } as DeviceView,
    {
      deviceId: "pc-b",
      name: "Home PC",
      role: "agent",
      online: true,
      revoked: false,
      setup: { adapters: ["grok"], labels: ["home"], workspaces: 1 },
    } as DeviceView,
  ],
});

it("uses the selected computer's tools and folders even before its first session", () => {
  state.snapshot = snapshot();
  render(<NewSession />);
  expect(screen.getByRole("radio", { name: "gemini" })).toBeTruthy();
  expect(document.querySelector('option[value="work"]')).toBeTruthy();
  fireEvent.change(screen.getByLabelText(/^workspace/), { target: { value: "work" } });
  fireEvent.change(screen.getByLabelText("computer"), { target: { value: "pc-b" } });
  expect(screen.getByRole("radio", { name: "grok" })).toBeTruthy();
  expect(screen.queryByRole("radio", { name: "gemini" })).toBeNull();
  expect((screen.getByLabelText(/^workspace/) as HTMLInputElement).value).toBe("");
  expect(document.querySelector('option[value="home"]')).toBeTruthy();
  expect(document.querySelector('option[value="work"]')).toBeNull();
});

it("sends the chosen recipe and follows only the session confirmed for its own command", async () => {
  const live = snapshot();
  state.snapshot = live;
  state.startSession.mockResolvedValue("my-command");
  const { rerender } = render(<NewSession />);
  fireEvent.change(screen.getByLabelText(/^workspace/), { target: { value: "work" } });
  fireEvent.change(screen.getByLabelText("prompt"), { target: { value: "fix it" } });
  fireEvent.click(screen.getByRole("button", { name: "start" }));
  await waitFor(() =>
    expect(state.startSession).toHaveBeenCalledWith({
      agentDeviceId: "pc-a",
      appId: "gemini",
      workspaceLabel: "work",
      prompt: "fix it",
      permissionMode: "default",
    }),
  );
  await screen.findByRole("status");
  state.snapshot = {
    ...live,
    sessions: [{ sid: "unrelated", agentDeviceId: "pc-a" }],
    events: {
      unrelated: [{ type: "session.started", meta: { commandId: "another-command" } }],
    },
  };
  rerender(<NewSession />);
  expect(state.push).not.toHaveBeenCalled();
  state.snapshot = {
    ...live,
    sessions: [{ sid: "mine", agentDeviceId: "pc-a" }],
    events: {
      mine: [{ type: "session.started", meta: { commandId: "my-command" } }],
    },
  };
  rerender(<NewSession />);
  await waitFor(() =>
    expect(state.push).toHaveBeenCalledWith({ pathname: "/sesiones/[sid]", params: { sid: "mine" } }),
  );
});
