/**
 * First Run D (ADR 0028 §6): the setup checklist, derived only from real state, so it can't be
 * marked done by hand. Pure: the hub's SetupChecklist and the desktop panel's both render it.
 * Keep this file identical in the hub (src/lib/chalito/pkg/ui/setup.ts).
 */
export const SETUP_STEPS = ["account", "browser", "computer", "ai", "folder", "firstTask"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/** What one paired computer reported about itself (DeviceSetup; empty before it ever did). */
export interface SetupComputer {
  /** Pinned app ids, already narrowed to the ones that run sessions. */
  adapters: readonly string[];
  workspaces: number;
}

export interface SetupInput {
  /** Signed in to the Chalyb account. */
  signedIn: boolean;
  /** This browser (or the desktop app) is an approved device. */
  deviceReady: boolean;
  computers: readonly SetupComputer[];
  /** The account has a computer even though this device can't list it yet (a directory hint). */
  computerHint?: boolean;
  /** Sessions this account has run. */
  sessions: number;
}

export interface SetupState {
  steps: readonly { id: SetupStep; done: boolean }[];
  /** The first step still to do, or null when everything is done. */
  current: SetupStep | null;
  complete: boolean;
  doneCount: number;
}

/**
 * A session needs a pinned app and a folder, so a first task already run also proves those two
 * (and covers a computer whose agent is too old to report its setup).
 */
export const setupChecklist = (i: SetupInput): SetupState => {
  const ran = i.sessions > 0;
  const done: Record<SetupStep, boolean> = {
    account: i.signedIn,
    browser: i.signedIn && i.deviceReady,
    computer: i.signedIn && (i.computers.length > 0 || i.computerHint === true),
    ai: i.signedIn && (ran || i.computers.some((c) => c.adapters.length > 0)),
    folder: i.signedIn && (ran || i.computers.some((c) => c.workspaces > 0)),
    firstTask: i.signedIn && ran,
  };
  const steps = SETUP_STEPS.map((id) => ({ id, done: done[id] }));
  const current = steps.find((s) => !s.done)?.id ?? null;
  return { steps, current, complete: current === null, doneCount: steps.filter((s) => s.done).length };
};
