import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextProviders } from "../src/lib/i18n.js";
import { installError, type AgentStatus, type CliStatus, type LocalAgentApi } from "../src/lib/local-agent.js";
import { LocalAgent } from "../src/panel/LocalAgent.js";

afterEach(cleanup);

const cli = (over: Partial<CliStatus> = {}): CliStatus => ({
  os: "linux",
  installed: false,
  command: "/home/ana/.local/bin/chalito",
  onPath: true,
  adminPrompt: false,
  unavailable: null,
  ...over,
});

const fake = (status: AgentStatus, c: CliStatus, install: () => Promise<CliStatus>) => {
  const api: LocalAgentApi & { installCli: ReturnType<typeof vi.fn> } = {
    status: vi.fn(async () => status),
    cliStatus: vi.fn(async () => c),
    installCli: vi.fn(install),
  };
  return api;
};

const show = (api: LocalAgentApi, locale: "es" | "en" = "en") =>
  render(
    <TextProviders locale={locale}>
      <LocalAgent api={api} pollMs={60_000} />
    </TextProviders>,
  );

describe("this computer's agent (panel, Security tab)", () => {
  it("says what the bundled agent is doing", async () => {
    const cases: [AgentStatus, RegExp][] = [
      [{ state: "running", pid: 7 }, /The agent is running/],
      [{ state: "not_paired" }, /open a terminal and type “chalito pair”/],
      [{ state: "restarting", exitCode: 1, retryInMs: 4000 }, /stopped \(code 1\)\. Restarting it in 4 s/],
      [{ state: "needs_setup" }, /“chalito status”/],
      [{ state: "elsewhere" }, /already running on this computer/],
      [{ state: "no_sidecar" }, /doesn't include the agent/],
    ];
    for (const [s, text] of cases) {
      show(fake(s, cli(), async () => cli()));
      expect(await screen.findByText(text)).toBeTruthy();
      cleanup();
    }
  });

  it("installs the command only after the person confirms, and says where it went", async () => {
    const api = fake({ state: "not_paired" }, cli(), async () => cli({ installed: true }));
    show(api);
    fireEvent.click(await screen.findByRole("button", { name: "Install the chalito command" }));
    expect(api.installCli).not.toHaveBeenCalled();
    expect(screen.getByText(/This creates \/home\/ana\/\.local\/bin\/chalito/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.installCli).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Install the chalito command" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, install" }));
    expect(await screen.findByText("Installed at /home/ana/.local/bin/chalito.")).toBeTruthy();
    expect(screen.getByText(/Open a new terminal/)).toBeTruthy();
    expect(api.installCli).toHaveBeenCalledTimes(1);
  });

  it("macOS warns about the administrator password; Windows about the user PATH (es)", async () => {
    show(
      fake({ state: "running", pid: 1 }, cli({ os: "macos", command: "/usr/local/bin/chalito" }), async () => cli()),
      "es",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Instalar el comando chalito" }));
    expect(screen.getByText(/contraseña de administrador/)).toBeTruthy();
    cleanup();
    show(
      fake({ state: "running", pid: 1 }, cli({ os: "windows", command: "C:\\x\\chalito.cmd" }), async () => cli()),
      "es",
    );
    fireEvent.click(await screen.findByRole("button", { name: "Instalar el comando chalito" }));
    expect(screen.getByText(/PATH de usuario/)).toBeTruthy();
  });

  it("someone else's chalito, a cancelled admin prompt, or a DMG copy: nothing changes, and it says why", async () => {
    const api = fake({ state: "running", pid: 1 }, cli(), async () => Promise.reject("exists"));
    show(api);
    fireEvent.click(await screen.findByRole("button", { name: "Install the chalito command" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, install" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/another program called chalito/);
    cleanup();

    show(
      fake({ state: "running", pid: 1 }, cli({ os: "macos", unavailable: "move_to_applications" }), async () => cli()),
    );
    expect(await screen.findByText(/Move Chalito to the Applications folder/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install the chalito command" })).toBeNull();

    expect(installError("cancelled")).toBe("cancelled");
    expect(installError(new Error("boom"))).toBe("failed");
  });

  it("no sidecar (dev or unwired build): no install button", async () => {
    show(fake({ state: "no_sidecar" }, cli({ unavailable: "no_sidecar", command: null }), async () => cli()));
    await waitFor(() => expect(screen.getByText(/doesn't include the agent/)).toBeTruthy());
    expect(screen.queryByRole("button")).toBeNull();
  });
});
