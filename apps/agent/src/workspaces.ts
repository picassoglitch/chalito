import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { OsAuth } from "./devmode.js";
import { SENSITIVE_DIRS, SENSITIVE_FILES, STARTUP_DIRS, STARTUP_FILES } from "./policy/persistence.js";
import type { Policy } from "./policy/index.js";

/**
 * Workspaces from the desktop panel (First Run C, ADR 0028): the person picks a folder with the
 * OS folder picker and Chalito may work there. Adding one loosens the policy, so it's local only:
 * the agent asks the OS itself (password or biometric), like `chalito policy edit` asks at the
 * terminal, and the change is signed as `local`. Removing one only tightens: no check.
 *
 * Every path is resolved with the OS's own realpath (symlinks, `..`, Windows 8.3 short names such
 * as `PROGRA~1`), normalized to NFC, and compared case-insensitively on macOS and Windows, so
 * `/USERS/ana`, `~/.CHALITO` or `C:\PROGRA~1` can't slip past the refusals.
 */

export type AddWorkspaceResult =
  | { ok: true; label: string; added: boolean }
  | {
      ok: false;
      reason: "not_a_folder" | "too_broad" | "chalito_folder" | "sensitive" | "startup" | "os_auth_failed" | "too_many";
    };

export type WorkspaceProblem = "too_broad" | "chalito_folder" | "sensitive" | "startup";

export interface WorkspaceDeps {
  policy: { get(): Policy; set(p: Policy, via: "local"): Promise<void> };
  osAuth: OsAuth;
  locale: "es" | "en";
  /** ~/.chalito: never a workspace, nor inside one. */
  chalitoDir: string;
  home?: string;
  platform?: NodeJS.Platform;
  /**
   * The agent's PATH folders (default: its own PATH). None of them, nor a folder above them, can be
   * a workspace: a file written there would run in place of a command later.
   */
  pathDirs?: string[];
  /** The OS realpath and folder check (tests inject them to play Windows short names). */
  realpath?: (p: string) => string;
  isDirectory?: (p: string) => boolean;
  emit: (type: string, meta: Record<string, unknown>) => void;
}

const MAX_WORKSPACES = 50;

const REASON = {
  es: (label: string) => `Chalito: permitir trabajar en la carpeta «${label}»`,
  en: (label: string) => `Chalito: allow working in the folder "${label}"`,
};

/** System folders: the folder and everything under it is refused. */
const POSIX_DENY = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/var",
  "/private",
  "/System",
  "/Library",
  "/Applications",
  "/opt/homebrew",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/root",
  "/run",
  "/snap",
];
/** Too broad as a whole (their subfolders, like a mounted drive's project, are fine). */
const POSIX_EXACT = ["/opt", "/tmp", "/mnt", "/media", "/Volumes", "/srv"];
/** Where every person's home folder lives: another person's is refused. */
const POSIX_HOMES = ["/Users", "/home"];
/** Under each drive root (C:\, D:\…). */
const WIN_DENY = [
  "Windows",
  "Program Files",
  "Program Files (x86)",
  "ProgramData",
  "$Recycle.Bin",
  "System Volume Information",
];
const WIN_HOMES = ["Users"];

interface Paths {
  P: typeof posix;
  /** The comparison key: NFC, and lower case where the file system ignores case. */
  key: (p: string) => string;
  within: (child: string, parent: string) => boolean;
}

const pathsFor = (platform: NodeJS.Platform): Paths => {
  const P = platform === "win32" ? win32 : posix;
  const fold = platform === "win32" || platform === "darwin";
  const key = (p: string) => {
    const n = P.normalize(p.normalize("NFC"));
    const trimmed = n.length > P.parse(n).root.length ? n.replace(/[\\/]+$/, "") : n;
    return fold ? trimmed.toLowerCase() : trimmed;
  };
  const within = (child: string, parent: string) => {
    const r = P.relative(key(parent), key(child));
    return r === "" || (!r.startsWith("..") && !P.isAbsolute(r));
  };
  return { P, key, within };
};

