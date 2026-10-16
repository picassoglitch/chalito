/**
 * Shared path lists (home-relative, with `/`).
 *
 * Places where a file runs later, outside the approval gate: shell startup files, login/autostart
 * and service folders, and the per-user folders that sit on PATH. Shared by the classifier (a write
 * there is CRITICAL, even inside a workspace) and by workspaces.ts (none of them, nor a folder
 * above them, can become a workspace). Paths are relative to the home folder, with `/`.
 */

/** Shell and session startup files. */
export const STARTUP_FILES = [
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".config/fish/config.fish",
  ".config/powershell/Microsoft.PowerShell_profile.ps1",
  ".config/powershell/profile.ps1",
  ".xprofile",
  ".xinitrc",
];

/**
 * Per-user folders where the official installers put commands (npm, Homebrew on Linux, the
 * vendors' own installers, WinGet, the Microsoft Store). The agent looks for CLIs there
 * (apps/manager.ts `knownBinDirs`), and a file written there runs as a command later, even when
 * the folder isn't on PATH right now.
 */
export const USER_BIN_DIRS = [
  ".local/bin",
  ".claude/local",
  ".npm-global/bin",
  ".bun/bin",
  ".volta/bin",
  ".cargo/bin",
  ".linuxbrew/bin",
  "AppData/Roaming/npm",
  "AppData/Local/Microsoft/WinGet/Links",
  "AppData/Local/Microsoft/WindowsApps",
  "AppData/Local/Programs/cursor/resources/app/bin",
];

/** Autostart, login-item and service folders, and the per-user bin folders. */
export const STARTUP_DIRS = [
  "bin",
  "go/bin",
  ".config/systemd/user",
  ".config/autostart",
  ".config/fish/conf.d",
  ".config/powershell",
  "Library/LaunchAgents",
  "Documents/PowerShell",
  "Documents/WindowsPowerShell",
  "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup",
  ...USER_BIN_DIRS,
];

/**
 * Credentials in the home folder: reading or writing them is CRITICAL in the classifier, and none
 * of them (nor a folder above them) can be a workspace.
 */
export const SENSITIVE_DIRS = [
  ".ssh",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".kube",
  ".gnupg",
  ".password-store",
  ".config/gh",
  ".docker",
  ".local/share/keyrings",
  "Library/Keychains",
  ".codex",
  "AppData/Roaming/Microsoft/Credentials",
];
export const SENSITIVE_FILES = [
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".claude/.credentials.json",
  ".claude.json",
];

/**
 * The AI tools' own configuration: hooks, MCP servers, commands, agents, skills, plugins and
 * settings there run code or steer the next session (prompt injection). Writing there is CRITICAL
 * in the classifier, even inside a workspace, and none of them (nor anything inside or above them)
 * can be a workspace. `~/.aider*` (its config files and folders) is matched by prefix
 * (AI_CONFIG_PREFIXES).
 */
export const AI_CONFIG_DIRS = [
  ".claude",
  ".codex",
  ".gemini",
  ".cursor",
  ".config/github-copilot",
  ".config/Claude",
  "Library/Application Support/Claude",
  "AppData/Roaming/Claude",
  "AppData/Roaming/Cursor",
  "AppData/Local/github-copilot",
  ".continue",
  ".codeium",
  ".windsurf",
  ".config/Windsurf",
  "Library/Application Support/Windsurf",
  "AppData/Roaming/Windsurf",
  ".config/opencode",
  ".vscode/extensions",
  ".config/Code/User",
  "Library/Application Support/Code/User",
  "AppData/Roaming/Code/User",
];
/** Names in the home folder that start with these are AI tool config too (`~/.aider.conf.yml`, …). */
export const AI_CONFIG_PREFIXES = [".aider"];
