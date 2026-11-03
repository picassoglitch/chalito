import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NativeConnections } from "../src/panel/NativeConnections.js";
import { TextProviders } from "../src/lib/i18n.js";
import { IpcUnavailableError, unavailableIpc, type NativeConnectionView } from "../src/lib/ipc.js";

afterEach(cleanup);

const row = (
  provider: NativeConnectionView["provider"],
  over: Partial<NativeConnectionView> & { error?: string } = {},
) =>
  ({
    provider,
    available: true,
    configured: false,
    connected: false,
    path: `/home/test/.${provider}/hooks.json`,
    hash: `h-${provider}`,
    events: ["PreToolUse"],
    ...over,
  }) as NativeConnectionView;
const show = (ipc: Parameters<typeof NativeConnections>[0]["ipc"]) =>
  render(
    <TextProviders locale="en">
      <NativeConnections ipc={ipc} />
    </TextProviders>,
  );

// Owner 2026-11-03 — Chalito is a bridge, not a gate: the card never offers Connect, only removes old hooks.
it("hides the card when no app has Chalito's old hook, and never offers Connect", async () => {
  const nativeConnections = vi.fn(async () => [row("codex"), row("claude", { available: false }), row("cursor")]);
  const { container } = show({ ...unavailableIpc, nativeConnections, setNativeConnection: vi.fn() });
  await waitFor(() => expect(nativeConnections).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 10));
  expect(container.innerHTML).toBe("");
  expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
});

it("lists only apps with a leftover hook, and removes it after a confirm", async () => {
  let rows = [row("codex", { configured: true }), row("claude"), row("cursor", { configured: true, connected: true })];
  const setNativeConnection = vi.fn(async (provider: string, enabled: boolean) => {
    rows = rows.map((r) => (r.provider === provider ? { ...r, configured: enabled } : r));
  });
  const { container } = show({ ...unavailableIpc, nativeConnections: async () => rows, setNativeConnection });
  await screen.findByRole("heading", { name: "Chalito's old hooks in your AI apps" });
  expect(screen.getByText(/never approves or blocks/)).toBeTruthy();
  expect(container.querySelector('[data-native="claude"]')).toBeNull();
  expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
  const codex = container.querySelector('[data-native="codex"]')! as HTMLElement;
  expect(within(codex).getByText("Chalito's old hook is still in this app's settings.")).toBeTruthy();
  fireEvent.click(within(codex).getByRole("button", { name: "Disconnect app" }));
  expect(setNativeConnection).not.toHaveBeenCalled();
  const group = within(codex).getByRole("group", { name: "Remove Chalito's hook" });
  expect(within(group).getByText(/Removes only Chalito's hook/)).toBeTruthy();
  fireEvent.click(within(group).getByRole("button", { name: "Disconnect app" }));
  await waitFor(() => expect(setNativeConnection).toHaveBeenCalledWith("codex", false, "h-codex"));
  await waitFor(() => expect(container.querySelector('[data-native="codex"]')).toBeNull());
  expect(container.querySelector('[data-native="cursor"]')).toBeTruthy();
  // Last hook removed: the card goes away.
  fireEvent.click(screen.getByRole("button", { name: "Disconnect app" }));
  fireEvent.click(
    within(screen.getByRole("group", { name: "Remove Chalito's hook" })).getByRole("button", {
      name: "Disconnect app",
    }),
  );
  await waitFor(() => expect(container.innerHTML).toBe(""));
});

it.each([
  ["retired", "Chalito no longer connects to AI apps to approve their actions. Nothing was changed."],
  ["config_changed", "The settings changed while this screen was open. Review and try again."],
])("explains a %s error and keeps the row", async (code, text) => {
  const ipc = {
    ...unavailableIpc,
    nativeConnections: async () => [row("codex", { configured: true })],
    setNativeConnection: vi.fn().mockRejectedValue(new Error(code)),
  };
  show(ipc);
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect app" }));
  fireEvent.click(
    within(screen.getByRole("group", { name: "Remove Chalito's hook" })).getByRole("button", {
      name: "Disconnect app",
    }),
  );
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", text);
  expect(screen.queryByRole("group", { name: "Remove Chalito's hook" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Codex" })).toBeTruthy();
});

it("shows a row's own error and keeps Disconnect available when Chalito's record is damaged", async () => {
  const ipc = {
    ...unavailableIpc,
    nativeConnections: async () => [row("claude", { configured: true, error: "state_corrupt" })],
    setNativeConnection: vi.fn(),
  };
  const { container } = show(ipc);
  await screen.findByRole("heading", { name: "Claude Code" });
  const claude = container.querySelector('[data-native="claude"]')! as HTMLElement;
  expect(within(claude).getByText(/record of this hook is damaged/)).toBeTruthy();
  expect((within(claude).getByRole("button", { name: "Disconnect app" }) as HTMLButtonElement).disabled).toBe(false);
});

it("shows the card in Spanish", async () => {
  render(
    <TextProviders locale="es">
      <NativeConnections
        ipc={{ ...unavailableIpc, nativeConnections: async () => [row("codex", { configured: true })] }}
      />
    </TextProviders>,
  );
  expect(await screen.findByRole("button", { name: "Desconectar aplicación" })).toBeTruthy();
  expect(screen.getByText(/nunca aprueba ni bloquea/)).toBeTruthy();
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

it("keeps the last rows, an open confirm and a Disconnect error when a later read fails", async () => {
  let fail: Error | null = null;
  const nativeConnections = vi.fn(async () => {
    if (fail) throw fail;
    return [row("codex", { configured: true })];
  });
  const setNativeConnection = vi.fn().mockRejectedValue(new Error("os_auth_failed"));
  const ipc = { ...unavailableIpc, nativeConnections, setNativeConnection };
  const { rerender } = show(ipc);
  // A Disconnect error survives a failing re-read.
  fireEvent.click(await screen.findByRole("button", { name: "Disconnect app" }));
  fail = new Error("internal");
  fireEvent.click(
    within(screen.getByRole("group", { name: "Remove Chalito's hook" })).getByRole("button", {
      name: "Disconnect app",
    }),
  );
  await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
  expect(document.querySelector("[data-native-read-failed]")?.textContent).toBe(
    "Chalito couldn't refresh these apps. The list shows the last status it read.",
  );
  expect(screen.getByRole("heading", { name: "Codex" })).toBeTruthy();
  // An open confirm survives a failing poll.
  fail = null;
  rerender(<TextProviders locale="en">{<NativeConnections ipc={{ ...ipc }} />}</TextProviders>);
  await waitFor(() => expect(document.querySelector("[data-native-read-failed]")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Disconnect app" }));
  fail = new Error("internal");
  rerender(<TextProviders locale="en">{<NativeConnections ipc={{ ...ipc }} />}</TextProviders>);
  await waitFor(() => expect(document.querySelector("[data-native-read-failed]")).toBeTruthy());
  expect(screen.getByRole("group", { name: "Remove Chalito's hook" })).toBeTruthy();
});

it("hides the card only when the agent has no such call", async () => {
  for (const error of [new IpcUnavailableError(), new Error("unknown_method")]) {
    const { container, unmount } = render(
      <TextProviders locale="en">
        <NativeConnections ipc={{ ...unavailableIpc, nativeConnections: async () => Promise.reject(error) }} />
      </TextProviders>,
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(container.innerHTML).toBe("");
    unmount();
  }
});
