import { z } from "zod";
import { DevModeToggle, EnableableDevModeToggle, Provider } from "@chalito/protocol";
import type { LiabilityText } from "@chalito/config";
import { DevMode, RISK_COPY, type DevModeDeps, type OsAuth } from "./devmode.js";
import { IpcError, type IpcHandlers } from "./ipc-server.js";
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
