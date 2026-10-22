/**
 * Build flags for the dormant remote features. Both default off: the code stays, the agent
 * refuses the commands and no surface shows them.
 *
 * Release builds (`__CHALITO_RELEASE__`, set by scripts/build.ts) take the value baked at build
 * time and ignore the environment, so a user cannot turn them on from a shell, unit or plist.
 * Dev and test builds read CHALITO_REMOTE_SCREEN / CHALITO_REMOTE_TERMINAL ("1" only).
 */
export type Env = Record<string, string | undefined>;

declare const __CHALITO_RELEASE__: boolean | undefined;
declare const __CHALITO_REMOTE_SCREEN__: boolean | undefined;
declare const __CHALITO_REMOTE_TERMINAL__: boolean | undefined;

const isRelease = (): boolean => typeof __CHALITO_RELEASE__ !== "undefined" && __CHALITO_RELEASE__ === true;

export const remoteScreenOn = (env: Env = process.env): boolean =>
  isRelease()
    ? typeof __CHALITO_REMOTE_SCREEN__ !== "undefined" && __CHALITO_REMOTE_SCREEN__ === true
    : env.CHALITO_REMOTE_SCREEN === "1";

/** Remote terminal and the raw shell. */
export const remoteTerminalOn = (env: Env = process.env): boolean =>
  isRelease()
    ? typeof __CHALITO_REMOTE_TERMINAL__ !== "undefined" && __CHALITO_REMOTE_TERMINAL__ === true
    : env.CHALITO_REMOTE_TERMINAL === "1";
