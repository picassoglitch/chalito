import { z } from "zod";
import { AppId } from "./recipe.js";

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

/**
 * chalito.devices.presence, written only by the device itself. A presence-only update doesn't
 * fan out to every phone (migration 20261004000700), so clients see it on their next pull.
 */
export const DevicePresence = z
  .object({
    /** The desktop app is in use (escalation skips the phone then). */
    desktopActive: z.boolean().optional(),
    setup: DeviceSetup.optional(),
  })
  .strict();
export type DevicePresence = z.infer<typeof DevicePresence>;
