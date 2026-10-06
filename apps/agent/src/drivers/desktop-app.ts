import type { Launcher } from "./launcher.js";
import type {
  AppDriverContext as DriverContext,
  AppLaunchDriver,
  AppLaunchResult,
  LaunchableRecipe,
} from "./app-launch.js";

/**
 * Desktop AI apps (`desktop-app` recipes: ChatGPT, Claude, Cursor, LM Studio…): open the app on
 * this computer, or bring it forward when it is already running. The person signs in inside the
 * app itself; Chalito never touches its credentials.
 *
 *   macOS    `/usr/bin/open -a <app>` or `-b <bundle id>` (open focuses a running app)
 *   Windows  `explorer.exe shell:AppsFolder\<AppUserModelID>` (Store/MSIX apps) or the exe path
 *   Linux    the recipe's launch command, resolved on PATH, or its first detect command
 *
 * Always by absolute path with an argument list, never a shell.
 */

const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/;
const AUMID = /^[A-Za-z0-9][A-Za-z0-9._!-]{0,199}$/;
const APP_NAME = /^[^-/\\\0][^/\\\0]{0,99}$/;

export const platformKey = (p: NodeJS.Platform): "mac" | "windows" | "linux" | null =>
  p === "darwin" ? "mac" : p === "win32" ? "windows" : p === "linux" ? "linux" : null;

/** The command that opens this recipe's app here, or why there is none. */
export const desktopLaunchCommand = (
  recipe: LaunchableRecipe,
  ctx: Pick<DriverContext, "platform" | "env">,
  launcher: Pick<Launcher, "exists" | "which">,
): { cmd: string; args: string[] } | { error: "unsupported_platform" | "bad_recipe" | "not_installed" } => {
  const key = platformKey(ctx.platform);
  const plat = key ? recipe.platforms[key] : undefined;
  if (!key || !plat) return { error: "unsupported_platform" };
  const resolveCmd = (name: string): string | null =>
    name.includes("/") || name.includes("\\") ? (launcher.exists(name) ? name : null) : launcher.which(name);
  switch (key) {
    case "mac": {
      if (plat.launch?.app) {
        if (!APP_NAME.test(plat.launch.app)) return { error: "bad_recipe" };
        return { cmd: "/usr/bin/open", args: ["-a", plat.launch.app] };
      }
      const bundle = recipe.driver.desktopApp?.bundleId ?? plat.detect?.bundleIds?.[0];
      if (bundle) {
        if (!BUNDLE_ID.test(bundle)) return { error: "bad_recipe" };
        return { cmd: "/usr/bin/open", args: ["-b", bundle] };
      }
      break;
    }
    case "windows": {
      const aumid = plat.detect?.appUserModelIds?.[0];
      if (aumid) {
        if (!AUMID.test(aumid)) return { error: "bad_recipe" };
        const root = ctx.env.SYSTEMROOT ?? ctx.env.WINDIR ?? "C:\\Windows";
        return { cmd: `${root}\\explorer.exe`, args: [`shell:AppsFolder\\${aumid}`] };
      }
      const exe = recipe.driver.desktopApp?.exe;
      if (exe) return launcher.exists(exe) ? { cmd: exe, args: [] } : { error: "not_installed" };
      break;
    }
    case "linux":
      break;
  }
  // A launch command (any platform), then the first detect command.
  const command = plat.launch?.command;
  if (command && command.length > 0) {
    const cmd = resolveCmd(command[0]!);
    return cmd ? { cmd, args: command.slice(1).map(String) } : { error: "not_installed" };
  }
  const detected = plat.detect?.commands?.[0];
  if (detected) {
    const cmd = resolveCmd(detected);
    return cmd ? { cmd, args: [] } : { error: "not_installed" };
  }
  return { error: "bad_recipe" };
};

export class DesktopAppDriver implements AppLaunchDriver {
  constructor(
    private readonly ctx: DriverContext,
    private readonly launcher: Launcher,
  ) {}

  async launch(recipe: LaunchableRecipe): Promise<AppLaunchResult> {
    const c = desktopLaunchCommand(recipe, this.ctx, this.launcher);
    if ("error" in c) return { ok: false, reason: c.error };
    const r = await this.launcher.spawnDetached(c.cmd, c.args);
    return r.ok ? { ok: true } : { ok: false, reason: "launch_failed" };
  }
}
