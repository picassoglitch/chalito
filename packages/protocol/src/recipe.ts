import { z } from "zod";
import { EpochMs, Signature } from "./common.js";
import { ProviderConnectMethod, ProviderErrorCode, ProviderState } from "./provider.js";

/**
 * Connect engine (engine contract v2, 2026-10-06): one recipe per AI app, describing how the
 * agent finds it on a computer, installs it from an official source, starts the app's OWN
 * sign-in (its CLI login, its desktop app, or its real website), launches it, and which driver
 * runs it (a protocol, a terminal, a desktop app or a website). Recipes are data: the agent's
 * executor (apps/agent/src/apps) is the only code that acts on them.
 *
 * Two sources:
 * - Curated: published by Chalito in a catalog signed with Ed25519 (`SignedRecipeCatalog`); the
 *   agent verifies it against a public key compiled into the agent.
 * - Custom: the person's own `~/.chalito/recipes/*.yaml`, enabled only on that computer
 *   (`chalito apps custom enable`), shown as "Personalizada", never uploaded except id/name/status.
 *
 * Argv convention: every command (`signin.command`, `driver.acp.command`, `launch.command`, …) is
 * a full argv whose argv[0] is the app's command NAME (one of `detect.commands`). The agent
 * resolves it to the detected (or pinned) binary; nothing ever runs through a shell.
 */

/** A recipe id: lowercase kebab, also the app id everywhere (connections, sessions, commands). */
export const AppId = z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, "app id must be kebab-case, 2-41 chars");
export type AppId = z.infer<typeof AppId>;

export const RecipeKind = z.enum(["claude-sdk", "codex", "acp", "terminal", "desktop-app", "web-app"]);
export type RecipeKind = z.infer<typeof RecipeKind>;

export const RecipeCapability = z.enum(["sessions", "terminal", "remote-view", "ai-control"]);
export type RecipeCapability = z.infer<typeof RecipeCapability>;

export const RecipePlatform = z.enum(["mac", "windows", "linux"]);
export type RecipePlatform = z.infer<typeof RecipePlatform>;

const https = z
  .string()
  .max(500)
  .url()
  .refine((u) => u.startsWith("https://"), "https only");

/** An https origin (no path), for a web app's allowlist. */
const HttpsOrigin = z
  .string()
  .max(200)
  .refine((o) => {
    try {
      const u = new URL(o);
      return u.protocol === "https:" && u.origin === o;
    } catch {
      return false;
    }
  }, "an https origin without a path");

const Host = z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "a host name");

/** A command name looked up on PATH (never a path, never shell syntax). */
export const BinName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "a command name, not a path");

/** One argument: printable, no NUL or newlines (nothing runs through a shell anyway). */
const Arg = z
  .string()
  .min(1)
  .max(200)
  // eslint-disable-next-line no-control-regex
  .regex(/^[^\u0000-\u001f]+$/, "no control characters");

/** argv[0] is the app's command name, resolved by the agent to the detected or pinned binary. */
const Argv = z
  .array(Arg)
  .min(1)
  .max(16)
  .refine((a) => BinName.safeParse(a[0]).success, "argv[0] must be the app's command name");

/** An absolute path, or one under a known per-user / system folder. No `..`. */
const PathTemplate = z
  .string()
  .max(300)
  .refine(
    (p) =>
      !/(^|[\\/])\.\.([\\/]|$)/.test(p) &&
      (p.startsWith("/") ||
        p.startsWith("~/") ||
        /^%(LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|APPDATA|USERPROFILE)%\\/.test(p) ||
        /^[A-Z]:\\/.test(p)),
    "absolute, ~/…, or %LOCALAPPDATA%\\… (no ..)",
  );

const NpmPackage = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const BrewName = /^[a-z0-9][a-z0-9@._+-]*$/;
const WingetId = /^[A-Za-z0-9][A-Za-z0-9.+_-]*\.[A-Za-z0-9.+_-]+$/;
const MsStoreId = /^[0-9A-Z]{12}$/;

/**
 * Official sources only. `npm`: the vendor's own package (`npm install -g`). `brew` / `winget`:
 * the vendor's formula, cask or package id. `official-url`: the vendor's download page, which the
 * agent only opens in the browser on that computer (it never downloads or runs an installer).
 */
