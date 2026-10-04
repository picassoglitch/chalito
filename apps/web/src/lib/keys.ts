import type { ClientKeys, StepUpProvider } from "@chalito/client";

export interface DeviceKeys {
  keys: ClientKeys;
  /**
   * Called only from a user gesture (the step-up dialog's confirm button), because WebAuthn
   * needs user activation. Returns null when the person cancels.
   */
  stepUp: StepUpProvider;
}

/**
 * This browser's device keys (packages/client-keys, m5-keys). Until that slice lands there are
 * none, so the live screens show "pair this device" instead of data. Never a stub here: the
 * dev/test stub lives in src/dev behind DEV_BACKEND.
 */
export const loadDeviceKeys = async (): Promise<DeviceKeys | null> => null;
