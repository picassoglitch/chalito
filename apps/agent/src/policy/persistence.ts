/**
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

/** Autostart, login-item and service folders, and the per-user bin folders usually on PATH. */
export const STARTUP_DIRS = [
  ".local/bin",
  "bin",
  ".config/systemd/user",
  ".config/autostart",
  ".config/fish/conf.d",
  ".config/powershell",
  "Library/LaunchAgents",
  "Documents/PowerShell",
  "Documents/WindowsPowerShell",
  "AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup",
  ".claude/local",
  ".npm-global/bin",
  ".bun/bin",
  ".volta/bin",
  ".cargo/bin",
  "go/bin",
];
