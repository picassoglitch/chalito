import { z } from "zod";
import {
  AppId,
  RemotePermissionMode,
  DevModeToggle,
  EnableableDevModeToggle,
  PROVIDER_APP,
  Provider,
  ScreenMode,
  SessionId,
} from "@chalito/protocol";
import type { LiabilityText } from "@chalito/config";
import type { ComputerControl } from "./computer/control.js";
import { COMPUTER_COPY, disableComputer, enableComputer } from "./computer/toggle.js";
import { COORDINATOR_COPY, coordinatorCeiling, disableCoordinator, enableCoordinator } from "./coord/toggle.js";
import { DevMode, RISK_COPY, type DevModeDeps, type OsAuth } from "./devmode.js";
import { IpcError, type IpcHandlers } from "./ipc-server.js";
import { addWorkspace, removeWorkspace } from "./workspaces.js";
import type { ScreenManager } from "./screen/manager.js";
import { SCREEN_COPY, disableScreen, enableScreen } from "./screen/toggle.js";
import type { FilePolicyHolder } from "./policy-file.js";
import type { Policy } from "./policy/schema.js";
import { policyRules } from "./policy-view.js";
import type { AppCatalog } from "./apps/catalog.js";
import { CUSTOM_COPY, disableCustomRecipe, enableCustomRecipe, recipeSummary } from "./apps/custom-toggle.js";
import { disableAppSessions, enableAppSessions, sessionsApply, sessionsChallenge } from "./apps/sessions-toggle.js";
import type { AppManager, AppResult } from "./apps/manager.js";
import type { TerminalControl } from "./terminal/control.js";
import {
  RAW_SHELL_COPY,
  TERMINAL_COPY,
  disableRawShell,
  disableRemoteTerminal,
  enableRawShell,
  enableRemoteTerminal,
} from "./terminal/toggle.js";
import type { AgentStore } from "./store.js";
import type { CommandResult } from "./agent-core.js";
import type { CodeService } from "./code/service.js";
import { LINK_COPY, createLocalLink, type LinkManager } from "./links/index.js";
import { ownSessionHandlers, type OwnSessionsDeps } from "./watch/ipc.js";
import { RepoPattern, type PrWatch } from "./prs/watch.js";
import { meetingHandlers, type MeetingsFeature } from "./meetings/ipc.js";

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
const CoordinatorEnable = z.object({ answers: z.object({ confirm: z.boolean() }) });
const TerminalEnable = z.object({
  answers: z.object({
    first: z.boolean(),
    second: z.boolean(),
    typed: z.string().max(200),
    final: z.boolean().optional(),
  }),
});
const ScreenEnable = z.object({
  mode: ScreenMode,
  answers: z.object({ first: z.boolean(), second: z.boolean(), typed: z.string().max(200) }),
});
const ScreenChallenge = z.object({ mode: ScreenMode });
const ScreenDisable = z.object({ what: z.enum(["control", "all"]) });
const ScreenClose = z.object({ sid: SessionId });
const LinkModeParam = z.object({ mode: z.enum(["share", "handoff"]) });
const LinkAdd = z.object({
  /** Validated as an AgentLink by the manager (hand-off links are made only here). */
  link: z.record(z.string(), z.unknown()),
  answers: z.object({ confirm: z.boolean(), typed: z.string().max(200) }),
});
const PrWatchGet = z.object({ probe: z.boolean().optional() }).strict();
const PrWatchSet = z
  .object({
    enabled: z.boolean().optional(),
    allow: z.array(RepoPattern).max(50).optional(),
    deny: z.array(RepoPattern).max(50).optional(),
  })
  .strict();
const ForLink = z.object({ linkId: z.string().max(80) });
const LinkSend = z.object({
  fromSid: SessionId,
  linkId: z.string().max(80),
  text: z.string().min(1).max(20_000),
});
const CodeStart = z
  .object({
    appId: AppId,
    workspaceLabel: z.string().min(1).max(80),
    prompt: z.string().min(1).max(20_000),
    permissionMode: RemotePermissionMode.default("default"),
  })
  .strict();