export const RecipeInstall = z
  .object({
    via: z.enum(["npm", "brew", "winget", "official-url"]),
    ref: z.string().min(1).max(300),
    /** brew only: the ref is a cask (a desktop app), installed with `brew install --cask`. */
    cask: z.boolean().optional(),
    /** winget only: the Microsoft Store source (`-s msstore`, a 12-character Store id) instead of winget's. */
    source: z.enum(["winget", "msstore"]).optional(),
  })
  .strict()
  .refine(
    (i) =>
      i.via === "npm"
        ? NpmPackage.test(i.ref)
        : i.via === "brew"
          ? BrewName.test(i.ref)
          : i.via === "winget"
            ? i.source === "msstore"
              ? MsStoreId.test(i.ref)
              : WingetId.test(i.ref)
            : https.safeParse(i.ref).success,
    { message: "ref doesn't match its source (npm package, brew name, winget id, Store id or https page)" },
  )
  .refine((i) => i.cask === undefined || i.via === "brew", { message: "cask is for brew only" })
  .refine((i) => i.source === undefined || i.via === "winget", { message: "source is for winget only" });
export type RecipeInstall = z.infer<typeof RecipeInstall>;

export const RecipeDetect = z
  .object({
    commands: z.array(BinName).max(8).optional(),
    paths: z.array(PathTemplate).max(8).optional(),
    bundleIds: z
      .array(z.string().regex(/^[A-Za-z0-9.-]{3,155}$/))
      .max(8)
      .optional(),
    appUserModelIds: z
      .array(z.string().regex(/^[A-Za-z0-9._!-]{3,200}$/))
      .max(8)
      .optional(),
  })
  .strict();
export type RecipeDetect = z.infer<typeof RecipeDetect>;

export const RecipeLaunch = z
  .object({
    command: Argv.optional(),
    /** mac: the app name for `open -a`; windows: its AppUserModelID; linux: its desktop file id. */
    app: z
      .string()
      .regex(/^[A-Za-z0-9 ._!-]{1,200}$/)
      .optional(),
  })
  .strict()
  .refine((l) => l.command !== undefined || l.app !== undefined, { message: "launch needs a command or an app" });
export type RecipeLaunch = z.infer<typeof RecipeLaunch>;

export const RecipePlatformSpec = z
  .object({ detect: RecipeDetect, install: RecipeInstall.optional(), launch: RecipeLaunch.optional() })
  .strict();
export type RecipePlatformSpec = z.infer<typeof RecipePlatformSpec>;

/**
 * Plan sign-in gate, like providers.yaml `subscriptionLocal`: `on` allows the app's own
 * sign-in; `owner_only` fails closed on the device (no server-signed team claim yet, D-063);
 * `off` is API key only.
 */
export const PlanSignin = z.enum(["on", "owner_only", "off"]);
export type PlanSignin = z.infer<typeof PlanSignin>;

/**
 * The app's OWN sign-in, always on the person's machine: its CLI login (`cli`), its ACP
 * `authenticate` (`acp`), inside its desktop app (`desktop-app`) or on its real website (`web`).
 * Chalito never implements a provider's login, never reads, copies or relays the result.
 *
 * Beyond the contract's fields (documented extensions, all optional):
 * `statusJson` (statusCommand prints JSON whose top-level field is `true` when signed in; without
 * it, exit 0 means signed in), `logoutCommand`, `linkHosts` + `openLinks` (the CLI prints a link
 * and, with `openLinks`, the agent opens it in this computer's browser, only on these hosts),
 * `acpMethod` (the ACP authenticate methodId for `via: acp`), `interactive` (a CLI sign-in that only
 * works inside the app's own terminal UI).
 */
export const RecipeSignin = z
  .object({
    via: z.enum(["cli", "acp", "desktop-app", "web"]),
    command: Argv.optional(),
    url: https.optional(),
    statusCommand: Argv.optional(),
    statusJson: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/)
      .optional(),
    logoutCommand: Argv.optional(),
    linkHosts: z.array(Host).max(8).optional(),
    openLinks: z.boolean().optional(),
    acpMethod: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,60}$/)
      .optional(),
    /**
     * `cli` only: the sign-in happens inside the app's own interactive terminal UI (it needs a
     * person at a terminal), so the agent never runs it headless; the panel tells the person to
     * run `command` in a terminal on that computer (or a remote terminal session runs it).
     */
    interactive: z.boolean().optional(),
    planSignin: PlanSignin,
  })
  .strict()
  .refine((s) => s.via !== "cli" || s.command !== undefined, { message: "a cli sign-in needs its command" })
  .refine((s) => s.via !== "acp" || (s.command !== undefined && s.acpMethod !== undefined), {
    message: "an acp sign-in needs the ACP command and acpMethod",
  })
  .refine((s) => s.via !== "web" || s.url !== undefined, { message: "a web sign-in needs its url" })
  .refine((s) => s.interactive === undefined || s.via === "cli", { message: "interactive is for cli sign-ins" })
  .refine((s) => s.statusJson === undefined || s.statusCommand !== undefined, {
    message: "statusJson needs statusCommand",
  });
