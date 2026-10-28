import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TextProviders } from "../src/lib/i18n.js";
import { IpcUnavailableError, unavailableIpc, type AgentIpc, type PendingPairing } from "../src/lib/ipc.js";
import type { AgentStatus } from "../src/lib/local-agent.js";
import { ConnectComputer, type AutoPair } from "../src/panel/ConnectComputer.js";

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
  opts: { status?: AgentStatus["state"]; locale?: "es" | "en"; opened?: string[]; auto?: AutoPair | null } = {},
) =>
  render(
    <TextProviders locale={opts.locale ?? "es"}>
      <ConnectComputer
        ipc={ipc}
        openUrl={async (u) => void opts.opened?.push(u)}
        agentStatus={async () => ({ state: opts.status ?? "not_paired" }) as AgentStatus}
        pollMs={20}
        auto={opts.auto ?? null}
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

  it("a failure that isn't the password prompt shows its code, not the password message", async () => {
    const a = fakeAgent();
    a.set(view({ state: "failed", computer: null, error: "pairing_failed" }));
    renderConnect(a.ipc, { locale: "en" });
    expect(await screen.findByText("Something failed (pairing_failed). Try again.")).toBeTruthy();
    expect(screen.queryByText(/password prompt/)).toBeNull();
    cleanup();
    a.set(view({ state: "failed", computer: null, error: "os_auth_failed" }));
    renderConnect(a.ipc, { locale: "en" });
    expect(await screen.findByText(/password prompt was cancelled/)).toBeTruthy();
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

describe("Conectar esta computadora, signed in (sign-in alone)", () => {
  const OWN = "11aa 22bb 33cc";
  /** The claim moves the agent to the reverse check with this panel's own key as the approver. */
  const autoFor = (a: ReturnType<typeof fakeAgent>, claimer = OWN) => {
    const claims: PendingPairing[] = [];
    const auto: AutoPair = {
      ownFingerprint: OWN,
      claim: async (p) => {
        claims.push(p);
        a.set(view({ state: "claimed", claimer: { fingerprint: claimer, passkeyId: null } }));
        return { ok: true };
      },
    };
    return { auto, claims };
  };

  it("connects by itself: starts, claims as this panel, says yes for its own key; no browser, nothing to tap", async () => {
    const a = fakeAgent();
    const { auto, claims } = autoFor(a);
    const opened: string[] = [];
    renderConnect(a.ipc, { auto, opened });
    await waitFor(() => expect(a.calls).toContainEqual(["confirmPairing", "p1", true]));
    expect(a.calls.filter((c) => c[0] === "startPairing")).toHaveLength(1);
    expect(claims).toHaveLength(1);
    expect(opened).toEqual([]);
    expect(screen.queryByRole("button", { name: "Sí, fui yo" })).toBeNull();
    expect(screen.getByText("Conectando esta computadora a tu cuenta…")).toBeTruthy();
    a.set(view({ state: "paired" }));
    await new Promise((r) => setTimeout(r, 80));
    expect(a.calls.filter((c) => c[0] === "confirmPairing")).toHaveLength(1);
  });

  it("an approver that isn't one of the account's devices is never confirmed by itself: the person answers", async () => {
    const a = fakeAgent();
    const { auto } = autoFor(a, "99aa 88bb");
    renderConnect(a.ipc, { auto: { ...auto, isAccountClient: async () => false } });
    expect(await screen.findByRole("button", { name: "Sí, fui yo" })).toBeTruthy();
    expect(a.calls.some((c) => c[0] === "confirmPairing")).toBe(false);
  });

  it("another device the person signed in on (the hub's approval page) is confirmed by itself", async () => {
    const a = fakeAgent();
    const { auto } = autoFor(a, "99aa 88bb");
    const asked: string[] = [];
    renderConnect(a.ipc, {
      auto: { ...auto, isAccountClient: async (fp) => (asked.push(fp), fp === "99aa 88bb") },
    });
    await waitFor(() => expect(a.calls).toContainEqual(["confirmPairing", "p1", true]));
    expect(asked).toEqual(["99aa 88bb"]);
    expect(screen.queryByRole("button", { name: "Sí, fui yo" })).toBeNull();
  });

  it("if claiming fails it says why and falls back to the approval page", async () => {
    const a = fakeAgent();
    const opened: string[] = [];
    const auto: AutoPair = { ownFingerprint: OWN, claim: async () => ({ ok: false, reason: "device_limit" }) };
    renderConnect(a.ipc, { auto, opened });
    expect(await screen.findByText(/No pude conectarla sola \(device_limit\)/)).toBeTruthy();
    await waitFor(() => expect(opened).toEqual([URL]));
  });

  it("signed out, it says that signing in is what connects this computer", async () => {
    const a = fakeAgent();
    renderConnect(a.ipc, { locale: "en" });
    expect(await screen.findByText(/Sign in first/)).toBeTruthy();
    expect(a.calls).toEqual([]);
  });
});
