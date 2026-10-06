import { createRequire } from "node:module";
import type { ProcessRunner } from "../runner.js";
import { which } from "../runner.js";

/**
 * The native layer: screen capture and window listing through `node-screenshots` (napi-rs
 * bindings of the `xcap` crate), mouse and keyboard through `@jitsi/robotjs` (N-API prebuilds).
 * Both are loaded lazily, only when a granted session first acts, so an agent that never uses
 * computer control never loads them. Everything above this file talks to `NativeDriver`, which
 * the tests replace.
 */

export interface DisplayInfo {
  /** Index in `displays()`; the primary display is 0. */
  index: number;
  name: string;
  /** Position and size in the input layer's coordinates (where `move` puts the pointer). */
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  primary: boolean;
}

export interface WindowInfo {
  id: number;
  pid: number;
  app: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  focused: boolean;
  minimized: boolean;
}

export type MouseButton = "left" | "right" | "middle";

export interface NativeDriver {
  displays(): DisplayInfo[];
  /** Full-resolution RGBA capture of one display. */
  capture(index: number): Promise<{ width: number; height: number; rgba: Uint8Array }>;
  move(x: number, y: number): void;
  click(button: MouseButton, double: boolean): void;
  button(down: boolean, button: MouseButton): void;
  scroll(dx: number, dy: number): void;
  /** Types a short piece of text; the caller chunks long text so the kill switch can cut in. */
  type(text: string): void;
  key(key: string, modifiers: string[]): void;
  windows(): WindowInfo[];
  focus(win: WindowInfo): Promise<void>;
}

/** Why computer control can't run on this machine; the model and the panel see `message`. */
export class ComputerUnsupportedError extends Error {
  constructor(
    readonly code: "wayland" | "native_missing" | "platform" | "focus_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ComputerUnsupportedError";
  }
}

export const WAYLAND_MESSAGE =
  "Computer control needs an X11 session on Linux. This is a Wayland session, which doesn't let apps " +
  "read the screen or move the pointer of other apps. Log in with an X11 (Xorg) session to use it.";

/** Wayland sessions can't be driven (no global input injection, screen capture only through the portal). */
export const isWayland = (env: Record<string, string | undefined>, platform: NodeJS.Platform) =>
  platform === "linux" && (env.XDG_SESSION_TYPE === "wayland" || (!!env.WAYLAND_DISPLAY && !env.DISPLAY));

/** macOS: where the person grants the two permissions computer control needs (opened by the desktop panel). */
export const MAC_PERMISSION_HINT =
  "On macOS, allow Chalito in System Settings → Privacy & Security → Screen Recording and → Accessibility, " +
  "then reopen Chalito.";

