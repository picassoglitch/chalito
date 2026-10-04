import type { DownloadOs } from "./manifest.js";

/**
 * Which installer to offer first on /descargar. A download page has to look at the platform
 * (there's no capability to probe), and it's only a default: the person can switch.
 */
export type DetectedPlatform = DownloadOs | "ios" | "android" | "unknown";

export interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  /** User-Agent Client Hints (Chromium). */
  userAgentData?: { platform?: string; mobile?: boolean };
  maxTouchPoints?: number;
}

export const detectPlatform = (nav: NavigatorLike | undefined): DetectedPlatform => {
  if (!nav) return "unknown";
  const hint = nav.userAgentData?.platform?.toLowerCase() ?? "";
  const ua = nav.userAgent?.toLowerCase() ?? "";
  const plat = nav.platform?.toLowerCase() ?? "";
  if (hint === "android" || ua.includes("android")) return "android";
  // iPadOS 13+ reports itself as a Mac; touch points give it away.
  if (
    /iphone|ipad|ipod/.test(ua) ||
    ((plat === "macintel" || ua.includes("macintosh")) && (nav.maxTouchPoints ?? 0) > 1)
  )
    return "ios";
  if (hint === "windows" || ua.includes("windows")) return "windows";
  if (hint === "macos" || ua.includes("mac os x") || ua.includes("macintosh")) return "macos";
  if (hint === "linux" || hint === "chrome os" || ua.includes("linux") || ua.includes("cros")) return "linux";
  return "unknown";
};
