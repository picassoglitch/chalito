import { AppId, DeviceSetup, WorkspaceLabel } from "@chalito/protocol";
import type { AgentConfig } from "./config.js";
import type { Policy } from "./policy/schema.js";

/** The four former providers keep their pins in their own config fields (config.ts). */
const LEGACY_PINS = { claude: "claude-code", codex: "codex", grok: "grok", gemini: "gemini" } as const;

/** Recipe kinds Chalito starts sessions with (the hub's START_ADAPTERS, the panel's pinnedSessionApps). */
export const SESSION_KINDS: ReadonlySet<string> = new Set(["claude-sdk", "codex", "acp"]);

/**
 * This computer's setup as the checklist sees it (First Run D, ADR 0028 §6): the app ids it has
 * pinned, how many folders it may work in, and their labels. Built from ids, counts and labels
 * only, so no path, hash or key can reach the cloud from here; the result is checked against
 * DeviceSetup (strict) before it's returned.
 */
export const deviceSetup = (
  c: Pick<AgentConfig, keyof typeof LEGACY_PINS | "appPins">,
  policy: Pick<Policy, "workspaces">,
  /** Whether this app can run sessions here ("Una IA"); a pinned desktop or terminal app doesn't count. */
  runsSessions: (appId: string) => boolean,
): DeviceSetup => {
  const ids = new Set<string>();
  for (const [field, appId] of Object.entries(LEGACY_PINS) as [keyof typeof LEGACY_PINS, string][])
    if (c[field] && runsSessions(appId)) ids.add(appId);
  for (const appId of Object.keys(c.appPins ?? {}))
    if (AppId.safeParse(appId).success && runsSessions(appId)) ids.add(appId);
  const labels = policy.workspaces
    .map((w) => WorkspaceLabel.safeParse(w.label))
    .flatMap((r) => (r.success ? [r.data] : []))
    .slice(0, 20);
  return DeviceSetup.parse({
    adapters: [...ids].sort().slice(0, 32),
    workspaces: Math.min(policy.workspaces.length, 1000),
    labels,
  });
};

/**
 * Reports the setup when it changed since the last report (the heartbeat calls this every few
 * minutes, and the policy and pin changes right away). A failed write is retried next time.
 */
export const setupReporter = (
  read: () => DeviceSetup,
  write: (setup: DeviceSetup) => Promise<void>,
): (() => Promise<void>) => {
  let last: string | null = null;
  return async () => {
    const s = read();
    const key = JSON.stringify(s);
    if (key === last) return;
    last = key;
    try {
      await write(s);
    } catch (err) {
      // Not sent: the next call sends it again.
      if (last === key) last = null;
      throw err;
    }
  };
};