/** Why `dir` (already resolved by the OS) can't be a workspace, or null. */
export const workspaceProblem = (
  dir: string,
  o: {
    home: string;
    chalitoDir: string;
    platform: NodeJS.Platform;
    pathDirs?: string[];
    /**
     * The OS realpath: a credentials or startup folder that is a symlink (a dotfiles manager's
     * ~/.ssh → ~/dotfiles/ssh) also blocks its target and everything above it.
     */
    resolve?: (p: string) => string;
  },
): WorkspaceProblem | null => {
  const { P, key, within } = pathsFor(o.platform);
  const root = P.parse(dir).root;
  if (key(dir) === key(root)) return "too_broad";
  // The whole home folder (or anything above it) holds ~/.chalito, keys and every other app's data.
  if (within(o.home, dir)) return "too_broad";
  if (within(dir, o.chalitoDir) || within(o.chalitoDir, dir)) return "chalito_folder";
  const inHome = (rel: string) => P.join(o.home, ...rel.split("/"));
  // A file's folder, other than the home folder itself (refused above as too broad).
  const folderOf = (files: string[]) => files.filter((f) => f.includes("/")).map((f) => P.dirname(inHome(f)));
  // Each entry as written and as the OS resolves it.
  const both = (paths: string[]) => paths.flatMap((p) => (o.resolve ? [p, o.resolve(p)] : [p]));
  const hits = (paths: string[]) => both(paths).some((abs) => within(dir, abs) || within(abs, dir));
  // A credentials file's folder can't be a workspace, nor anything above it (its other subfolders can).
  const above = (paths: string[]) => both(paths).some((abs) => within(abs, dir));
  if (hits(SENSITIVE_DIRS.map(inHome)) || above(folderOf(SENSITIVE_FILES))) return "sensitive";
  // Startup, autostart and bin folders (shared with the classifier), startup files' folders, PATH.
  if (
    hits([
      ...STARTUP_DIRS.map(inHome),
      ...folderOf(STARTUP_FILES),
      ...(o.pathDirs ?? []).filter((p) => P.isAbsolute(p)),
    ])
  )
    return "startup";
  if (within(dir, o.home)) return null;

  if (o.platform === "win32") {
    for (const d of WIN_DENY) if (within(dir, P.join(root, d))) return "too_broad";
    // Another person's home folder, or the Users folder itself.
    for (const h of WIN_HOMES) if (within(dir, P.join(root, h))) return "too_broad";
    return null;
  }
  if (POSIX_DENY.some((d) => within(dir, d))) return "too_broad";
  if (POSIX_EXACT.some((d) => key(dir) === key(d))) return "too_broad";
  if (POSIX_HOMES.some((h) => within(dir, h))) return "too_broad";
  return null;
};

/** The folder's name, made unique among the existing labels ("proyecto", "proyecto-2", …). */
export const labelFor = (dir: string, taken: string[], platform: NodeJS.Platform = process.platform): string => {
  const P = platform === "win32" ? win32 : posix;
  const base = (P.basename(dir).normalize("NFC") || "carpeta").slice(0, 50);
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
};

export const addWorkspace = async (d: WorkspaceDeps, rawPath: string): Promise<AddWorkspaceResult> => {
  const platform = d.platform ?? process.platform;
  const { P, key } = pathsFor(platform);
  const real = d.realpath ?? ((p: string) => realpathSync.native(p));
  if (!P.isAbsolute(rawPath)) return { ok: false, reason: "not_a_folder" };
  let dir: string;
  try {
    dir = real(P.resolve(rawPath)).normalize("NFC");
    if (!(d.isDirectory ?? ((p: string) => statSync(p).isDirectory()))(dir))
      return { ok: false, reason: "not_a_folder" };
  } catch {
    return { ok: false, reason: "not_a_folder" };
  }
  const resolved = (p: string) => {
    try {
      return real(p).normalize("NFC");
    } catch {
      return P.resolve(p).normalize("NFC");
    }
  };
  const home = resolved(d.home ?? homedir());
  const chalitoDir = resolved(d.chalitoDir);
  const pathDirs = (d.pathDirs ?? (process.env.PATH ?? "").split(platform === "win32" ? ";" : ":"))
    .filter((p) => p && P.isAbsolute(p))
    .map(resolved);
  const problem = workspaceProblem(dir, { home, chalitoDir, platform, pathDirs, resolve: resolved });
  if (problem) return { ok: false, reason: problem };

  const policy = d.policy.get();
  const existing = policy.workspaces.find((w) => key(w.path) === key(dir));
  if (existing) return { ok: true, label: existing.label, added: false };
  if (policy.workspaces.length >= MAX_WORKSPACES) return { ok: false, reason: "too_many" };

  const label = labelFor(
    dir,
    policy.workspaces.map((w) => w.label),
    platform,
  );
  if (!(await d.osAuth.verify(REASON[d.locale](label)))) {
    d.emit("workspace.add_refused", { reason: "os_auth_failed" });
    return { ok: false, reason: "os_auth_failed" };
  }
  // Re-read: the policy may have changed while the OS prompt was open.
  const now = d.policy.get();
  if (now.workspaces.some((w) => key(w.path) === key(dir)))
    return { ok: true, label: now.workspaces.find((w) => key(w.path) === key(dir))!.label, added: false };
  await d.policy.set({ ...now, workspaces: [...now.workspaces, { label, path: dir }] }, "local");
  d.emit("workspace.added", { label });
  return { ok: true, label, added: true };
};

/** Tightening only: no OS check. True when something was removed. */
export const removeWorkspace = async (d: Pick<WorkspaceDeps, "policy" | "emit">, label: string): Promise<boolean> => {
  const p = d.policy.get();
  const next = p.workspaces.filter((w) => w.label !== label);
  if (next.length === p.workspaces.length) return false;
  await d.policy.set({ ...p, workspaces: next }, "local");
  d.emit("workspace.removed", { label });
  return true;
};