interface RobotJs {
  moveMouse(x: number, y: number): void;
  mouseClick(button?: string, double?: boolean): void;
  mouseToggle(down?: string, button?: string): void;
  scrollMouse(x: number, y: number): void;
  typeString(s: string): void;
  keyTap(key: string, modifier?: string | string[]): void;
  getScreenSize(): { width: number; height: number };
  setMouseDelay(ms: number): void;
  setKeyboardDelay(ms: number): void;
}
interface ScreenshotsModule {
  Monitor: {
    all(): {
      name(): string;
      x(): number;
      y(): number;
      width(): number;
      height(): number;
      scaleFactor(): number;
      isPrimary(): boolean;
      captureImage(): Promise<{ width: number; height: number; toRaw(copy?: boolean): Promise<Buffer> }>;
    }[];
  };
  Window: {
    all(): {
      id(): number;
      pid(): number;
      appName(): string;
      title(): string;
      x(): number;
      y(): number;
      width(): number;
      height(): number;
      isMinimized(): boolean;
      isFocused(): boolean;
    }[];
  };
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Raises a window by OS tool, called by absolute name with a numeric id only (no shell). */
export const focusCommand = (
  platform: NodeJS.Platform,
  win: WindowInfo,
  env: Record<string, string | undefined>,
): { cmd: string; args: string[] } => {
  if (!Number.isSafeInteger(win.pid) || !Number.isSafeInteger(win.id))
    throw new ComputerUnsupportedError("focus_unavailable", "Bad window id.");
  switch (platform) {
    case "darwin":
      return {
        cmd: "/usr/bin/osascript",
        args: [
          "-e",
          `tell application "System Events" to set frontmost of (first process whose unix id is ${win.pid}) to true`,
        ],
      };
    case "win32":
      return {
        cmd: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$null = (New-Object -ComObject WScript.Shell).AppActivate(${win.pid})`,
        ],
      };
    case "linux": {
      const xdotool = which("xdotool", env, platform);
      if (xdotool) return { cmd: xdotool, args: ["windowactivate", String(win.id)] };
      const wmctrl = which("wmctrl", env, platform);
      if (wmctrl) return { cmd: wmctrl, args: ["-i", "-a", `0x${win.id.toString(16)}`] };
      throw new ComputerUnsupportedError(
        "focus_unavailable",
        "Focusing windows on Linux needs `xdotool` or `wmctrl` installed. Click the window instead.",
      );
    }
    default:
      throw new ComputerUnsupportedError("platform", `Computer control isn't available on ${platform}.`);
  }
};

/**
 * The real driver. Throws ComputerUnsupportedError on Wayland, on unsupported platforms, or
 * when the native modules aren't in this build.
 */
export const loadNativeDriver = (opts: {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  runner: ProcessRunner;
}): NativeDriver => {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  if (!["darwin", "win32", "linux"].includes(platform))
    throw new ComputerUnsupportedError("platform", `Computer control isn't available on ${platform}.`);
  if (isWayland(env, platform)) throw new ComputerUnsupportedError("wayland", WAYLAND_MESSAGE);

  const require = createRequire(import.meta.url);
  let robot: RobotJs;
  let shots: ScreenshotsModule;
  try {
    robot = require("@jitsi/robotjs") as RobotJs;
    shots = require("node-screenshots") as ScreenshotsModule;
  } catch (err) {
    throw new ComputerUnsupportedError(
      "native_missing",
      `This Chalito build can't drive the screen (${err instanceof Error ? cut(err.message, 120) : "native module missing"}).`,
    );
  }
  robot.setMouseDelay(2);
  robot.setKeyboardDelay(2);

  const monitors = () => {
    const all = shots.Monitor.all();
    // Primary first, so display 0 is always the main screen.
    return [...all.filter((m) => m.isPrimary()), ...all.filter((m) => !m.isPrimary())];
  };

  return {
    displays: () => {
      const input = robot.getScreenSize();
      return monitors().map((m, index) => {
        // The input layer and the capture library may disagree on units (points vs pixels on
        // HiDPI); the primary display uses robotjs's own size, others are scaled to match it.
        const primary = m.isPrimary();
        const ratio = primary || m.width() === 0 ? 1 : input.width / Math.max(1, monitors()[0]!.width());
        return {
          index,
          name: cut(m.name(), 80),
          x: primary ? 0 : Math.round(m.x() * ratio),
          y: primary ? 0 : Math.round(m.y() * ratio),
          width: primary ? input.width : Math.round(m.width() * ratio),
          height: primary ? input.height : Math.round(m.height() * ratio),
          scaleFactor: m.scaleFactor(),
          primary,
        };
      });
    },
    capture: async (index) => {
      const m = monitors()[index];
      if (!m) throw new Error("no such display");
      const img = await m.captureImage();
      return { width: img.width, height: img.height, rgba: await img.toRaw() };
    },
    move: (x, y) => robot.moveMouse(x, y),
    click: (button, double) => robot.mouseClick(button, double),
    button: (down, button) => robot.mouseToggle(down ? "down" : "up", button),
    scroll: (dx, dy) => robot.scrollMouse(dx, dy),
    type: (text) => robot.typeString(text),
    key: (key, modifiers) => robot.keyTap(key, modifiers),
    windows: () =>
      shots.Window.all()
        .slice(0, 100)
        .map((w) => ({
          id: w.id(),
          pid: w.pid(),
          app: cut(w.appName(), 80),
          title: cut(w.title(), 200),
          x: w.x(),
          y: w.y(),
          width: w.width(),
          height: w.height(),
          focused: w.isFocused(),
          minimized: w.isMinimized(),
        })),
    focus: async (win) => {
      const { cmd, args } = focusCommand(platform, win, env);
      const res = await opts.runner.run(cmd, args);
      if (res.code !== 0)
        throw new ComputerUnsupportedError(
          "focus_unavailable",
          platform === "darwin" ? `Couldn't focus the window. ${MAC_PERMISSION_HINT}` : "Couldn't focus the window.",
        );
    },
  };
};
