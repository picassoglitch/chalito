/**
 * Build flags for the dormant remote features. Both default off: the code stays, the agent
 * refuses the commands and no surface shows them. Turn on only with the exact value "1".
 */
export type Env = Record<string, string | undefined>;

export const remoteScreenOn = (env: Env = process.env): boolean => env.CHALITO_REMOTE_SCREEN === "1";
