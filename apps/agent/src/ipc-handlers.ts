import { z } from "zod";
import { DevModeToggle, EnableableDevModeToggle, Provider, ScreenMode, SessionId } from "@chalito/protocol";
import type { LiabilityText } from "@chalito/config";
import type { ComputerControl } from "./computer/control.js";
import { COMPUTER_COPY, disableComputer, enableComputer } from "./computer/toggle.js";
import { DevMode, RISK_COPY, type DevModeDeps, type OsAuth } from "./devmode.js";
import { IpcError, type IpcHandlers } from "./ipc-server.js";
import type { ScreenManager } from "./screen/manager.js";
import { SCREEN_COPY, disableScreen, enableScreen } from "./screen/toggle.js";
import type { FilePolicyHolder } from "./policy-file.js";
import { policyRules } from "./policy-view.js";
import type { ProviderManager, ProviderResult } from "./providers.js";
import type { AgentStore } from "./store.js";

/** The agent version the panel's `ping` sees. */
export const AGENT_VERSION = "0.0.0";

const Toggle = z.object({ toggle: DevModeToggle });
/** Only what the CLI lets a person turn on (`chalito devmode on`). */
const OnToggle = z.object({ toggle: EnableableDevModeToggle });
const Enable = z.object({
  toggle: EnableableDevModeToggle,
  answers: z.object({
    first: z.boolean(),
    second: z.boolean(),
    liability: z.object({ checked: z.boolean(), typed: z.string().max(200) }),
  }),
});
const Presence = z.object({ desktopActive: z.boolean() });
/** The native poller always sends `indicatorShown` (the heartbeat); the panel reads without it. */
const ComputerBeat = z.object({ indicatorShown: z.boolean().optional() });
const ComputerKill = z.object({ via: z.enum(["hotkey", "tray", "panel", "indicator"]) });
const ComputerEnable = z.object({
  answers: z.object({ first: z.boolean(), second: z.boolean(), typed: z.string().max(200) }),
});
const ScreenEnable = z.object({
  mode: ScreenMode,
  answers: z.object({ first: z.boolean(), second: z.boolean(), typed: z.string().max(200) }),
});
const ScreenChallenge = z.object({ mode: ScreenMode });
const ScreenDisable = z.object({ what: z.enum(["control", "all"]) });
const ScreenClose = z.object({ sid: SessionId });
const ConfirmPairing = z.object({ pairingId: z.string().max(128), match: z.boolean() });
const ForProvider = z.object({ provider: Provider });
const ProviderKey = z.object({ provider: Provider, key: z.string().min(1).max(512) });

const parse = <T>(schema: z.ZodType<T>, params: unknown): T => {
  const r = schema.safeParse(params);
  if (!r.success) throw new IpcError("bad_params");
  return r.data;
};

export interface IpcDeps {
  policy: FilePolicyHolder;
  devMode: DevMode;
  /** The daemon's DevMode wiring (same store, chain and emitter); enabling swaps in the OS
   * check and the panel's answers. */
  devModeDeps: Omit<DevModeDeps, "osAuth" | "prompter">;
  osAuth: () => OsAuth;
  liability: LiabilityText;
  locale: () => "es" | "en";
  store: AgentStore;
  now: () => number;
  /** Reports the Developer-mode state to the account (device row + DeviceEvent), as the daemon does. */
  reportDevMode: () => Promise<void>;
  /** "Connect your AI" (providers.ts); absent in setups that don't manage providers. */
  providers?: ProviderManager;
  /** Computer control; null when this agent has no broker (it then never attaches the tools). */
  computer: ComputerControl | null;
  /** Remote screen; null without the desktop app. */
  screen?: ScreenManager | null;
  /** Agent audit trail (computer.enabled / computer.disabled). */
  audit: (type: string, meta: Record<string, unknown>) => void;
}

const providerCall = async (d: IpcDeps, run: (m: ProviderManager) => Promise<ProviderResult>) => {
  if (!d.providers) throw new IpcError("unavailable");
  const r = await run(d.providers);
  if (!r.ok) throw new IpcError(r.reason);
  return { ok: true };
};

/**
 * What the desktop panel asks of this agent (apps/desktop/src/lib/ipc.ts `AgentIpc`).
 *
 * Developer mode stays local-only with the CLI's rules: the agent asks the OS itself (password
 * or biometric) and re-checks the three answers, including the typed liability phrase. The panel
 * only carries the person's answers; it can't skip a step.
 *
 * The pairing reverse check happens in `chalito pair`'s own terminal (the daemon only runs once
 * paired), so there's never a pairing pending here.
 */
