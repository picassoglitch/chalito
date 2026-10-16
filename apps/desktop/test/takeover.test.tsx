import catalogJson from "../../../recipes/catalog.json" with { type: "json" };
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextProviders } from "../src/lib/i18n.js";
import {
  IpcUnavailableError,
  unavailableIpc,
  type AddWorkspaceResult,
  type AgentIpc,
  type AppPinView,
  type AppView,
  type Workspace,
} from "../src/lib/ipc.js";
import type { AgentStatus, CliStatus, LocalAgentApi } from "../src/lib/local-agent.js";
import type { ThisComputerApi } from "../src/lib/this-computer.js";
import { Apps } from "../src/panel/Apps.js";
import { LocalAgent } from "../src/panel/LocalAgent.js";
import { ThisComputer } from "../src/panel/ThisComputer.js";

/** First Run C (ADR 0028): the panel finds and trusts the agents, picks folders, starts with the computer. */

afterEach(cleanup);

const recipes = catalogJson as unknown as { recipes: AppView["recipe"][] };
const recipe = (id: string) => recipes.recipes.find((r) => r.id === id)!;
const aider = (pin: AppPinView | null): AppView => ({
  appId: "aider",
  recipe: recipe("aider"),
  custom: false,
  enabled: true,
  doc: {
    mode: null,
    connected: false,
    state: "needs_auth",
    cli: { installed: true, version: "0.80.0" },
    error: null,
    at: 1,
    kind: "terminal",
    custom: false,
  },
  signinAllowed: false,
  installRequestedUntil: null,
  supported: true,
  install: null,
  sessions: false,
  pin,
});

const withText = (ui: React.ReactNode, locale: "es" | "en" = "es") =>
  render(<TextProviders locale={locale}>{ui}</TextProviders>);

const ipcWith = (over: Partial<AgentIpc>) => {
  const calls: unknown[][] = [];
  const ipc: AgentIpc = { ...unavailableIpc, ...over };
  return { ipc, calls };
};

