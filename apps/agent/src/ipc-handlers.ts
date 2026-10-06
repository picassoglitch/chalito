import { z } from "zod";
import { AppId, DevModeToggle, EnableableDevModeToggle, PROVIDER_APP, Provider } from "@chalito/protocol";
import type { LiabilityText } from "@chalito/config";
import type { ComputerControl } from "./computer/control.js";
import { COMPUTER_COPY, disableComputer, enableComputer } from "./computer/toggle.js";
import { DevMode, RISK_COPY, type DevModeDeps, type OsAuth } from "./devmode.js";
import { IpcError, type IpcHandlers } from "./ipc-server.js";
import type { FilePolicyHolder } from "./policy-file.js";
import { policyRules } from "./policy-view.js";
import type { AppCatalog } from "./apps/catalog.js";
import { CUSTOM_COPY, disableCustomRecipe, enableCustomRecipe, recipeSummary } from "./apps/custom-toggle.js";
import type { AppManager, AppResult } from "./apps/manager.js";
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
const ConfirmPairing = z.object({ pairingId: z.string().max(128), match: z.boolean() });
const ForProvider = z.object({ provider: Provider });
const ProviderKey = z.object({ provider: Provider, key: z.string().min(1).max(512) });
const ForApp = z.object({ appId: AppId });
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
  /** Agent audit trail (computer.enabled / computer.disabled). */
  audit: (type: string, meta: Record<string, unknown>) => void;
}

const appCall = async (d: IpcDeps, run: (m: AppManager) => Promise<AppResult>) => {
  if (!d.apps) throw new IpcError("unavailable");
  const r = await run(d.apps);
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
    if (d.computer) return indicatorShown === undefined ? d.computer.status() : d.computer.heartbeat(indicatorShown);
    return { enabled: d.policy.get().computer?.enabled === true, active: [], pending: [] };
  },

  /** The kill switch (global hotkey, tray item, indicator button, panel): ends control now. */
  computerKill: async (params) => {
    const { via } = parse(ComputerKill, params);
    return { stopped: d.computer ? await d.computer.kill(via) : 0 };
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

  // "IA conectadas" (the catalog view): the same actions as the app.* commands, from this
  // computer. Here the key arrives in plaintext over the local socket (never the network), and
  // `installApp` is the person's local yes (the panel asks before calling it).
  apps: async () => {
    if (!d.apps) throw new IpcError("unavailable");
    return {
      apps: await d.apps.view(),
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
});
