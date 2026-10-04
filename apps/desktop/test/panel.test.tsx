import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalView, ChalitoClient, NotificationView, Snapshot } from "@chalito/client";
import { lintMessages } from "@chalito/brand";
import type { Locale } from "@chalito/protocol";
import { DEFAULT_SETTINGS, SETTINGS } from "@chalito/ui";
import es from "../messages/es.json";
import en from "../messages/en.json";
import { TextProviders } from "../src/lib/i18n.js";
import { unavailableIpc, type AgentIpc, type DevModeState } from "../src/lib/ipc.js";
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
    ...over,
  };
};

describe("panel: local-only security screens", () => {
  it("says the agent isn't reachable while the IPC server doesn't exist", async () => {
    renderPanel({ initialTab: "security" }, "en");
    await waitFor(() => expect(screen.getAllByText(/local agent isn't answering/)).toHaveLength(3));
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