describe('agents found on this computer: "Usar" and "se actualizó: confirmar"', () => {
  const row = (c: HTMLElement) => c.querySelector('[data-app="aider"]') as HTMLElement;

  it('a CLI found but not trusted yet offers "Usar", which trusts it here', async () => {
    let pin: AppPinView = {
      state: "not_pinned",
      path: null,
      detected: "/home/ana/.local/bin/aider",
      sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const pinApp = vi.fn(async () => {
      pin = { state: "pinned", path: "/home/ana/.local/bin/aider", detected: null, sha256: null };
    });
    const { ipc } = ipcWith({
      apps: async () => ({ apps: [aider(pin)], problems: [], catalog: null }),
      pinApp,
    });
    const { container } = withText(<Apps ipc={ipc} />);
    await waitFor(() => expect(row(container)?.querySelector('[data-pin="not_pinned"]')).toBeTruthy());
    expect(row(container).textContent).toContain("Encontré Aider en esta computadora (/home/ana/.local/bin/aider)");
    fireEvent.click(screen.getByRole("button", { name: "Usar" }));
    await waitFor(() =>
      expect(pinApp).toHaveBeenCalledWith("aider", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    );
    await waitFor(() => expect(row(container).querySelector("[data-pin]")).toBeNull());
  });

  it("an updated binary asks to confirm the new version", async () => {
    const pinApp = vi.fn(async () => undefined);
    const { ipc } = ipcWith({
      apps: async () => ({
        apps: [
          aider({
            state: "changed",
            path: "/usr/local/bin/aider",
            detected: "/usr/local/bin/aider",
            sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          }),
        ],
        problems: [],
        catalog: null,
      }),
      pinApp,
    });
    withText(<Apps ipc={ipc} />, "en");
    await screen.findByText(/Aider updated itself/);
    fireEvent.click(screen.getByRole("button", { name: "Yes, it's mine: confirm" }));
    await waitFor(() =>
      expect(pinApp).toHaveBeenCalledWith("aider", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    );
  });

  it("an unsafe binary is explained and offers nothing to click; a failed pin says why", async () => {
    const { ipc } = ipcWith({
      apps: async () => ({
        apps: [
          aider({
            state: "unsafe",
            path: "/tmp/aider",
            detected: "/tmp/aider",
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          }),
        ],
        problems: [],
        catalog: null,
      }),
    });
    const { container } = withText(<Apps ipc={ipc} />);
    await screen.findByText(/Cualquier programa de esta computadora puede cambiar Aider/);
    expect(row(container).querySelector("[data-pin] button")).toBeNull();
    cleanup();

    const failing = ipcWith({
      apps: async () => ({
        apps: [
          aider({
            state: "not_pinned",
            path: null,
            detected: "/x/aider",
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          }),
        ],
        problems: [],
        catalog: null,
      }),
      pinApp: async () => Promise.reject(new Error("pin_failed")),
    });
    withText(<Apps ipc={failing.ipc} />);
    fireEvent.click(await screen.findByRole("button", { name: "Usar" }));
    await screen.findByText(/No pude confirmarlo/);
    cleanup();

    const moved = ipcWith({
      apps: async () => ({
        apps: [
          aider({
            state: "not_pinned",
            path: null,
            detected: "/x/aider",
            sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          }),
        ],
        problems: [],
        catalog: null,
      }),
      pinApp: async () => Promise.reject(new Error("pin_mismatch")),
    });
    withText(<Apps ipc={moved.ipc} />);
    fireEvent.click(await screen.findByRole("button", { name: "Usar" }));
    await screen.findByText(/Cambió mientras lo veías/);
  });

  it("trusted, or not installed at all: no pin row", async () => {
    const { ipc } = ipcWith({
      apps: async () => ({
        apps: [aider({ state: "pinned", path: "/x/aider", detected: null, sha256: null })],
        problems: [],
        catalog: null,
      }),
    });
    const { container } = withText(<Apps ipc={ipc} />);
    await waitFor(() => expect(row(container)).toBeTruthy());
    expect(row(container).querySelector("[data-pin]")).toBeNull();
    cleanup();
    const none = ipcWith({
      apps: async () => ({
        apps: [aider({ state: "not_pinned", path: null, detected: null, sha256: null })],
        problems: [],
        catalog: null,
      }),
    });
    const r = withText(<Apps ipc={none.ipc} />);
    await waitFor(() => expect(row(r.container)).toBeTruthy());
    expect(row(r.container).querySelector("[data-pin]")).toBeNull();
  });
});

describe("Esta computadora: start with the computer and the folders", () => {
  const api = (o: Partial<ThisComputerApi> = {}): ThisComputerApi => ({
    autostart: vi.fn(async () => true),
    setAutostart: vi.fn(async (on: boolean) => on),
    pickFolder: vi.fn(async () => "/home/ana/code/web"),
    ...o,
  });
  const folders = (initial: Workspace[] = []) => {
    let list = [...initial];
    const addWorkspace = vi.fn(async (path: string): Promise<AddWorkspaceResult> => {
      const label = path.split("/").pop()!;
      if (list.some((w) => w.label === label)) return { ok: true, label, added: false };
      list = [...list, { label, path }];
      return { ok: true, label, added: true };
    });
    const removeWorkspace = vi.fn(async (label: string) => {
      list = list.filter((w) => w.label !== label);
      return { removed: true };
    });
    return { workspaces: async () => ({ workspaces: list }), addWorkspace, removeWorkspace };
  };

  it("starts on (the default) and the switch turns it off", async () => {
    const a = api();
    const { container } = withText(<ThisComputer api={a} ipc={ipcWith(folders()).ipc} />);
    const box = (await screen.findByLabelText("Iniciar Chalito con la computadora")) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(a.setAutostart).toHaveBeenCalledWith(false));
    await waitFor(() => expect(container.querySelector('[data-autostart="off"]')).toBeTruthy());
  });

  it('no folders yet says so; "Agregar una carpeta" opens the picker and adds it through the agent', async () => {
    const f = folders();
    const a = api();
    const { container } = withText(<ThisComputer api={a} ipc={ipcWith(f).ipc} />);
    await screen.findByText(/Todavía no hay ninguna/);
    fireEvent.click(screen.getByRole("button", { name: "Agregar una carpeta" }));
    await waitFor(() => expect(f.addWorkspace).toHaveBeenCalledWith("/home/ana/code/web"));
    await screen.findByText("Listo: Chalito ya puede trabajar en «web».");
    await waitFor(() => expect(container.querySelector('[data-folder="web"]')).toBeTruthy());
  });

  it("a cancelled picker adds nothing; the agent's refusals are explained", async () => {
    const f = folders();
    const cancelled = api({ pickFolder: vi.fn(async () => null) });
    withText(<ThisComputer api={cancelled} ipc={ipcWith(f).ipc} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agregar una carpeta" }));
    await waitFor(() => expect(cancelled.pickFolder).toHaveBeenCalled());
    expect(f.addWorkspace).not.toHaveBeenCalled();
    cleanup();

    for (const [reason, text] of [
      ["too_broad", /demasiado amplia/],
      ["os_auth_failed", /no confirmó que fuiste tú/],
      ["chalito_folder", /carpeta interna de Chalito/],
      ["sensitive", /guarda llaves o contraseñas/],
      ["startup", /puede ejecutarse solo/],
    ] as const) {
      const refusing = ipcWith({
        workspaces: async () => ({ workspaces: [] }),
        addWorkspace: async () => ({ ok: false, reason }),
      });
      withText(<ThisComputer api={api()} ipc={refusing.ipc} />);
      fireEvent.click(await screen.findByRole("button", { name: "Agregar una carpeta" }));
      expect((await screen.findByRole("alert")).textContent).toMatch(text);
      cleanup();
    }
  });

  it("a folder can be removed", async () => {
    const f = folders([{ label: "web", path: "/home/ana/code/web" }]);
    const { container } = withText(<ThisComputer api={api()} ipc={ipcWith(f).ipc} />, "en");
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(f.removeWorkspace).toHaveBeenCalledWith("web"));
    await waitFor(() => expect(container.querySelector('[data-folders="none"]')).toBeTruthy());
  });

  it("before the computer is connected the folders wait", async () => {
    withText(
      <ThisComputer
        api={api()}
        ipc={{ ...unavailableIpc, workspaces: () => Promise.reject(new IpcUnavailableError()) }}
      />,
    );
    await screen.findByText(/Conecta esta computadora primero/);
    expect(screen.queryByRole("button", { name: "Agregar una carpeta" })).toBeNull();
  });
});

describe("the chalito command sits under Avanzado", () => {
  it("is inside a closed details block", async () => {
    const status: AgentStatus = { state: "running", pid: 1 };
    const cli: CliStatus = {
      os: "linux",
      installed: false,
      command: "/home/ana/.local/bin/chalito",
      onPath: true,
      adminPrompt: false,
      unavailable: null,
    };
    const la: LocalAgentApi = {
      status: async () => status,
      cliStatus: async () => cli,
      installCli: async () => cli,
    };
    const { container } = withText(<LocalAgent api={la} pollMs={60_000} />);
    await waitFor(() => expect(container.querySelector('details[data-advanced="cli"]')).toBeTruthy());
    const details = container.querySelector('details[data-advanced="cli"]') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Avanzado: comando chalito para la terminal");
  });
});
