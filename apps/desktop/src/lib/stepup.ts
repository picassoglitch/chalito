import type { ApprovalView } from "@chalito/client";

/** What the panel needs from the WebAuthn global (injected in tests). */
export interface PlatformAuthenticatorProbe {
  isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
}

/**
 * Capability detection, never a user-agent sniff (WebKitGTK on Linux has no platform
 * authenticator; WebView2 and WKWebView may).
 */
export const platformAuthenticatorAvailable = async (
  probe: PlatformAuthenticatorProbe | undefined = (globalThis as { PublicKeyCredential?: PlatformAuthenticatorProbe })
    .PublicKeyCredential,
): Promise<boolean> => {
  if (typeof probe?.isUserVerifyingPlatformAuthenticatorAvailable !== "function") return false;
  try {
    return (await probe.isUserVerifyingPlatformAuthenticatorAvailable()) === true;
  } catch {
    return false;
  }
};

/** The same rule ClientActions.decide applies before asking for a step-up. */
export const needsStepUp = (a: Pick<ApprovalView, "risk" | "stepUpRequired">): boolean =>
  a.stepUpRequired || a.risk === "HIGH" || a.risk === "CRITICAL";
