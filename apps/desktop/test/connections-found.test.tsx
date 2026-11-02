import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConnectionsScreen } from "../src/panel/connections/ConnectionsScreen.js";
import { TextProviders } from "../src/lib/i18n.js";
import { IpcUnavailableError } from "../src/lib/ipc.js";
import { invokeFoundIpc, type FoundIpc, type FoundRow } from "../src/lib/connections-found-ipc.js";

afterEach(cleanup);

const row = (id: string, extra: Partial<FoundRow> = {}): FoundRow => ({
  id,
  name: id,
  kind: "agent",
  path: `/usr/bin/${id}`,
  recipeId: id,
  mcpCapable: true,
  connected: false,
  ...extra,
});
const ready = (configPath: string, extra = {}) => ({
  connected: false,
  channel: "ready" as const,
  configPath,
  ...extra,
});

const mount = (ipc: FoundIpc, locale: "en" | "es" = "en") =>
  render(
    <TextProviders locale={locale}>
      <ConnectionsScreen found={ipc} />
    </TextProviders>,
  );

it("lists what was found and connects one after a confirmation that shows the file", async () => {
  let rows: FoundRow[] = [
    row("codex", { channel: ready("/home/a/.codex/config.toml") }),
    row("gemini", {
      channel: { connected: false, channel: "needs_update", configPath: "/home/a/.gemini/settings.json" },
    }),
    row("aider", { mcpCapable: false }),
    row("vscode", { kind: "mcp-client", recipeId: undefined }),
  ];
  const connect = vi.fn(async (id: string) => {
    rows = rows.map((r) => (r.id === id ? { ...r, connected: true, channel: { ...r.channel!, connected: true } } : r));
  });
  const ipc: FoundIpc = { scan: async () => rows, connect, disconnect: vi.fn() };
  const { container } = mount(ipc);
  await screen.findByRole("heading", { name: "codex" });
  const el = (id: string) => container.querySelector(`[data-found="${id}"]`) as HTMLElement;
  expect(within(el("gemini")).getByText("Requires the team channel update")).toBeTruthy();
  expect((within(el("gemini")).getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(el("aider")).queryByRole("button")).toBeNull();
  expect(within(el("aider")).getByText("Doesn't support MCP connections")).toBeTruthy();
  expect(within(el("vscode")).getByText(/MCP app/)).toBeTruthy();

  fireEvent.click(within(el("codex")).getByRole("button", { name: "Connect" }));
  expect(connect).not.toHaveBeenCalled();
  const group = within(el("codex")).getByRole("group", { name: "Confirm the change" });
  expect(within(group).getByText("/home/a/.codex/config.toml")).toBeTruthy();
  fireEvent.click(within(group).getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(connect).toHaveBeenCalledWith("codex"));
  expect(await within(el("codex")).findByText("Connected to Chalito")).toBeTruthy();
  expect(within(el("codex")).getByRole("button", { name: "Disconnect" })).toBeTruthy();
});

it("shows the agent's error code in words and keeps Disconnect possible on an older build", async () => {
  const rows = [
    row("cursor", {
      channel: { connected: true, channel: "needs_update" as const, configPath: "/h/.cursor/mcp.json" },
    }),
    row("grok", { channel: ready("/h/.grok/config.toml", { error: "name_taken" }) }),
  ];
  const disconnect = vi.fn(async () => {
    throw new Error("invalid_config");
  });
  const { container } = mount({ scan: async () => rows, connect: vi.fn(), disconnect });
  await screen.findByRole("heading", { name: "cursor" });
  const cursor = container.querySelector('[data-found="cursor"]') as HTMLElement;
  const grok = container.querySelector('[data-found="grok"]') as HTMLElement;
  expect((within(grok).getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(grok).getByText(/already has another server named/)).toBeTruthy();
  fireEvent.click(within(cursor).getByRole("button", { name: "Disconnect" }));
  fireEvent.click(within(within(cursor).getByRole("group")).getByRole("button", { name: "Disconnect" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringMatching(/can't be read/));
});

it("hides the section when the agent has no such feature, but keeps the screen", async () => {
  const { container } = mount({
    scan: () => Promise.reject(new IpcUnavailableError()),
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
  await waitFor(() => expect(container.querySelector("[data-connections-found]")).toBeNull());
  expect(container.querySelector("[data-connections-search]")).toBeTruthy();
});

it("speaks Spanish", async () => {
  mount({ scan: async () => [], connect: vi.fn(), disconnect: vi.fn() }, "es");
  expect(await screen.findByText("Encontradas en esta PC")).toBeTruthy();
  expect(await screen.findByText("Todavía no se encontraron herramientas de IA en esta PC.")).toBeTruthy();
});

it("calls the agent's methods by name", async () => {
  const invoke = vi.fn(async () => undefined as never);
  const ipc = invokeFoundIpc(invoke);
  await ipc.scan();
  await ipc.connect("codex");
  await ipc.disconnect("codex");
  expect(invoke.mock.calls).toEqual([
    ["agent_ipc", { method: "connectionsFound", params: null }],
    ["agent_ipc", { method: "connectionsConnect", params: { id: "codex" } }],
    ["agent_ipc", { method: "connectionsDisconnect", params: { id: "codex" } }],
  ]);
});

it("comes back when the agent answers again after being unavailable", async () => {
  let up = false;
  const { container } = mount({
    scan: () => (up ? Promise.resolve([row("codex")]) : Promise.reject(new IpcUnavailableError())),
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
  await waitFor(() => expect(container.querySelector("[data-connections-found]")).toBeNull());
  up = true;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(await screen.findByRole("heading", { name: "codex" })).toBeTruthy();
});

it("a slow older scan never overwrites a newer one", async () => {
  const pending: ((r: FoundRow[]) => void)[] = [];
  const { container } = mount({
    scan: () => new Promise<FoundRow[]>((resolve) => pending.push(resolve)),
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
  await waitFor(() => expect(pending).toHaveLength(1));
  document.dispatchEvent(new Event("visibilitychange"));
  await waitFor(() => expect(pending).toHaveLength(2));
  pending[1]!([row("codex", { channel: ready("/c", { connected: true }) })]);
  expect(await screen.findByText("Connected to Chalito")).toBeTruthy();
  pending[0]!([row("codex", { channel: ready("/c") })]);
  await new Promise((r) => setTimeout(r, 0));
  expect(container.querySelector('[data-found-status="connected"]')).toBeTruthy();
});

it("says the scan failed, not 'last result', when nothing was ever read", async () => {
  mount({ scan: () => Promise.reject(new Error("internal")), connect: vi.fn(), disconnect: vi.fn() });
  expect(await screen.findByText("Couldn't scan this PC. Try again.")).toBeTruthy();
});
