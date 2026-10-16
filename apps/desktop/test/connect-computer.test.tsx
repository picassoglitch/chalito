import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TextProviders } from "../src/lib/i18n.js";
import { IpcUnavailableError, unavailableIpc, type AgentIpc, type PendingPairing } from "../src/lib/ipc.js";
import type { AgentStatus } from "../src/lib/local-agent.js";
import { ConnectComputer } from "../src/panel/ConnectComputer.js";

afterEach(cleanup);

const URL = "https://www.chalyb.com/app/chalito/computadoras/aprobar#c=code_id_123";
const computer = {
  shortCode: "7K3M-QX9P",
  fingerprint: "ab12 cd34 ef56",
  label: "MacBook de Ana",
  approveUrl: URL,
  expiresAt: Date.now() + 300_000,
  glyph: null,
};
const view = (over: Partial<PendingPairing>): PendingPairing => ({
  pairingId: "p1",
  state: "waiting",
  computer,
  claimer: null,
  replacePhrase: null,
  error: null,
  ...over,
});

/** An unpaired agent whose pairing the test moves along. */
const fakeAgent = () => {
  let current: PendingPairing | null = null;
  const calls: unknown[][] = [];
  const ipc: AgentIpc = {
    ...unavailableIpc,
    startPairing: async (kind) => {
      calls.push(["startPairing", kind]);
      current = view({ state: "waiting" });
      return current;
    },
    pendingPairing: async () => current,
    confirmPairing: async (id, match, typed) => {
      calls.push(["confirmPairing", id, match, ...(typed !== undefined ? [typed] : [])]);
      return current ?? undefined;
    },
  };
  return { ipc, calls, set: (v: PendingPairing | null) => void (current = v) };
};

const renderConnect = (
  ipc: AgentIpc,
  opts: { status?: AgentStatus["state"]; locale?: "es" | "en"; opened?: string[] } = {},
) =>
  render(
    <TextProviders locale={opts.locale ?? "es"}>
      <ConnectComputer
        ipc={ipc}
        openUrl={async (u) => void opts.opened?.push(u)}
        agentStatus={async () => ({ state: opts.status ?? "not_paired" }) as AgentStatus}
        pollMs={20}
      />
    </TextProviders>,
  );

describe("Conectar esta computadora", () => {
  it("one click: asks for a code, opens the approval page once, shows the verification and short codes", async () => {
    const a = fakeAgent();
    const opened: string[] = [];
    renderConnect(a.ipc, { opened });
    fireEvent.click(await screen.findByRole("button", { name: "Conectar esta computadora" }));
    expect(await screen.findByText("ab12 cd34 ef56")).toBeTruthy();
    expect(screen.getByText("7K3M-QX9P")).toBeTruthy();
    expect(screen.getByText(/MacBook de Ana/)).toBeTruthy();
    await waitFor(() => expect(opened).toEqual([URL]));
    await new Promise((r) => setTimeout(r, 80)); // more polls: still opened once
    expect(opened).toEqual([URL]);
    expect(opened[0]).not.toContain("7K3M");
  });

  it("Cancelar while waiting sends no", async () => {
    const a = fakeAgent();
    a.set(view({ state: "waiting" }));
    renderConnect(a.ipc);
    fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    await waitFor(() => expect(a.calls).toContainEqual(["confirmPairing", "p1", false]));
  });

  it("reverse check: shows the approver's code; Sí, fui yo and No fui yo send the local verdict", async () => {
    const a = fakeAgent();
    a.set(view({ state: "claimed", claimer: { fingerprint: "99aa 88bb", passkeyId: "AbCd…wxyz" } }));
    renderConnect(a.ipc);
    expect(await screen.findByText("99aa 88bb")).toBeTruthy();
    expect(screen.getByText(/AbCd…wxyz/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "No fui yo" }));
    await waitFor(() => expect(a.calls).toContainEqual(["confirmPairing", "p1", false]));
    fireEvent.click(screen.getByRole("button", { name: "Sí, fui yo" }));
    await waitFor(() => expect(a.calls).toContainEqual(["confirmPairing", "p1", true]));
  });

  it("changing account needs the typed phrase", async () => {
    const a = fakeAgent();
    a.set(view({ state: "replace", replacePhrase: "REEMPLAZAR" }));
    renderConnect(a.ipc);
    const go = (await screen.findByRole("button", { name: "Cambiar de cuenta" })) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "REEMPLAZAR" } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(a.calls).toContainEqual(["confirmPairing", "p1", true, "REEMPLAZAR"]));
  });

  it.each(["expired", "declined", "cancelled", "rejected"] as const)(
    "after %s it explains and offers a new code",
    async (state) => {
      const a = fakeAgent();
      a.set(view({ state }));
      renderConnect(a.ipc);
      expect(await screen.findByRole("status")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Conectar esta computadora" })).toBeTruthy();
    },
  );

  it("hidden on a paired computer with nothing pending", async () => {
    const a = fakeAgent();
    const { container } = renderConnect(a.ipc, { status: "running" });
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector('[data-section="connect"]')).toBeNull();
  });

  it("while the agent starts, it says so instead of erroring", async () => {
    renderConnect({ ...unavailableIpc, pendingPairing: () => Promise.reject(new IpcUnavailableError()) });
    expect(await screen.findByText(/Preparando el agente/)).toBeTruthy();
  });
});
