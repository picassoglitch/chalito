/**
 * The environment a coding-agent CLI may inherit (Claude Code, Codex): an allowlist, never a
 * passthrough. Credentials (Chalito's own, the secrets passphrase, other providers' keys), base
 * URLs, provider switches and custom headers are all dropped (review R-L12).
 */
export const ENV_ALLOW = new Set(
  [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "LANG",
    "TMPDIR",
    "TZ",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    // Windows: the CLI and its child processes don't start without these.
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
  ].map((k) => k.toUpperCase()),
);
export const envAllowed = (k: string) => ENV_ALLOW.has(k.toUpperCase()) || /^LC_[A-Z_]+$/i.test(k);

/** Only the allowlisted variables of `source`. */
export const allowedEnv = (source: Record<string, string | undefined>): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(source).filter(([k, v]) => v !== undefined && envAllowed(k)));
