/**
 * Build flags for the dormant remote features (same names as the agent's). Off unless the
 * build sets the variable to exactly "1"; read at render time so tests can flip it.
 */
export const remoteScreenOn = (): boolean => import.meta.env.VITE_CHALITO_REMOTE_SCREEN === "1";
