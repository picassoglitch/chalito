import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ChalitoClient, DeviceView, Snapshot } from "@chalito/client";
import { TextProviders } from "../src/lib/i18n.js";
import { RemoteTools } from "../src/panel/RemoteTools.js";

afterEach(cleanup);

it("requests account sign-in on the selected PC and waits for that PC to report Connected", async () => {
  const tool = {
    appId: "gemini",
    name: "Test tool",
    state: "needs_auth" as const,
    installed: true,
    signinAllowed: true,
    sessionCapable: true,
    sessionEnabled: true,
  };
  let devices: DeviceView[] = [
    {
      deviceId: "pc-a",
      name: "Work PC",
      role: "agent",
      online: true,
      revoked: false,
      setup: { adapters: ["gemini"], labels: ["work"], workspaces: 1, tools: [tool] },
    } as DeviceView,
    {
      deviceId: "pc-b",
      name: "Offline PC",
      role: "agent",
      online: false,
      revoked: false,
      setup: { adapters: ["gemini"], labels: ["work"], workspaces: 1, tools: [tool] },
    } as DeviceView,
    { deviceId: "revoked", name: "Old PC", role: "agent", online: true, revoked: true } as DeviceView,
  ];
  let snapshot: Snapshot = {
    status: "live",
    approvals: [],
    sessions: [],
    events: {},
    drafts: {},
    notifications: [],
    devices,
    devModeActive: false,
  };
  const listeners = new Set<() => void>();
  const connectApp = vi.fn().mockResolvedValue("cid");
  const client = {
    live: {
      getSnapshot: () => snapshot,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      resync: vi.fn().mockResolvedValue(undefined),
    },
    actions: { connectApp },
  } as unknown as ChalitoClient;
  render(
    <TextProviders locale="en">
      <RemoteTools client={client} />
    </TextProviders>,
  );
  expect(screen.queryByText("Old PC")).toBeNull();
  expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(1);
  expect(screen.queryByText("Connected", { exact: true })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(connectApp).toHaveBeenCalledWith("pc-a", "gemini"));
  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    expect.stringContaining("browser on Work PC"),
  );
  expect(screen.queryByText("Connected", { exact: true })).toBeNull();
  await act(async () => {
    devices = [
      { ...devices[0]!, setup: { ...devices[0]!.setup!, tools: [{ ...tool, state: "connected" }] } },
      devices[1]!,
    ];
    snapshot = { ...snapshot, devices };
    listeners.forEach((fn) => fn());
  });
  expect(screen.getByText(/Connected/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
});
