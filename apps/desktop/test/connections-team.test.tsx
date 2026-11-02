import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TextProviders } from "../src/lib/i18n.js";
import { unavailableIpc, type TeamConnectionsView, type TeamProvider } from "../src/lib/ipc.js";
import { ConnectionsScreen } from "../src/panel/connections/ConnectionsScreen.js";
import { TeamSection } from "../src/panel/connections/TeamSection.js";

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
      <TeamSection ipc={{ ...unavailableIpc, teamConnections: async () => structuredClone(current), setTeamTrust }} />
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
      <TeamSection
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

it("is one section of the single Connections screen, after the AI tools found on this PC", async () => {
  const found = { scan: async () => [], connect: vi.fn(), disconnect: vi.fn() };
  const { container } = render(
    <TextProviders locale="en">
      <ConnectionsScreen found={found} ipc={{ ...unavailableIpc, teamConnections: async () => view() }} />
    </TextProviders>,
  );
  const team = await screen.findByRole("heading", { name: "AI team" });
  expect(screen.getAllByRole("heading", { name: "AI team" })).toHaveLength(1);
  const sections = [...container.querySelectorAll("section")];
  expect(sections.indexOf(team.closest("section")!)).toBe(1);
  expect(screen.getAllByRole("switch")).toHaveLength(4);
});

it("lists an app that joined under its own id by that id, with its own trust switch", async () => {
  const current = view();
  current.workspaces[0]!.connections.push({
    provider: "gemini",
    known: false,
    trusted: false,
    connected: false,
    command: "/app/chalito",
    args: ["team", "mcp", "gemini", "/work/project"],
  });
  const setTeamTrust = vi.fn(async () => structuredClone(current));
  render(
    <TextProviders locale="en">
      <TeamSection ipc={{ ...unavailableIpc, teamConnections: async () => structuredClone(current), setTeamTrust }} />
    </TextProviders>,
  );
  await screen.findByRole("heading", { name: "Other app “gemini”" });
  fireEvent.click(screen.getByRole("switch", { name: "Trust Other app “gemini” for this workspace" }));
  await waitFor(() => expect(setTeamTrust).toHaveBeenCalledWith("gemini", "project", true, "/work/project"));
});
