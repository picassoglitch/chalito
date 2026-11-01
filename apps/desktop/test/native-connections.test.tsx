import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnections } from "../src/panel/NativeConnections.js";
import { TextProviders } from "../src/lib/i18n.js";
import { unavailableIpc, type NativeConnectionView } from "../src/lib/ipc.js";

afterEach(cleanup);

it("connects an installed native app without asking for an AI key and waits for its hook handshake", async () => {
  let rows: NativeConnectionView[] = ["codex", "claude", "cursor"].map((provider) => ({
    provider: provider as NativeConnectionView["provider"],
    available: provider !== "cursor",
    configured: false,
    connected: false,
    path: `/home/test/.${provider}/hooks.json`,
    hash: "missing",
    events: ["PreToolUse"],
  }));
  const setNativeConnection = vi.fn(async (provider: string, enabled: boolean) => {
    rows = rows.map((row) => (row.provider === provider ? { ...row, configured: enabled } : row));
  });
  const ipc = { ...unavailableIpc, nativeConnections: async () => rows, setNativeConnection };
  const { container, rerender } = render(
    <TextProviders locale="en">
      <NativeConnections ipc={ipc} />
    </TextProviders>,
  );
  await screen.findByRole("heading", { name: "Codex" });
  const codex = container.querySelector('[data-native="codex"]')! as HTMLElement;
  const cursor = container.querySelector('[data-native="cursor"]')! as HTMLElement;
  expect((within(cursor).getByRole("button", { name: "Connect app" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(codex).getByRole("button", { name: "Connect app" }));
  expect(setNativeConnection).not.toHaveBeenCalled();
  expect(container.querySelector('input[type="password"]')).toBeNull();
  fireEvent.click(within(codex).getByRole("group", { name: "Connect this AI app" }).querySelector("button")!);
  await waitFor(() => expect(setNativeConnection).toHaveBeenCalledWith("codex", true, "missing"));
  expect(await within(codex).findByText(/Connector installed/)).toBeTruthy();
  expect(screen.queryByText(/A native session has connected/)).toBeNull();
  rows = rows.map((row) => (row.provider === "codex" ? { ...row, connected: true } : row));
  rerender(
    <TextProviders locale="en">
      <NativeConnections ipc={{ ...ipc }} />
    </TextProviders>,
  );
  expect(await screen.findByText(/A native session has connected/)).toBeTruthy();
});

it("does not confirm a connection when settings changed during the preview", async () => {
  const row: NativeConnectionView = {
    provider: "codex",
    available: true,
    configured: false,
    connected: false,
    path: "/test/hooks.json",
    hash: "old",
    events: ["PreToolUse"],
  };
  const ipc = {
    ...unavailableIpc,
    nativeConnections: async () => [row],
    setNativeConnection: vi.fn().mockRejectedValue(new Error("config_changed")),
  };
  render(
    <TextProviders locale="en">
      <NativeConnections ipc={ipc} />
    </TextProviders>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Connect app" }));
  fireEvent.click(
    within(screen.getByRole("group", { name: "Connect this AI app" })).getByRole("button", { name: "Connect app" }),
  );
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "The settings changed while this screen was open. Review and try again.",
  );
  expect(screen.queryByRole("group", { name: "Connect this AI app" })).toBeNull();
});

it("shows a row's own error and keeps Disconnect available when Chalito's record is damaged", async () => {
  const rows = [
    {
      provider: "codex",
      available: true,
      configured: false,
      connected: false,
      path: "/c",
      hash: "",
      events: [],
      error: "unsafe_path",
    },
    {
      provider: "claude",
      available: true,
      configured: true,
      connected: false,
      path: "/a",
      hash: "h",
      events: [],
      error: "state_corrupt",
    },
    {
      provider: "cursor",
      available: true,
      configured: false,
      connected: false,
      path: "/u",
      hash: "missing",
      events: [],
    },
  ] as NativeConnectionView[];
  const ipc = { ...unavailableIpc, nativeConnections: async () => rows, setNativeConnection: vi.fn() };
  const { container } = render(
    <TextProviders locale="en">
      <NativeConnections ipc={ipc} />
    </TextProviders>,
  );
  await screen.findByRole("heading", { name: "Codex" });
  const codex = container.querySelector('[data-native="codex"]')! as HTMLElement;
  const claude = container.querySelector('[data-native="claude"]')! as HTMLElement;
  const cursor = container.querySelector('[data-native="cursor"]')! as HTMLElement;
  expect(within(codex).getByText(/linked or unsafe file/)).toBeTruthy();
  expect((within(codex).getByRole("button", { name: "Connect app" }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(claude).getByText(/record of this connector is damaged/)).toBeTruthy();
  expect((within(claude).getByRole("button", { name: "Disconnect app" }) as HTMLButtonElement).disabled).toBe(false);
  expect(cursor.querySelector("[data-native-error]")).toBeNull();
});

it("polls every 15 seconds, and only while the panel is visible", async () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = "visible";
  const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  try {
    const nativeConnections = vi.fn(async () => [] as NativeConnectionView[]);
    render(
      <TextProviders locale="en">
        <NativeConnections ipc={{ ...unavailableIpc, nativeConnections }} />
      </TextProviders>,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeConnections).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(nativeConnections).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(nativeConnections).toHaveBeenCalledTimes(2);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(nativeConnections).toHaveBeenCalledTimes(2);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(nativeConnections).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(nativeConnections).toHaveBeenCalledTimes(4);
  } finally {
    spy.mockRestore();
    vi.useRealTimers();
  }
});
