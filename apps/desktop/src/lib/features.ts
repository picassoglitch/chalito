/**
 * Build flags for the dormant remote features (same names as the agent's). Off unless the
 * build sets the variable to exactly "1"; Vite bakes them at build time, and tests flip them.
 */
export const remoteScreenOn = (): boolean => import.meta.env.VITE_CHALITO_REMOTE_SCREEN === "1";

export const remoteTerminalOn = (): boolean => import.meta.env.VITE_CHALITO_REMOTE_TERMINAL === "1";