const CodePrompt = z.object({ sid: SessionId, text: z.string().min(1).max(20_000) }).strict();
const ForSession = z.object({ sid: SessionId }).strict();
const CodeTransfer = z.object({ sid: SessionId, toDeviceId: z.string().min(1).max(128) }).strict();
const ConfirmPairing = z.object({ pairingId: z.string().max(128), match: z.boolean() });
const ForProvider = z.object({ provider: Provider });
const ProviderKey = z.object({ provider: Provider, key: z.string().min(1).max(512) });
const ForApp = z.object({ appId: AppId });
/** The sha256 the panel showed: the pin happens only if the file still hashes to it. */
const PinApp = z.object({ appId: AppId, sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const WorkspacePath = z.object({ path: z.string().min(1).max(4096) });
const WorkspaceLabel = z.object({ label: z.string().min(1).max(60) });
const AppKey = z.object({ appId: AppId, key: z.string().min(1).max(512) });
const CustomEnable = z.object({
  appId: AppId,
  answers: z.object({ review: z.boolean(), typed: z.string().max(80) }),
});

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
  /** The connect engine (apps/manager.ts); absent in setups that don't manage apps. */
  apps?: AppManager;
  /** Its catalog (custom recipes are enabled here, locally). */
  catalog?: AppCatalog;
  /** Computer control; null when this agent has no broker (it then never attaches the tools). */
  computer: ComputerControl | null;
  /** Remote terminal; null without the desktop app, like computer control. */
  terminal?: TerminalControl | null;
  /** Remote screen; null without the desktop app. */
  screen?: ScreenManager | null;
  /** Build flags (features.ts). Absent = off: the screen and terminal calls answer `remote_screen_off` / `remote_terminal_off`. */
  remote?: { screen?: boolean; terminal?: boolean };
  /** Agent-to-agent links (links/manager.ts); absent = the link calls answer `unavailable`. */
  links?: LinkManager | null;
  /** This device's public keys: the panel puts them in a link's own end and in the code it shows. */
  identity?: { deviceId: string; pubSign: string; pubBox: string };
  /** Agent audit trail (computer.enabled / computer.disabled, terminal.*, screen.*). */
  audit: (type: string, meta: Record<string, unknown>) => void;
  /** ~/.chalito: never a workspace. Absent = the workspace calls answer `unavailable`. */
  chalitoDir?: string;
  /** The person's home folder (default: the OS's); tests point it elsewhere. */
  home?: string;
  /** ADR 0031 §1: sessions started here ("Nueva sesión"); absent = the code calls answer `unavailable`. */
  code?: CodeService;
  /** Sessions the person started outside Chalito (opt-in, read-only); absent = those calls answer `unavailable`. */
  ownSessions?: OwnSessionsDeps | null;
  /** The person's GitHub PRs through their own `gh` (prs/watch.ts); absent = the PR calls answer `unavailable`. */
  prs?: PrWatch;
  /** Meeting warnings and follow-ups (meetings/); absent = those calls answer `unavailable`. */
  meetings?: MeetingsFeature;
}

const prsOf = (d: IpcDeps): PrWatch => {
  if (!d.prs) throw new IpcError("unavailable");
  return d.prs;
};

const codeOf = (d: IpcDeps): CodeService => {
  if (!d.code) throw new IpcError("unavailable");
  return d.code;
};
const codeResult = (r: CommandResult) => {
  if (!r.ok) throw new IpcError(r.reason ?? "internal");
  return { ok: true, ...(r.sid ? { sid: r.sid } : {}) };
};

const linksOf = (d: IpcDeps): LinkManager => {
  if (!d.links) throw new IpcError("unavailable");
  return d.links;
};

const terminalToggleDeps = (d: IpcDeps, answers: z.infer<typeof TerminalEnable>["answers"]) => ({
  policy: { get: () => d.policy.get(), set: (p: Policy, via: "local") => d.policy.set(p, via) },
  osAuth: d.osAuth(),
  prompter: {
    first: async () => answers.first,
    second: async () => answers.second,
    typed: async () => answers.typed,
    final: async () => answers.final === true,
  },
  locale: d.locale(),
  emit: (type: string, meta: Record<string, unknown>) => d.audit(type, { ...meta, via: "panel" }),
});

const appCall = async (d: IpcDeps, run: (m: AppManager) => Promise<AppResult>) => {
  if (!d.apps) throw new IpcError("unavailable");
  const r = await run(d.apps);
  if (!r.ok) throw new IpcError(r.reason);
  return { ok: true };
};

/** The panel's calls (desktop lib/ipc.ts). Developer mode re-checks the OS and all three answers here;
 * this daemon runs only once paired, so pairing calls are served earlier by pairing-host.ts. */
export const ipcHandlers = (d: IpcDeps): IpcHandlers => ({
  ...meetingHandlers(d.meetings),
  ping: async () => ({ version: AGENT_VERSION }),
  ...ownSessionHandlers(d.ownSessions),

  startPairing: async () => {
    throw new IpcError("already_paired");
  },
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

  /** The native side's 500 ms poll: it shows the indicator while `active` isn't empty and reports it
   * on screen; actions wait for that report (computer/control.ts). */
  computerStatus: async (params) => {
    const { indicatorShown } = parse(ComputerBeat, params ?? {});
    const computer = d.computer
      ? indicatorShown === undefined
        ? d.computer.status()
        : d.computer.heartbeat(indicatorShown)
      : { enabled: d.policy.get().computer?.enabled === true, active: [], pending: [] };
    // The native poller's view covers everything the indicator and the kill switch guard:
    // computer control AND remote screen (screen/manager.ts streams only while it's shown).
    const sc = d.computer && indicatorShown !== undefined ? d.screen?.status() : undefined;
    const withScreen = sc
      ? {
          enabled: computer.enabled || sc.view,
          active: [...computer.active, ...sc.active.map(({ sid, label, since }) => ({ sid, label, since }))],
          pending: [...computer.pending, ...sc.pending.map(({ sid, label }) => ({ sid, label }))],
        }
      : computer;
    // Remote terminals share the indicator and kill switch: open ones count as active, and
    // `terminal` says whether it's on so the native side holds the hotkey.
    const terminal = d.terminal
      ? indicatorShown === undefined
        ? d.terminal.status()
        : d.terminal.heartbeat(indicatorShown)
      : null;
    if (!terminal) return withScreen;
    return {
      ...withScreen,
      active: [...withScreen.active, ...terminal.active],
      terminal: { enabled: terminal.enabled, rawShell: terminal.rawShell, pending: terminal.pending },
    };
  },

  /** The kill switch (hotkey, tray, indicator, panel): ends control, terminals and remote screen now. */
  computerKill: async (params) => {
    const { via } = parse(ComputerKill, params);
    const computer = d.computer ? await d.computer.kill(via) : 0;
    const terminals = d.terminal ? await d.terminal.kill(via) : 0;
    const screen = d.screen ? await d.screen.kill(via) : 0;
    return { stopped: computer + terminals + screen };
  },

  // Remote screen: local-only enable with the CLI's rules (screen/toggle.ts), status, close.
  screenStatus: async () => {
    if (d.screen) return d.screen.status();
    const s = d.policy.get().screen;
    return { view: !!(s?.view || s?.control), control: !!s?.control, active: [], pending: [] };
  },
  screenChallenge: async (params) => {
    if (!d.remote?.screen) throw new IpcError("remote_screen_off");
    const { mode } = parse(ScreenChallenge, params);
    return SCREEN_COPY[d.locale()][mode];
  },
  enableScreen: async (params) => {
    if (!d.remote?.screen) throw new IpcError("remote_screen_off");
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

  /** The desktop panel's remote-terminal section (the indicator poll goes through computerStatus). */
  terminalStatus: async () =>
    d.terminal?.status() ?? {
      enabled: d.policy.get().remoteTerminal?.enabled === true,
      rawShell: d.policy.get().remoteTerminal?.rawShell === true && d.policy.get().remoteTerminal?.enabled === true,
      active: [],
      pending: [],
    },

  terminalChallenge: async () => {
    if (!d.remote?.terminal) throw new IpcError("remote_terminal_off");
    return { terminal: TERMINAL_COPY[d.locale()], rawShell: RAW_SHELL_COPY[d.locale()] };
  },

  /** Local-only enable, same rules as the CLI: the agent asks the OS itself and re-checks the answers. */
  enableRemoteTerminal: async (params) => {
    if (!d.remote?.terminal) throw new IpcError("remote_terminal_off");
    const { answers } = parse(TerminalEnable, params);
    return enableRemoteTerminal(terminalToggleDeps(d, answers));
  },

  /** The raw shell: its own, stronger confirmation (four answers, a longer phrase). */
  enableRawShell: async (params) => {
    if (!d.remote?.terminal) throw new IpcError("remote_terminal_off");
    const { answers } = parse(TerminalEnable, params);
    return enableRawShell(terminalToggleDeps(d, answers));
  },

  disableRemoteTerminal: async () => ({
    changed: await disableRemoteTerminal(
      { policy: { get: () => d.policy.get(), set: (p, via) => d.policy.set(p, via) }, emit: (t, m) => d.audit(t, m) },
      "panel",
    ),
  }),

  disableRawShell: async () => ({
    changed: await disableRawShell(
      { policy: { get: () => d.policy.get(), set: (p, via) => d.policy.set(p, via) }, emit: (t, m) => d.audit(t, m) },
      "panel",
    ),
  }),

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

  // Coordinator mode (ADR 0025 §6): the panel's switch. Same rules as the CLI: local only, the
  // agent asks the OS itself, then the person's answer to the list of what Chalito answers.
  coordinatorStatus: async () => ({ kinds: [...coordinatorCeiling(d.policy.get())] }),

  coordinatorChallenge: async () => COORDINATOR_COPY[d.locale()],

  enableCoordinator: async (params) => {
    const { answers } = parse(CoordinatorEnable, params);
    return enableCoordinator({
      policy: { get: () => d.policy.get(), set: (p, via) => d.policy.set(p, via) },
      osAuth: d.osAuth(),
      prompter: { confirm: async () => answers.confirm },
      locale: d.locale(),
      emit: (type, meta) => d.audit(type, { ...meta, via: "panel" }),
    });
  },

  disableCoordinator: async () => ({
    changed: await disableCoordinator(
      { policy: { get: () => d.policy.get(), set: (p, via) => d.policy.set(p, via) }, emit: (t, m) => d.audit(t, m) },
      "panel",
    ),
  }),

  reportPresence: async (params) => {
    const { desktopActive } = parse(Presence, params);
    await d.store.updateDevice({ presence: { desktopActive }, lastSeenAt: d.now() });
  },

  // "IA conectadas": the app.* commands from this computer. Keys come in plaintext over the local
  // socket only, and `installApp` is the person's local yes (the panel asks first).
  apps: async () => {
    if (!d.apps) throw new IpcError("unavailable");
    const sessions = d.policy.get().apps?.sessions ?? {};
    return {
      // `sessions`: whether the person allowed this app's sessions here (null: the four former
      // providers, which policy.adapters decides).
      apps: (await d.apps.view()).map((v) => ({
        ...v,
        sessions: sessionsApply(v.appId) ? sessions[v.appId] === true : null,
      })),
      // Custom files that didn't load: shown here only, never reported.
      problems: d.catalog?.custom().problems ?? [],
      catalog: d.catalog ? { source: d.catalog.source, issuedAt: d.catalog.issuedAt } : null,
    };
  },
  connectAppKey: async (params) => {
    const { appId, key } = parse(AppKey, params);
    return appCall(d, (m) => m.connectKey(appId, key));
  },
  signinApp: async (params) => {
    const { appId } = parse(ForApp, params);
    return appCall(d, (m) => m.signin(appId));
  },
  disconnectApp: async (params) => {
    const { appId } = parse(ForApp, params);
    return appCall(d, (m) => m.disconnect(appId));
  },
  installApp: async (params) => {
    const { appId } = parse(ForApp, params);
    return appCall(d, (m) => m.install(appId));
  },
  declineAppInstall: async (params) => {
    const { appId } = parse(ForApp, params);
    if (!d.apps) throw new IpcError("unavailable");
    await d.apps.declineInstall(appId);
    return { ok: true };
  },
  launchApp: async (params) => {
    const { appId } = parse(ForApp, params);
    return appCall(d, (m) => m.launch(appId));
  },

  /** What enabling a custom recipe shows (its commands), before the OS prompt. */
  customRecipeChallenge: async (params) => {
    const { appId } = parse(ForApp, params);
    const found = d.catalog?.custom().recipes.find((r) => r.recipe.id === appId);
    if (!found) throw new IpcError("unknown_recipe");
    const copy = CUSTOM_COPY[d.locale()];
    return {
      title: copy.title(found.recipe.name),
      warn: copy.warn,
      type: copy.type(appId),
      summary: recipeSummary(found.recipe),
    };
  },
  /** Local-only enable, like the CLI: the agent asks the OS itself and re-checks the answers. */
  enableCustomRecipe: async (params) => {
    const { appId, answers } = parse(CustomEnable, params);
    if (!d.catalog) throw new IpcError("unavailable");
    const r = await enableCustomRecipe(
      {
        policy: { get: () => d.policy.get(), set: (p, via) => d.policy.set(p, via) },
        catalog: d.catalog,
        osAuth: d.osAuth(),
        prompter: { review: async () => answers.review, typed: async () => answers.typed },
        locale: d.locale(),
        emit: (type, meta) => d.audit(type, { ...meta, via: "panel" }),
      },
      appId,
    );
    if (r.ok) await d.apps?.report(appId);
    return r;
  },
  disableCustomRecipe: async (params) => {
    const { appId } = parse(ForApp, params);
    const changed = await disableCustomRecipe(
      { policy: { get: () => d.policy.get(), set: (p, via) => d.policy.set(p, via) }, emit: (t, m) => d.audit(t, m) },
      appId,
      "panel",
    );
    if (changed) await d.apps?.report(appId);
    return { changed };
  },

  /** What allowing an app's sessions shows (its commands), before the OS prompt. */
  appSessionsChallenge: async (params) => {
    const { appId } = parse(ForApp, params);
    const c = d.catalog ? sessionsChallenge(d.catalog, d.locale(), appId) : null;
    if (!c) throw new IpcError("unknown_recipe");
    return c;
  },
  /** Local-only, like the CLI: the agent asks the OS itself and re-checks the answers. */
  enableAppSessions: async (params) => {
    const { appId, answers } = parse(CustomEnable, params);
    if (!d.catalog) throw new IpcError("unavailable");
    return enableAppSessions(
      {
        policy: { get: () => d.policy.get(), set: (p, via) => d.policy.set(p, via) },
        catalog: d.catalog,
        osAuth: d.osAuth(),
        prompter: { review: async () => answers.review, typed: async () => answers.typed },
        locale: d.locale(),
        emit: (type, meta) => d.audit(type, { ...meta, via: "panel" }),
      },
      appId,
    );
  },
  disableAppSessions: async (params) => {
    const { appId } = parse(ForApp, params);
    const changed = await disableAppSessions(
      { policy: { get: () => d.policy.get(), set: (p, via) => d.policy.set(p, via) }, emit: (t, m) => d.audit(t, m) },
      appId,
      "panel",
    );
    return { changed };
  },

  /** "Usar" / "se actualizó: confirmar": trust the app's CLI as the panel showed it (First Run C).
   * Local only (the panel's per-launch secret); remote commands never pin over a pin. */
  pinApp: async (params) => {
    const { appId, sha256 } = parse(PinApp, params);
    return appCall(d, (m) => m.pin(appId, sha256));
  },

  // ---- WORKSPACES (First Run C): the OS folder picker, then a local, OS-checked policy change ----
  workspaces: async () => ({ workspaces: d.policy.get().workspaces }),
  addWorkspace: async (params) => {
    const { path } = parse(WorkspacePath, params);
    if (!d.chalitoDir) throw new IpcError("unavailable");
    return addWorkspace(
      {
        policy: { get: () => d.policy.get(), set: (p, via) => d.policy.set(p, via) },
        osAuth: d.osAuth(),
        locale: d.locale(),
        chalitoDir: d.chalitoDir,
        ...(d.home ? { home: d.home } : {}),
        emit: (type, meta) => d.audit(type, { ...meta, via: "panel" }),
      },
      path,
    );
  },
  removeWorkspace: async (params) => {
    const { label } = parse(WorkspaceLabel, params);
    return {
      removed: await removeWorkspace(
        {
          policy: { get: () => d.policy.get(), set: (p, via) => d.policy.set(p, via) },
          emit: (type, meta) => d.audit(type, { ...meta, via: "panel" }),
        },
        label,
      ),
    };
  },

  // #30's provider methods, kept as aliases (older panels).
  providers: async () => {
    if (!d.apps) throw new IpcError("unavailable");
    const views = await d.apps.view();
    return Provider.options.flatMap((provider) => {
      const v = views.find((x) => x.appId === PROVIDER_APP[provider]);
      if (!v) return [];
      const { kind: _k, custom: _c, name: _n, ...doc } = v.doc;
      return [{ provider, doc, signinAllowed: v.signinAllowed, installRequestedUntil: v.installRequestedUntil }];
    });
  },
  connectProviderKey: async (params) => {
    const { provider, key } = parse(ProviderKey, params);
    return appCall(d, (m) => m.connectKey(PROVIDER_APP[provider], key));
  },
  signinProvider: async (params) => {
    const { provider } = parse(ForProvider, params);
    return appCall(d, (m) => m.signin(PROVIDER_APP[provider]));
  },
  disconnectProvider: async (params) => {
    const { provider } = parse(ForProvider, params);
    return appCall(d, (m) => m.disconnect(PROVIDER_APP[provider]));
  },
  installProvider: async (params) => {
    const { provider } = parse(ForProvider, params);
    return appCall(d, (m) => m.install(PROVIDER_APP[provider]));
  },
  declineProviderInstall: async (params) => {
    const { provider } = parse(ForProvider, params);
    if (!d.apps) throw new IpcError("unavailable");
    await d.apps.declineInstall(PROVIDER_APP[provider]);
    return { ok: true };
  },

  // ---- SESSIONS started here (ADR 0031 §1): origin `local`, every gate as for the phone ------
  codeApps: async () => codeOf(d).apps(),
  codeStart: async (params) => codeResult(await codeOf(d).start(parse(CodeStart, params))),
  codePrompt: async (params) => {
    const { sid, text } = parse(CodePrompt, params);
    return codeResult(await codeOf(d).prompt(sid, text));
  },
  codeStop: async (params) => codeResult(await codeOf(d).stop(parse(ForSession, params).sid)),
  codeTransfer: async (params) => {
    const { sid, toDeviceId } = parse(CodeTransfer, params);
    return codeResult(await codeOf(d).transfer(sid, toDeviceId));
  },

  // ---- LINKS (ADR 0022 §3): made only here for hand-off; revoked from anywhere --------------
  linkChallenge: async (params) => {
    const { mode } = parse(LinkModeParam, params);
    const copy = LINK_COPY[d.locale()];
    return { mode, summary: mode === "handoff" ? copy.handoff : copy.share, phrase: copy.phrase };
  },
  /** OS authentication here, then the person's confirmation and typed phrase from the panel. */
  linkAdd: async (params) => {
    const { link, answers } = parse(LinkAdd, params);
    return createLocalLink({
      links: linksOf(d),
      spec: link as never,
      osAuth: d.osAuth(),
      prompter: { confirm: async () => answers.confirm, typed: async () => answers.typed },
      locale: d.locale(),
    });
  },
  // `pendingPublish`: links the cloud mirror doesn't hold yet; nothing is delivered over them until it does.
  linkList: async () => ({
    links: linksOf(d).list(),
    pendingPublish: linksOf(d).pendingPublish(),
    self: d.identity ?? null,
  }),
  linkRevoke: async (params) => {
    const { linkId } = parse(ForLink, params);
    return { revoked: await linksOf(d).revoke(linkId, "local") };
  },
  linkRevokeAll: async () => ({ revoked: await linksOf(d).revokeAll("local") }),
  /** The owner hands the sending session's work to the other agent from the panel. */
  linkHandoff: async (params) => {
    const { fromSid, linkId, text } = parse(LinkSend, params);
    return linksOf(d).handoff({ fromSid, linkId, text });
  },
  linkShare: async (params) => {
    const { fromSid, linkId, text } = parse(LinkSend, params);
    return linksOf(d).share({ fromSid, linkId, parts: [{ text }] });
  },
  prWatch: async (params) => prsOf(d).view(parse(PrWatchGet, params ?? {}).probe === true),
  setPrWatch: async (params) => prsOf(d).configure(parse(PrWatchSet, params)),
});