export type RecipeSignin = z.infer<typeof RecipeSignin>;

export const RecipeApiKey = z
  .object({
    env: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
    label: z.string().min(1).max(80),
    docsUrl: https,
  })
  .strict();
export type RecipeApiKey = z.infer<typeof RecipeApiKey>;

export const RecipeDriver = z
  .object({
    acp: z
      .object({
        command: Argv,
        authMethods: z
          .array(z.string().regex(/^[A-Za-z0-9._-]{1,60}$/))
          .max(8)
          .optional(),
      })
      .strict()
      .optional(),
    terminal: z.object({ command: Argv }).strict().optional(),
    web: z
      .object({ startUrl: https, allowedOrigins: z.array(HttpsOrigin).min(1).max(16) })
      .strict()
      .refine((w) => w.allowedOrigins.includes(new URL(w.startUrl).origin), {
        message: "startUrl's origin must be allowed",
      })
      .optional(),
    desktopApp: z
      .object({
        bundleId: z
          .string()
          .regex(/^[A-Za-z0-9.-]{3,155}$/)
          .optional(),
        exe: z
          .string()
          .regex(/^[A-Za-z0-9 ._-]{1,100}$/)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type RecipeDriver = z.infer<typeof RecipeDriver>;

/**
 * Chalito's own profile for the app's CLI (an extension to the contract): environment variables
 * pointing the CLI at a folder under ~/.chalito, so signing in or out there never touches the
 * person's own setup. Values must be `{chalito}/<name>`.
 */
export const RecipeProfile = z
  .object({
    env: z.record(
      z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
      z.string().regex(/^\{chalito\}\/[a-z0-9][a-z0-9._-]{0,40}$/),
    ),
  })
  .strict();
export type RecipeProfile = z.infer<typeof RecipeProfile>;

const argv0s = (r: {
  signin: RecipeSignin;
  driver: RecipeDriver;
  platforms: Partial<Record<RecipePlatform, RecipePlatformSpec>>;
}) => [
  ...[r.signin.command, r.signin.statusCommand, r.signin.logoutCommand].flatMap((a) => (a ? [a[0]!] : [])),
  ...[r.driver.acp?.command, r.driver.terminal?.command].flatMap((a) => (a ? [a[0]!] : [])),
  ...Object.values(r.platforms).flatMap((p) => (p?.launch?.command ? [p.launch.command[0]!] : [])),
];

export const Recipe = z
  .object({
    v: z.literal(1),
    id: AppId,
    name: z.string().min(1).max(60),
    vendor: z.string().min(1).max(60),
    homepage: https,
    termsUrl: https,
    kinds: z.array(RecipeKind).min(1).max(6),
    platforms: z
      .object({
        mac: RecipePlatformSpec.optional(),
        windows: RecipePlatformSpec.optional(),
        linux: RecipePlatformSpec.optional(),
      })
      .strict(),
    signin: RecipeSignin,
    apiKey: RecipeApiKey.optional(),
    driver: RecipeDriver,
    profile: RecipeProfile.optional(),
    capabilities: z.array(RecipeCapability).max(4),
  })
  .strict()
  .refine((r) => new Set(r.kinds).size === r.kinds.length, { message: "kinds repeat" })
  .refine((r) => !r.kinds.includes("acp") || r.driver.acp !== undefined, { message: "an acp app needs driver.acp" })
  .refine((r) => !r.kinds.includes("terminal") || r.driver.terminal !== undefined, {
    message: "a terminal app needs driver.terminal",
  })
  .refine((r) => !r.kinds.includes("web-app") || (r.driver.web !== undefined && r.signin.via === "web"), {
    message: "a web app needs driver.web and a web sign-in",
  })
  .refine((r) => Object.keys(r.platforms).length > 0 || r.kinds.every((k) => k === "web-app"), {
    message: "platforms may be empty only for a web app (it runs wherever there's a browser)",
  })
  .refine(
    (r) => {
      const bins = new Set(Object.values(r.platforms).flatMap((p) => p?.detect.commands ?? []));
      return argv0s(r).every((b) => bins.has(b));
    },
    { message: "every command's argv[0] must be one of the platforms' detect.commands" },
  );
export type Recipe = z.infer<typeof Recipe>;

/** The curated catalog body (`recipes/catalog.json`, built from `recipes/*.yaml`). */
export const RecipeCatalog = z
  .object({
    v: z.literal(1),
    issuedAt: EpochMs,
    recipes: z.array(Recipe).max(500),
  })
  .strict()
  .refine((c) => new Set(c.recipes.map((r) => r.id)).size === c.recipes.length, { message: "duplicate recipe id" });
export type RecipeCatalog = z.infer<typeof RecipeCatalog>;

/**
 * What `GET /v1/recipes/catalog` serves: the catalog with a detached Ed25519 signature over
 * utf8("chalito.recipe-catalog.v1") || 0x00 || utf8(JCS(body)) (packages/crypto `signDetached`).
 * `keyId` names which compiled-in public key verifies it (apps/agent/src/apps/catalog-keys.ts).
 */
export const SignedRecipeCatalog = z
  .object({
    ctx: z.literal("chalito.recipe-catalog.v1"),
    keyId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
    body: RecipeCatalog,
    sig: Signature,
  })
  .strict();
export type SignedRecipeCatalog = z.infer<typeof SignedRecipeCatalog>;

// ---------------------------------------------------------------- legacy mapping

/** The four providers of #30 became recipes; `provider.*` commands are aliases of `app.*`. */
export const PROVIDER_APP = {
  anthropic: "claude-code",
  openai: "codex",
  xai: "grok",
  google: "gemini",
} as const satisfies Record<string, AppId>;

/** The session adapter that serves each of those apps (AdapterKind). */
export const APP_ADAPTER = {
  "claude-code": "claude-code",
  codex: "codex",
  grok: "grok",
  gemini: "gemini",
} as const;
export type LegacyAppId = keyof typeof APP_ADAPTER;
export const isLegacyApp = (id: string): id is LegacyAppId => Object.hasOwn(APP_ADAPTER, id);

// ---------------------------------------------------------------- status

/**
 * Adds to ProviderState: `available`, an app that's there and launchable whose sign-in lives
 * inside the app itself (a desktop app, a website), so the agent can't observe it.
 */
export const AppState = z.enum([...ProviderState.options, "available"]);
export type AppState = z.infer<typeof AppState>;

/**
 * Adds to ProviderErrorCode: `launch_failed`, `unsupported_platform` (no recipe entry for this
 * OS), `install_unavailable` (no official installer for this OS, or its tool is missing here),
 * `recipe_disabled` (a custom recipe that isn't enabled on this computer, or was edited since).
 */
export const AppErrorCode = z.enum([
  ...ProviderErrorCode.options,
  "launch_failed",
  "unsupported_platform",
  "install_unavailable",
  "recipe_disabled",
]);
export type AppErrorCode = z.infer<typeof AppErrorCode>;

/**
 * The `doc` of a `chalito.connections` row, one per (owner, device, app id), written by that
 * device's agent: ProviderConnectionDoc plus the app's main `kind` and whether it's a custom
 * ("Personalizada") recipe. `name` only for custom recipes (the hub has no catalog entry for
 * them; the id and name are all that ever leave the computer).
 */
export const AppConnectionDoc = z
  .object({
    mode: ProviderConnectMethod.nullable(),
    connected: z.boolean(),
    state: AppState,
    cli: z.object({ installed: z.boolean(), version: z.string().max(64).nullable() }).strict(),
    error: AppErrorCode.nullable(),
    at: EpochMs,
    kind: RecipeKind,
    custom: z.boolean(),
    name: z.string().min(1).max(60).optional(),
  })
  .strict()
  .refine((d) => d.connected === (d.state === "connected"), { message: "connected iff state is connected" })
  .refine((d) => d.name === undefined || d.custom, { message: "name only for custom recipes" });
export type AppConnectionDoc = z.infer<typeof AppConnectionDoc>;

/** What a session runs: an agent protocol session, a terminal, or a remote screen. */
export const SessionKind = z.enum(["agent", "terminal", "screen"]);
export type SessionKind = z.infer<typeof SessionKind>;
