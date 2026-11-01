import { z } from "zod";
import { AppId, AppState } from "./recipe.js";

/** Public connection status only. Credentials and local paths stay on the tool's computer. */
export const DeviceTool = z
  .object({
    appId: AppId,
    name: z.string().min(1).max(120),
    state: AppState,
    installed: z.boolean(),
    signinAllowed: z.boolean(),
    sessionCapable: z.boolean(),
    sessionEnabled: z.boolean(),
  })
  .strict();
export type DeviceTool = z.infer<typeof DeviceTool>;

/**
 * A workspace label as the person named it (the folder's name, made unique: "proyecto-2"). Never
 * a path: no slash or backslash, no "~", no drive letter, not "." or "..". Trimmed; no control,
 * bidi or zero-width characters (they'd hide what's shown). Labels already travel in session rows.
 */
export const WorkspaceLabel = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine(
    (s) =>
      !/[\\/]/.test(s) &&
      !s.startsWith("~") &&
      !/^[A-Za-z]:/.test(s) &&
      s !== "." &&
      s !== ".." &&
      !/[\p{Cc}\p{Cf}]/u.test(s),
    { message: "a workspace label, not a path" },
  );

/**
 * What a computer reports about its own setup (First Run D, ADR 0028 §6), so the checklist reads
 * real state: the apps it has pinned, how many folders it may work in, and their labels (to offer
 * the first task in one). Never paths, hashes or keys.
 */
export const DeviceSetup = z
  .object({
    adapters: z.array(AppId).max(32),
    workspaces: z.number().int().min(0).max(1000),
    labels: z.array(WorkspaceLabel).max(20),
  })
  .strict();
export type DeviceSetup = z.infer<typeof DeviceSetup>;
/** Sent beside `setup`, not inside it: released clients parse `setup` strictly and would drop it all. */
export const DeviceTools = z.array(DeviceTool).max(64);
/** The setup as clients use it. `tools` is absent on older agents; a website being available is not a connected tool. */
export type DeviceSetupView = DeviceSetup & { tools?: DeviceTool[] };

/** New agents report actual account state and session permission; older ones report pinned ids. */
/** What a computer that never reported its setup (an older agent) was always offered; it still checks on its side. */
export const LEGACY_START_APPS: readonly string[] = ["claude-code", "codex"];

/** The apps to offer for a start on that computer: its report, or the legacy pair when it never reported. */
export const startableApps = (setup: DeviceSetupView | null | undefined): string[] =>
  setup ? readySessionApps(setup) : [...LEGACY_START_APPS];

export const readySessionApps = (setup: DeviceSetupView | null | undefined): string[] => {
  const reported = new Map((setup?.tools ?? []).map((tool) => [tool.appId, tool]));
  const ready = [...reported.values()]
    .filter(
      (tool) =>
        tool.sessionCapable && tool.sessionEnabled && (tool.state === "connected" || tool.state === "available"),
    )
    .map((tool) => tool.appId);
  // An app with no report yet (agent just started, or an older agent) keeps the pinned list's answer.
  const unreported = (setup?.adapters ?? []).filter((appId) => !reported.has(appId));
  return [...new Set([...ready, ...unreported])];
};

/**
 * chalito.devices.presence, written only by the device itself. A presence-only update doesn't
 * fan out to every phone (migration 20261004000700), so clients see it on their next pull.
 */
export const DevicePresence = z
  .object({
    /** The desktop app is in use (escalation skips the phone then). */
    desktopActive: z.boolean().optional(),
    setup: DeviceSetup.optional(),
    tools: DeviceTools.optional(),
  })
  .strict();
export type DevicePresence = z.infer<typeof DevicePresence>;
