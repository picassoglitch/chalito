import { z } from "zod";

/**
 * The computer-control tools the local MCP server offers (mcp-server.ts). Coordinates are in the
 * pixels of the screenshot the model last saw for that display: screenshots are downscaled to fit
 * SCREENSHOT_MAX, and the broker maps them back to the screen (control.ts `toScreen`).
 *
 * One schema per tool, used three ways: the MCP `inputSchema` (JSON Schema, generated here), the
 * broker's validation of every call before anything native runs, and the tests.
 */

/** MCP server name. Claude Code names its tools `mcp__chalito_computer__<tool>`. */
export const COMPUTER_SERVER = "chalito_computer";
export const COMPUTER_TOOL_PREFIX = `mcp__${COMPUTER_SERVER}__`;

/** Screenshots fit in this box (aspect kept, never upscaled): legible, and small enough for the model. */
export const SCREENSHOT_MAX = { width: 1280, height: 800 } as const;
export const TYPE_TEXT_MAX = 2000;
export const WAIT_MAX_MS = 10_000;

const Coord = z.number().int().min(0).max(20_000);
const Display = z
  .number()
  .int()
  .min(0)
  .max(64)
  .optional()
  .describe("Display index from `screenshot` (default: 0, the primary)");
const Button = z.enum(["left", "right", "middle"]).default("left");
const AppId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,40}$/)
  .describe("An app id from `list_apps`");

/** Keys `key` accepts besides single letters and digits. */
export const NAMED_KEYS = [
  "enter",
  "escape",
  "tab",
  "backspace",
  "delete",
  "space",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "insert",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
] as const;
export const MODIFIERS = {
  ctrl: "control",
  control: "control",
  alt: "alt",
  option: "alt",
  shift: "shift",
  cmd: "command",
  command: "command",
  meta: "command",
  super: "command",
  win: "command",
} as const;

/** "ctrl+shift+t" → { key: "t", modifiers: ["control", "shift"] }, or null when it isn't a combo we send. */
export const parseCombo = (combo: string): { key: string; modifiers: string[] } | null => {
  const parts = combo
    .toLowerCase()
    .split("+")
    .map((p) => p.trim());
  if (parts.length === 0 || parts.length > 5 || parts.some((p) => p === "")) return null;
  const key = parts.at(-1)!;
  const mods = parts.slice(0, -1);
  const modifiers: string[] = [];
  for (const m of mods) {
    const mapped = (MODIFIERS as Record<string, string>)[m];
    if (!mapped || modifiers.includes(mapped)) return null;
    modifiers.push(mapped);
  }
  const named = (NAMED_KEYS as readonly string[]).includes(key);
  const aliased = key === "return" ? "enter" : key === "esc" ? "escape" : null;
  if (!named && !aliased && !/^[a-z0-9]$/.test(key)) return null;
  return { key: aliased ?? key, modifiers };
};

export const ToolArgs = {
  screenshot: z.object({ display: Display }).strict(),
  mouse_move: z.object({ x: Coord, y: Coord, display: Display }).strict(),
  click: z
    .object({ x: Coord.optional(), y: Coord.optional(), button: Button, display: Display })
    .strict()
    .refine((a) => (a.x === undefined) === (a.y === undefined), { message: "give both x and y, or neither" }),
  double_click: z
    .object({ x: Coord.optional(), y: Coord.optional(), display: Display })
    .strict()
    .refine((a) => (a.x === undefined) === (a.y === undefined), { message: "give both x and y, or neither" }),
  drag: z.object({ fromX: Coord, fromY: Coord, toX: Coord, toY: Coord, button: Button, display: Display }).strict(),
  scroll: z
    .object({
      x: Coord.optional(),
      y: Coord.optional(),
      dx: z.number().int().min(-50).max(50).default(0),
      dy: z.number().int().min(-50).max(50).default(0),
      display: Display,
    })
    .strict()
    .refine((a) => (a.x === undefined) === (a.y === undefined), { message: "give both x and y, or neither" }),
  type_text: z.object({ text: z.string().min(1).max(TYPE_TEXT_MAX) }).strict(),
  key: z
    .object({ keys: z.string().min(1).max(64).describe('A key or combo, e.g. "enter", "ctrl+c", "cmd+shift+t"') })
    .strict()
    .refine((a) => parseCombo(a.keys) !== null, { message: "unknown key or combo" }),
  list_windows: z.object({}).strict(),
  focus_window: z.object({ id: z.number().int().min(0) }).strict(),
  wait: z.object({ ms: z.number().int().min(1).max(WAIT_MAX_MS) }).strict(),
  // App control (engine contract): only the person's recipes, each app approved per session.
  list_apps: z.object({}).strict(),
  launch_app: z.object({ appId: AppId }).strict(),
  open_web_app: z
    .object({
      appId: AppId,
      url: z
        .string()
        .max(2048)
        .optional()
        .describe("A page on that app's own site (default: its start page). Other sites are refused."),
    })
    .strict(),
} as const;

/** Tools that open apps: each app needs its own `app_control` approval in the session. */
export const APP_TOOLS: ReadonlySet<string> = new Set(["launch_app", "open_web_app"]);

export type ToolName = keyof typeof ToolArgs;
export const TOOL_NAMES = Object.keys(ToolArgs) as ToolName[];
export const isToolName = (s: string): s is ToolName => Object.hasOwn(ToolArgs, s);

const DESCRIPTIONS: Record<ToolName, string> = {
  screenshot:
    "Capture a display (downscaled). Returns the image plus the display list and the image size; every coordinate you pass to the other tools is in this image's pixels.",
  mouse_move: "Move the pointer to (x, y).",
  click: "Click a mouse button, at (x, y) when given (otherwise where the pointer is).",
  double_click: "Double-click the left button, at (x, y) when given.",
  drag: "Press at (fromX, fromY), move to (toX, toY) and release.",
  scroll: "Scroll by dx/dy wheel steps (positive dy scrolls down), at (x, y) when given.",
  type_text: `Type text into the focused field (at most ${TYPE_TEXT_MAX} characters).`,
  key: 'Press a key or a combo such as "enter", "ctrl+c", "cmd+space".',
  list_windows: "List the open windows (id, app, title, position, size, focused).",
  focus_window: "Bring the window with this id (from list_windows) to the front.",
  wait: `Wait up to ${WAIT_MAX_MS} ms, e.g. for an app to open.`,
  list_apps: "List the AI apps and websites the person set up on this computer (id, name, kind).",
  launch_app:
    "Open one of those apps (or bring it to the front). The first time in this session the person approves controlling that app on their phone.",
  open_web_app:
    "Open an AI website from `list_apps` in its own browser profile, where the person is signed in. Only that site's pages; the person approves it once per session.",
};

/** The MCP `tools/list` entries. */
export const mcpTools = () =>
  TOOL_NAMES.map((name) => {
    const { $schema: _drop, ...inputSchema } = z.toJSONSchema(ToolArgs[name], { io: "input" }) as Record<
      string,
      unknown
    >;
    return {
      name,
      description: DESCRIPTIONS[name],
      inputSchema,
      annotations: {
        readOnlyHint: name === "screenshot" || name === "list_windows" || name === "wait" || name === "list_apps",
      },
    };
  });

/** Tools that don't touch the input devices or the screen; not counted against the rate limit. */
export const UNCOUNTED: ReadonlySet<ToolName> = new Set(["wait", "list_apps"]);
