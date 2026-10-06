/**
 * Smoke entry for the compiled agent binary (ADR 0004): proves the `@napi-rs/keyring`
 * native addon and libsodium's wasm both load inside a `bun build --compile` executable, and that
 * remote terminal's PTY layer (terminal/pty.ts) round-trips through a real PTY there (`pty`).
 *
 * Exit codes: 0 = addon loaded and a keychain round-trip worked; 2 = addon loaded but no
 * persistent keychain backend is reachable (e.g. headless Linux without a Secret Service);
 * 1 = something is actually broken (addon missing, wasm failed, round-trip mismatch).
 */
import type { Entry as KeyringEntry } from "@napi-rs/keyring";
import { tmpdir } from "node:os";
import { loadOrCreateIdentity } from "./identity.js";
import { loadPtyBackend } from "./terminal/pty.js";
import { KeyringStore, MemorySecretStore } from "./secrets.js";

const SMOKE_SERVICE = "com.chalito.agent.smoke";

let pty: Record<string, unknown> = {};

const report = (code: 0 | 1 | 2, fields: Record<string, unknown>): never => {
  process.stdout.write(`${JSON.stringify({ smoke: "chalito-agent", ...fields, ...pty })}\n`);
  process.exit(code);
};

/** Types a line into `/bin/sh` in a PTY and reads the echo back (POSIX; Windows is skipped). */
const ptyCheck = async (): Promise<Record<string, unknown>> => {
  if (process.platform === "win32") return { pty: "skipped" };
  try {
    const backend = loadPtyBackend();
    const result = await new Promise<string>((resolve) => {
      let out = "";
      const timer = setTimeout(() => resolve("timeout"), 5000);
      const p = backend.spawn("/bin/sh", ["-c", "read x; stty size; echo got:$x"], {
        cols: 81,
        rows: 23,
        cwd: tmpdir(),
        env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
        onData: (d) => void (out += d),
        onExit: () => {
          clearTimeout(timer);
          resolve(out.includes("got:ping") && out.includes("23 81") ? "ok" : "mismatch");
        },
      });
      p.write("ping\r");
    });
    return { pty: result, ptyBackend: backend.name };
  } catch (err) {
    return { pty: "unavailable", ptyError: err instanceof Error ? err.message.slice(0, 120) : "error" };
  }
};

const main = async () => {
  pty = await ptyCheck();
  let Entry: typeof KeyringEntry;
  try {
    ({ Entry } = await import("@napi-rs/keyring"));
  } catch (err) {
    return report(1, { addonLoaded: false, error: err instanceof Error ? err.message : String(err) });
  }
  // The real store class must bundle too, even though the round-trip uses a test service name.
  void new KeyringStore();

  try {
    const id = await loadOrCreateIdentity(new MemorySecretStore());
    if (!id.deviceId) throw new Error("empty device id");
  } catch (err) {
    return report(1, { addonLoaded: true, sodium: false, error: err instanceof Error ? err.message : String(err) });
  }

  // Pin the Secret Service on Linux: the default silently falls back to the kernel keyutils
  // store, which is in-memory and loses everything on reboot.
  let entry: KeyringEntry;
  const value = `ok-${Date.now()}`;
  try {
    entry = new Entry(SMOKE_SERVICE, `smoke-${process.pid}`, { linux: { store: "secret-service" } });
    entry.setPassword(value);
  } catch (err) {
    return report(2, {
      addonLoaded: true,
      sodium: true,
      keyring: "unavailable",
      message: `No OS keychain backend reachable (${err instanceof Error ? err.message : "error"}). On Linux, start a Secret Service or use the encrypted-file fallback.`,
    });
  }
  try {
    const back = entry.getPassword();
    if (back !== value) return report(1, { addonLoaded: true, sodium: true, keyring: "mismatch" });
  } finally {
    try {
      entry.deletePassword();
    } catch {
      /* best effort */
    }
  }
  return report(0, { addonLoaded: true, sodium: true, keyring: "ok", platform: `${process.platform}-${process.arch}` });
};

void main();
