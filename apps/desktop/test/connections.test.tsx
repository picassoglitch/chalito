import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TextProviders } from "../src/lib/i18n.js";
import { unavailableIpc, type TeamConnectionsView, type TeamProvider } from "../src/lib/ipc.js";
import { Connections } from "../src/panel/Connections.js";

afterEach(cleanup);
const view = (): TeamConnectionsView => ({
  workspaces: ["project", "other"].map((label) => ({
    label,
    path: `/work/${label}`,
    connections: (["claude", "codex", "grok", "cursor"] as TeamProvider[]).map((provider) => ({
      provider,
      trusted: false,
      connected: false,
      command: "/app/chalito",
      args: ["team", "mcp", provider, `/work/${label}`],
    })),
  })),
});

it("shows the four AI trust switches and scopes changes to the selected workspace", async () => {
  const current = view();
  const setTeamTrust = vi.fn(async (provider: TeamProvider, workspace: string, trusted: boolean) => {
    current.workspaces.find((w) => w.label === workspace)!.connections.find((c) => c.provider === provider)!.trusted =
      trusted;
    return structuredClone(current);
  });
  render(
    <TextProviders locale="en">
      <Connections ipc={{ ...unavailableIpc, teamConnections: async () => structuredClone(current), setTeamTrust }} />
    </TextProviders>,
  );
  await screen.findByRole("switch", { name: "Trust Claude Code for this workspace" });
  expect(screen.getAllByRole("switch")).toHaveLength(4);
  expect(screen.queryByText(/gmail/i)).toBeNull();
  fireEvent.click(screen.getByRole("switch", { name: "Trust Claude Code for this workspace" }));
  await waitFor(() => expect(setTeamTrust).toHaveBeenCalledWith("claude", "project", true, "/work/project"));
  await screen.findByText("Trusted · waiting for the app to connect");
  expect(
    (screen.getByRole("switch", { name: "Trust Claude Code for this workspace" }) as HTMLInputElement).checked,
  ).toBe(true);
  fireEvent.change(screen.getByRole("combobox", { name: "Workspace" }), { target: { value: "other" } });
  expect(
    (screen.getByRole("switch", { name: "Trust Claude Code for this workspace" }) as HTMLInputElement).checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole("switch", { name: "Trust Grok Build for this workspace" }));
  await waitFor(() => expect(setTeamTrust).toHaveBeenCalledWith("grok", "other", true, "/work/other"));
});

it("keeps trust off and displays a rejected trust change", async () => {
  render(
    <TextProviders locale="en">
      <Connections
        ipc={{
          ...unavailableIpc,
          teamConnections: async () => view(),
          setTeamTrust: async () => {
            throw new Error("os_auth_failed");
          },
        }}
      />
    </TextProviders>,
  );
  fireEvent.click(await screen.findByRole("switch", { name: "Trust Codex for this workspace" }));
  await screen.findByRole("alert");
  expect((screen.getByRole("switch", { name: "Trust Codex for this workspace" }) as HTMLInputElement).checked).toBe(
    false,
  );
});