export const ipcHandlers = (d: IpcDeps): IpcHandlers => ({
  ping: async () => ({ version: AGENT_VERSION }),

  pendingPairing: async () => null,
  confirmPairing: async (params) => {
    parse(ConfirmPairing, params);
    throw new IpcError("no_pending_pairing");
  },

  policy: async () => ({
    seq: d.policy.seq,
    hash: d.policy.hash,
    prevHash: d.policy.prevHash,
    updatedAt: d.policy.updatedAt ?? 0,
    rules: policyRules(d.policy.get(), d.locale()),
  }),

  devMode: async () => d.devMode.state,

  devModeChallenge: async (params) => {
    const { toggle } = parse(OnToggle, params);
    const copy = RISK_COPY[d.liability.locale][toggle];
    return {
      toggle,
      examples: copy.examples,
      risk: copy.risk,
      liability: { version: d.liability.version, phrase: d.liability.phrase, text: d.liability.text },
    };
  },

  enableDevToggle: async (params) => {
    const { toggle, answers } = parse(Enable, params);
    const once = new DevMode({
      ...d.devModeDeps,
      osAuth: d.osAuth(),
      prompter: {
        first: async () => answers.first,
        second: async () => answers.second,
        liability: async () => answers.liability,
      },
    });
    const r = await once.enableToggle(toggle);
    if (r.ok) await d.reportDevMode();
    return r;
  },

  disableDevToggle: async (params) => {
    const { toggle } = parse(Toggle, params);
    const state = await d.devMode.toggleOff(toggle, "local");
    await d.reportDevMode();
    return state;
  },

  /**
   * The desktop app's poll (every 500 ms, from its native side): it shows the always-on-top
   * indicator while `active` isn't empty and reports whether it is on screen. Actions wait for
   * that report (computer/control.ts), so nothing acts without the indicator showing.
   */
  computerStatus: async (params) => {
    const { indicatorShown } = parse(ComputerBeat, params ?? {});
    if (!d.computer) return { enabled: d.policy.get().computer?.enabled === true, active: [], pending: [] };
    if (indicatorShown === undefined) return d.computer.status();
    // The native poller's view covers everything the indicator and the kill switch guard:
    // computer control AND remote screen (screen/manager.ts streams only while it's shown).
    const c = d.computer.heartbeat(indicatorShown);
    const sc = d.screen?.status();
    if (!sc) return c;
    return {
      enabled: c.enabled || sc.view,
      active: [...c.active, ...sc.active.map(({ sid, label, since }) => ({ sid, label, since }))],
      pending: [...c.pending, ...sc.pending.map(({ sid, label }) => ({ sid, label }))],
    };
  },

  /** The kill switch (global hotkey, tray item, indicator button, panel): ends control and remote screen now. */
  computerKill: async (params) => {
    const { via } = parse(ComputerKill, params);
    const computer = d.computer ? await d.computer.kill(via) : 0;
    const screen = d.screen ? await d.screen.kill(via) : 0;
    return { stopped: computer + screen };
  },

  // Remote screen: local-only enable with the CLI's rules (screen/toggle.ts), status, close.
  screenStatus: async () => {
    if (d.screen) return d.screen.status();
    const s = d.policy.get().screen;
    return { view: !!(s?.view || s?.control), control: !!s?.control, active: [], pending: [] };
  },
  screenChallenge: async (params) => {
    const { mode } = parse(ScreenChallenge, params);
    return SCREEN_COPY[d.locale()][mode];
  },
  enableScreen: async (params) => {
    const { mode, answers } = parse(ScreenEnable, params);
    return enableScreen(
      {
        policy: { get: () => d.policy.get(), set: (p, via) => d.policy.set(p, via) },
        osAuth: d.osAuth(),
        prompter: {
          first: async () => answers.first,
          second: async () => answers.second,
          typed: async () => answers.typed,
        },
        locale: d.locale(),
        emit: (type, meta) => d.audit(type, { ...meta, via: "panel" }),
      },
      mode,
    );
  },
  disableScreen: async (params) => {
    const { what } = parse(ScreenDisable, params ?? {});
    return {
      changed: await disableScreen(
        { policy: { get: () => d.policy.get(), set: (p, via) => d.policy.set(p, via) }, emit: (t, m) => d.audit(t, m) },
        what,
        "panel",
      ),
    };
  },
  closeScreen: async (params) => {
    const { sid } = parse(ScreenClose, params);
    if (!d.screen) throw new IpcError("unknown_session");
    const r = await d.screen.close(sid, "local");
    if (!r.ok) throw new IpcError(r.reason ?? "unknown_session");
    return { ok: true };
  },

  computerChallenge: async () => COMPUTER_COPY[d.locale()],

  /** Local-only enable, same rules as the CLI: the agent asks the OS itself and re-checks the answers. */
  enableComputer: async (params) => {
    const { answers } = parse(ComputerEnable, params);
    return enableComputer({
      policy: { get: () => d.policy.get(), set: (p, via) => d.policy.set(p, via) },
      osAuth: d.osAuth(),
      prompter: {
        first: async () => answers.first,
        second: async () => answers.second,
        typed: async () => answers.typed,
      },
      locale: d.locale(),
      emit: (type, meta) => d.audit(type, { ...meta, via: "panel" }),
    });
  },

  disableComputer: async () => ({
    changed: await disableComputer(
      { policy: { get: () => d.policy.get(), set: (p, via) => d.policy.set(p, via) }, emit: (t, m) => d.audit(t, m) },
      "panel",
    ),
  }),

  reportPresence: async (params) => {
    const { desktopActive } = parse(Presence, params);
    await d.store.updateDevice({ presence: { desktopActive }, lastSeenAt: d.now() });
  },

  // "IA conectadas": the same actions as the provider.* commands, from this computer. Here the
  // key arrives in plaintext over the local socket (never the network), and `installProvider` is
  // the person's local yes (the panel asks before calling it).
  providers: async () => {
    if (!d.providers) throw new IpcError("unavailable");
    return d.providers.view();
  },
  connectProviderKey: async (params) => {
    const { provider, key } = parse(ProviderKey, params);
    return providerCall(d, (m) => m.connectKey(provider, key));
  },
  signinProvider: async (params) => {
    const { provider } = parse(ForProvider, params);
    return providerCall(d, (m) => m.signin(provider));
  },
  disconnectProvider: async (params) => {
    const { provider } = parse(ForProvider, params);
    return providerCall(d, (m) => m.disconnect(provider));
  },
  installProvider: async (params) => {
    const { provider } = parse(ForProvider, params);
    return providerCall(d, (m) => m.install(provider));
  },
  declineProviderInstall: async (params) => {
    const { provider } = parse(ForProvider, params);
    if (!d.providers) throw new IpcError("unavailable");
    await d.providers.declineInstall(provider);
    return { ok: true };
  },
});
