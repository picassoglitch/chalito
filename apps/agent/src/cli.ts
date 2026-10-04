import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { redactError } from "./redact.js";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLiabilityText } from "@chalito/config";
import { DevModeToggle, EnableableDevModeToggle } from "@chalito/protocol";
import type { FetchFn, PairingWatcher } from "./cloud.js";
import { AnchorStore } from "./anchor.js";
import { pinClaude } from "./claude-pin.js";
import {
  ConfigTamperedError,
  chalitoDir,
  ensureChalitoDir,
  envLocale,
  isPaired,
  readConfig,
  writeConfig,
  type AgentConfig,
} from "./config.js";
import { OnboardingError, runDaemon, type DaemonDeps, type Daemon } from "./daemon.js";
import { AlreadyRunningError, EXIT_ALREADY_RUNNING, EXIT_NEEDS_SETUP } from "./instance-lock.js";
import { readIpcSecret } from "./ipc-server.js";
import { DevMode, DevModeStore } from "./devmode.js";
import { loadOrCreateIdentity } from "./identity.js";
import { osAuthFor, type StatFn } from "./os-auth.js";
import { runPair } from "./pair.js";
import { FilePolicyHolder, parsePolicyYaml, policyToYaml } from "./policy-file.js";
import { isTighterOrEqual, policyHash } from "./policy/index.js";
import { spawnRunner, which, type ProcessRunner } from "./runner.js";
import { openSecretStore, passphraseFileProblem } from "./secret-choice.js";
import { KeyringUnavailableError, SECRET_NAMES, type SecretStore } from "./secrets.js";
import { servicePlan } from "./service.js";
import { TrustStore } from "./trust-store.js";
import { LineReader, isYes, readHidden, type TtyIo } from "./tty.js";
import { TtyPrompter } from "./tty-prompter.js";

export interface CliIo {
  out(s: string): void;
  err(s: string): void;
  tty: TtyIo;
  env: Record<string, string | undefined>;
  home: string;
  platform: NodeJS.Platform;
  /** Injected in tests; otherwise the keychain (or the encrypted file, see secret-choice.ts). */
  secrets?: SecretStore;
  runner: ProcessRunner;
  fetch: FetchFn;
  now: () => number;
  /** The running binary, used as the service's ExecStart unless --bin is given. */
  execPath: string;
  tmpdir: string;
  daemon?: (deps: DaemonDeps) => Promise<Daemon>;
  pairWatcher?: PairingWatcher;
  /** Injected in tests: how OS-auth helpers (/usr/bin/pkexec, osascript) are checked for root ownership. */
  osStat?: StatFn;
  hostname?: string;
}

export const USAGE = `chalito <command>

  run                                  run the agent (the OS service does this)
  pair [--laptop]                      pair this computer with your phone
  status                               show pairing, policy, Developer mode and keys
  devmode on <toggle>                  turn a Developer-mode toggle on (local only, 3 confirmations)
  devmode off [toggle]                 turn Developer mode (or one toggle) off
  devmode reset                        archive a broken Developer-mode log and start over (OS auth)
  claude pin [path]                    trust this Claude Code binary (path + sha256); after updates too
  codex pin [path]                     trust this Codex binary (path + sha256); after updates too
  policy show|path|edit                show, locate or edit ~/.chalito/policy.yaml
  keys set anthropic|openai|xai        save a BYO API key in the OS keychain
  service install|uninstall [--bin p] [--passphrase-file f]
                                       register the agent as a per-user OS service; on Linux,
                                       --passphrase-file loads the secrets passphrase as a systemd
                                       credential (a 0600 file you own; never Environment=)

toggles: allowSudo, autoApproveHigh, autoApproveCritical

Commands that change anything only run in a terminal you are typing in (not piped,
not from an AI session). Dev/test: CHALITO_SECRETS=file:<path> + CHALITO_SECRETS_PASSPHRASE
keep keys in an encrypted file instead of the OS keychain.
`;

const ON_TOGGLES = EnableableDevModeToggle.options;
const KEY_NAMES = {
  anthropic: SECRET_NAMES.anthropicApiKey,
  openai: SECRET_NAMES.openaiApiKey,
  xai: SECRET_NAMES.xaiApiKey,
} as const;

const T = {
  es: {
    unknown: (c: string) => `Comando desconocido: ${c}\n`,
    toggleOnUsage: `Uso: chalito devmode on <${ON_TOGGLES.join("|")}>\n`,
    needTty:
      "Este comando cambia la seguridad de Chalito: solo funciona en una terminal donde estés escribiendo tú (no con entrada redirigida).\n",
    inSession:
      "Este comando no se puede ejecutar desde una sesión de Chalito (Claude Code o Codex). Ábrelo tú en una terminal.\n",
    looseningAuth: "Esta edición afloja la política: confirma con la autenticación del sistema.\n",
    resetWarn: "Esto archiva el registro actual del Modo desarrollador y empieza uno nuevo con todo apagado.\n",
    resetPrompt: 'Escribe "REINICIAR" para continuar: ',
    resetPhrase: "REINICIAR",
    resetDone: "Registro reiniciado. El Modo desarrollador está apagado.\n",
    pinned: (p: string, h: string) => `Claude Code fijado: ${p}\n  sha256 ${h}\n`,
    pinNeedsPair: "Primero empareja esta computadora (`chalito pair`); luego `chalito claude pin`.\n",
    claudeNotFound:
      "No encontré `claude`. Instálalo (https://code.claude.com/docs/en/setup) o pasa su ruta: chalito claude pin <ruta>\n",
    codexPinned: (p: string, h: string) => `Codex fijado: ${p}\n  sha256 ${h}\n`,
    codexPinNeedsPair: "Primero empareja esta computadora (`chalito pair`); luego `chalito codex pin`.\n",
    codexNotFound:
      "No encontré `codex`. Instálalo (https://developers.openai.com/codex/cli) o pasa su ruta: chalito codex pin <ruta>\n",
    passphrase: "Frase de contraseña del archivo de secretos: ",
    enabled: (t: string) => `Activado: ${t}. Verás "Modo desarrollador ACTIVO" en todas tus apps.\n`,
    authFailed: "La autenticación del sistema falló. No cambió nada.\n",
    cancelled: "Cancelado. No cambió nada y no se registró ninguna aceptación.\n",
    off: "Modo desarrollador desactivado.\n",
    toggleOff: (t: string) => `${t} desactivado.\n`,
    noChanges: "Sin cambios.\n",
    policyRefused:
      "Aviso: policy.yaml se editó sin `chalito policy edit` y no está en vigor. Arriba está la política firmada que sí aplica.\n",
    invalidPolicy: (e: string) => `La política no es válida, no se guardó: ${e}\n`,
    applyPolicy: "¿Aplicar estos cambios? [s/N] ",
    policySaved: (h: string) => `Política guardada (policyHash ${h.slice(0, 12)}…).\n`,
    editorFailed: (c: number) => `El editor terminó con código ${c}. No cambió nada.\n`,
    keyPrompt: (p: string) => `API key de ${p} (no se mostrará): `,
    keyEmpty: "No se guardó: la key está vacía.\n",
    keySaved: (p: string) => `Key de ${p} guardada en el llavero del sistema. Nunca sale de esta computadora.\n`,
    keyShape: (p: string) => `Aviso: no parece una key de ${p}; se guardó de todos modos.\n`,
    needBin: "Estás ejecutando desde el código fuente. Indica el binario: --bin /ruta/a/chalito-agent\n",
    badPassphraseFile: (p: string, why: string) => `No uso ${p} como frase de paso: ${why}.\n`,
    installed: (f: string) => `Servicio instalado (${f}).\n`,
    uninstalled: "Servicio desinstalado.\n",
    cmdFailed: (c: string, e: string) => `Falló \`${c}\`: ${e}\n`,
  },
  en: {
    unknown: (c: string) => `Unknown command: ${c}\n`,
    toggleOnUsage: `Usage: chalito devmode on <${ON_TOGGLES.join("|")}>\n`,
    needTty:
      "This command changes Chalito's security settings, so it only runs in a terminal you're typing in (not with piped input).\n",
    inSession:
      "This command can't run from inside a Chalito session (Claude Code or Codex). Open a terminal and run it yourself.\n",
    looseningAuth: "This edit loosens the policy: confirm with OS authentication.\n",
    resetWarn: "This archives the current Developer-mode log and starts a new one with everything off.\n",
    resetPrompt: 'Type "RESET" to continue: ',
    resetPhrase: "RESET",
    resetDone: "Log reset. Developer mode is off.\n",
    pinned: (p: string, h: string) => `Claude Code pinned: ${p}\n  sha256 ${h}\n`,
    pinNeedsPair: "Pair this computer first (`chalito pair`), then run `chalito claude pin`.\n",
    claudeNotFound:
      "`claude` wasn't found. Install it (https://code.claude.com/docs/en/setup) or pass its path: chalito claude pin <path>\n",
    codexPinned: (p: string, h: string) => `Codex pinned: ${p}\n  sha256 ${h}\n`,
    codexPinNeedsPair: "Pair this computer first (`chalito pair`), then run `chalito codex pin`.\n",
    codexNotFound:
      "`codex` wasn't found. Install it (https://developers.openai.com/codex/cli) or pass its path: chalito codex pin <path>\n",
    passphrase: "Secrets file passphrase: ",
    enabled: (t: string) => `On: ${t}. Every app will show "Developer mode ACTIVE".\n`,
    authFailed: "OS authentication failed. Nothing changed.\n",
    cancelled: "Cancelled. Nothing changed and no acceptance was recorded.\n",
    off: "Developer mode off.\n",
    toggleOff: (t: string) => `${t} off.\n`,
    noChanges: "No changes.\n",
    policyRefused:
      "Warning: policy.yaml was edited outside `chalito policy edit` and is not in force. Above is the signed policy that applies.\n",
    invalidPolicy: (e: string) => `The policy is invalid and was not saved: ${e}\n`,
    applyPolicy: "Apply these changes? [y/N] ",
    policySaved: (h: string) => `Policy saved (policyHash ${h.slice(0, 12)}…).\n`,
    editorFailed: (c: number) => `The editor exited with code ${c}. Nothing changed.\n`,
    keyPrompt: (p: string) => `${p} API key (input hidden): `,
    keyEmpty: "Not saved: the key is empty.\n",
    keySaved: (p: string) => `${p} key saved in the OS keychain. It never leaves this computer.\n`,
    keyShape: (p: string) => `Warning: that doesn't look like a ${p} key; saved anyway.\n`,
    needBin: "You're running from source. Pass the binary: --bin /path/to/chalito-agent\n",
    badPassphraseFile: (p: string, why: string) => `Not using ${p} as the passphrase: ${why}.\n`,
    installed: (f: string) => `Service installed (${f}).\n`,
    uninstalled: "Service uninstalled.\n",
    cmdFailed: (c: string, e: string) => `\`${c}\` failed: ${e}\n`,
  },
} as const;

const KEY_SHAPE: Record<keyof typeof KEY_NAMES, RegExp> = {
  anthropic: /^sk-ant-/,
  openai: /^sk-/,
  xai: /^xai-/,
};

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

/** Tiny argv parser: positionals, `--flag`, `--flag value`, `--flag=value`, `-h`. */
export const parseArgs = (argv: string[], valueFlags: readonly string[] = ["bin", "passphrase-file"]): ParsedArgs => {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-h") flags.help = true;
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const name = a.slice(2);
        const next = argv[i + 1];
        if (valueFlags.includes(name) && next !== undefined && !next.startsWith("-")) {
          flags[name] = next;
          i++;
        } else flags[name] = true;
      }
    } else positional.push(a);
  }
  return { positional, flags };
};

/** Line diff (LCS) for `policy edit`: "-" removed, "+" added, unchanged lines omitted. */
export const lineDiff = (before: string, after: string): string[] => {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out;
};

/** A node/bun/tsx interpreter rather than the compiled chalito-agent binary. */
const isInterpreter = (p: string) => /^(node|nodejs|bun|tsx)(\.exe)?$/i.test(basename(p));

export const defaultIo = (): CliIo => ({
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
  tty: { input: process.stdin, output: process.stdout },
  env: process.env,
  home: homedir(),
  platform: process.platform,
  runner: spawnRunner,
  fetch: fetch as unknown as FetchFn,
  now: Date.now,
  execPath: process.execPath,
  tmpdir: tmpdir(),
});

export const main = async (argv: string[], io: CliIo = defaultIo()): Promise<number> => {
  const { positional, flags } = parseArgs(argv);
  const [cmd, sub, arg] = positional;
  const dir = chalitoDir(io.home);
  let cfg: AgentConfig | null = null;
  try {
    cfg = readConfig(dir, io.env);
  } catch {
    /* not configured yet: commands that need it say so */
  }
  const locale = cfg?.locale ?? envLocale(io.env);
  const t = T[locale];

  if (!cmd || flags.help || cmd === "help") {
    io.out(USAGE);
    return cmd || flags.help ? 0 : 1;
  }

  // Everything that changes trust, keys, policy, Developer mode or the service needs a human
  // at a real terminal, and never runs from inside an agent session (CHALITO_SESSION is set
  // by the adapters). Neither check alone is enough: `script -qc` supplies a pty.
  const mutating =
    ["pair", "keys", "service", "devmode", "claude", "codex"].includes(cmd) || (cmd === "policy" && sub === "edit");
  if (mutating) {
    if (io.env.CHALITO_SESSION !== undefined) {
      io.err(t.inSession);
      return 1;
    }
    if (!io.tty.input.isTTY || !io.tty.output.isTTY) {
      io.err(t.needTty);
      return 1;
    }
  }

  try {
    const secrets =
      io.secrets ??
      (await openSecretStore({
        env: io.env,
        prompt: async () => (await readHidden(io.tty, t.passphrase)) ?? "",
        warn: (m) => io.err(`${m}\n`),
      }));
    io = { ...io, secrets };
    switch (cmd) {
      case "run": {
        let d: Daemon;
        try {
          // Started by the desktop app: its per-launch IPC secret is the first line on stdin.
          const ipcSecret = io.env.CHALITO_IPC === "stdin" ? await readIpcSecret(io.tty.input) : null;
          d = await (io.daemon ?? runDaemon)({
            home: io.home,
            env: io.env,
            secrets,
            fetch: io.fetch,
            now: io.now,
            ipcSecret,
          });
        } catch (err) {
          // Distinct codes so the desktop supervisor neither races another agent nor
          // restarts in a loop while a setup step is missing.
          if (err instanceof AlreadyRunningError) {
            io.err(`${err.message}\n`);
            return EXIT_ALREADY_RUNNING;
          }
          if (err instanceof OnboardingError) {
            io.err(`${err.message}\n`);
            return EXIT_NEEDS_SETUP;
          }
          throw err;
        }
        await d.done;
        return 0;
      }

      case "pair": {
        const reader = new LineReader(io.tty);
        try {
          const res = await runPair({
            dir: ensureChalitoDir(dir),
            env: io.env,
            secrets,
            fetch: io.fetch,
            confirm: async (q) => isYes(await reader.ask(q)),
            confirmTyped: async (q, phrase) => (await reader.ask(q))?.trim() === phrase,
            osAuth: osAuthFor(io.platform, io.runner, (m) => io.err(`${m}\n`), locale, io.osStat),
            out: io.out,
            now: io.now,
            platform: io.platform,
            kind: flags.laptop ? "laptop" : "desktop",
            ...(io.pairWatcher ? { watcher: io.pairWatcher } : {}),
            ...(io.hostname ? { hostname: io.hostname } : {}),
          });
          return res.ok ? 0 : 1;
        } finally {
          reader.close();
        }
      }

      case "status":
        await status(io, secrets, dir, cfg);
        return 0;

      case "devmode":
        return await devmode(io, dir, locale, sub, arg);

      case "policy":
        return await policy(io, dir, locale, sub);

      case "keys": {
        if (sub !== "set" || !arg || !(arg in KEY_NAMES)) {
          io.err(USAGE);
          return 1;
        }
        const provider = arg as keyof typeof KEY_NAMES;
        const value = ((await readHidden(io.tty, t.keyPrompt(provider))) ?? "").trim();
        if (!value) {
          io.err(t.keyEmpty);
          return 1;
        }
        if (!KEY_SHAPE[provider].test(value)) io.err(t.keyShape(provider));
        await secrets.set(KEY_NAMES[provider], value);
        io.out(t.keySaved(provider));
        // Setup time: pin the coding agent now if this computer is paired and nothing is pinned yet.
        const tool = provider === "anthropic" ? "claude" : provider === "openai" ? "codex" : null;
        if (tool && cfg && isPaired(cfg) && !cfg[tool]) {
          const found = which(tool, io.env, io.platform);
          if (found) await toolPin(io, dir, locale, tool, found);
          else io.err(tool === "claude" ? t.claudeNotFound : t.codexNotFound);
        }
        return 0;
      }

      case "claude":
      case "codex": {
        if (sub !== "pin") {
          io.err(USAGE);
          return 1;
        }
        const found = arg ?? which(cmd, io.env, io.platform);
        if (!found) {
          io.err(cmd === "claude" ? t.claudeNotFound : t.codexNotFound);
          return 1;
        }
        return await toolPin(io, dir, locale, cmd, found);
      }

      case "service":
        return await service(io, sub, flags.bin, locale, flags["passphrase-file"]);

      default:
        io.err(t.unknown(cmd) + USAGE);
        return 1;
    }
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
};

/** Resolves and hashes `found`, then rewrites the signed config with the pin. */
const toolPin = async (
  io: CliIo,
  dir: string,
  locale: "es" | "en",
  tool: "claude" | "codex",
  found: string,
): Promise<number> => {
  const t = T[locale];
  const needsPair = tool === "claude" ? t.pinNeedsPair : t.codexPinNeedsPair;
  const id = await loadOrCreateIdentity(io.secrets!);
  let cfg: AgentConfig;
  try {
    cfg = readConfig(dir, io.env, { keys: id.sign });
  } catch {
    io.err(needsPair);
    return 1;
  }
  if (!isPaired(cfg)) {
    io.err(needsPair);
    return 1;
  }
  const pin = await pinClaude(found);
  writeConfig(dir, { ...cfg, [tool]: pin }, id.sign);
  io.out((tool === "claude" ? t.pinned : t.codexPinned)(pin.path, pin.sha256));
  return 0;
};

const status = async (io: CliIo, secrets: SecretStore, dir: string, cfg: AgentConfig | null) => {
  const lines: string[] = ["Chalito agent"];
  const row = (k: string, v: string) => lines.push(`  ${k.padEnd(16)} ${v}`);
  if (!cfg) row("Config", `missing (${join(dir, "config.json")})`);
  row("Paired", cfg && isPaired(cfg) ? `yes (owner ${cfg.owner})` : "no — run `chalito pair`");

  const hasIdentity = (await secrets.get(SECRET_NAMES.identity)) !== null;
  const anchor = await new AnchorStore(secrets).load();
  if (hasIdentity) {
    const id = await loadOrCreateIdentity(secrets);
    if (cfg)
      try {
        readConfig(dir, io.env, { keys: id.sign });
        row("Config", "signed");
      } catch (err) {
        row(
          "Config",
          err instanceof ConfigTamperedError ? "CHANGED outside chalito (ignored by the agent)" : "unsigned",
        );
      }
    row("Device", id.deviceId);
    row("Fingerprint", id.fingerprint);
    const trust = await new TrustStore(dir, id.sign, id.deviceId).load();
    row(
      "Trusted clients",
      trust.tampered ? "0 (list failed its signature check: re-pair)" : String(trust.list.toJSON().length),
    );
  } else row("Device", "no identity yet (created by `chalito pair`)");

  const policyFile = join(dir, "policy.yaml");
  if (existsSync(policyFile) && hasIdentity) {
    const holder = new FilePolicyHolder(dir, (await loadOrCreateIdentity(secrets)).sign, { anchor });
    const p = holder.get();
    row(
      "Policy",
      `${policyFile} (policyHash ${holder.hash.slice(0, 12)}…, ${p.workspaces.length} workspace(s))` +
        (holder.tamperReason === "rollback"
          ? " — an OLDER signed policy was restored: refused, nothing runs until `chalito policy edit`"
          : holder.tampered
            ? " — edited without `chalito policy edit`: refused, signed policy in force"
            : ""),
    );
  } else if (existsSync(policyFile)) row("Policy", `${policyFile} (not verifiable yet: no device identity)`);
  else row("Policy", "defaults (no file yet, no workspaces: nothing runs)");

  if (hasIdentity && existsSync(dir)) {
    const id = await loadOrCreateIdentity(secrets);
    const dm = new DevModeStore(dir, id.sign, id.deviceId, anchor).inspect();
    row(
      "Developer mode",
      (dm.state.on ? `ACTIVE (${dm.state.toggles.join(", ")})` : "off") +
        (dm.tampered ? ` — devmode files failed verification (${dm.tampered}), forced off` : ""),
    );
  } else row("Developer mode", "off");

  const keys = await Promise.all(
    Object.entries(KEY_NAMES).map(async ([p, n]) => `${p}: ${(await secrets.get(n)) ? "set" : "missing"}`),
  );
  row("Keys", keys.join(", "));
  row(
    "Claude Code",
    cfg?.claude
      ? `${cfg.claude.path} (pinned, sha256 ${cfg.claude.sha256.slice(0, 12)}…)`
      : "not pinned — `chalito claude pin`",
  );
  row(
    "Codex",
    cfg?.codex
      ? `${cfg.codex.path} (pinned, sha256 ${cfg.codex.sha256.slice(0, 12)}…)`
      : "not pinned — `chalito codex pin` (optional)",
  );
  let svc = "unknown";
  try {
    const f = servicePlan(io.platform, "chalito-agent", { home: io.home }).files[0]!.path;
    svc = existsSync(f) ? `installed (${f})` : "not installed";
  } catch {
    /* unsupported platform */
  }
  row("Service", svc);
  io.out(`${lines.join("\n")}\n`);
};

const devmode = async (io: CliIo, dir: string, locale: "es" | "en", sub?: string, arg?: string) => {
  const t = T[locale];
  ensureChalitoDir(dir);
  const reader = new LineReader(io.tty);
  try {
    const id = await loadOrCreateIdentity(io.secrets!);
    const dm = new DevMode({
      store: new DevModeStore(dir, id.sign, id.deviceId, await new AnchorStore(io.secrets!).load()),
      osAuth: osAuthFor(io.platform, io.runner, (m) => io.err(`${m}\n`), locale, io.osStat),
      prompter: new TtyPrompter(reader, io.out, locale),
      liability: loadLiabilityText(locale),
      deviceId: id.deviceId,
      now: io.now,
      // The running daemon notices devmode.json and reports it; the liability record is already on disk.
      emit: async () => undefined,
    });

    if (sub === "on") {
      if (!arg || !(ON_TOGGLES as readonly string[]).includes(arg)) {
        io.err(t.toggleOnUsage);
        return 1;
      }
      const res = await dm.enableToggle(arg as (typeof ON_TOGGLES)[number]);
      if (res.ok) {
        io.out(t.enabled(arg));
        return 0;
      }
      io.err(res.reason === "os_auth_failed" ? t.authFailed : t.cancelled);
      return 1;
    }
    if (sub === "reset") {
      io.out(t.resetWarn);
      const res = await dm.reset("local", async () => (await reader.ask(t.resetPrompt))?.trim() === t.resetPhrase);
      if (res.ok) {
        io.out(t.resetDone);
        return 0;
      }
      io.err(res.reason === "os_auth_failed" ? t.authFailed : t.cancelled);
      return 1;
    }
    if (sub === "off") {
      if (arg === undefined) {
        await dm.off("local");
        io.out(t.off);
        return 0;
      }
      const toggle = DevModeToggle.safeParse(arg);
      if (!toggle.success) {
        io.err(USAGE);
        return 1;
      }
      await dm.toggleOff(toggle.data, "local");
      io.out(t.toggleOff(arg));
      return 0;
    }
    io.err(USAGE);
    return 1;
  } finally {
    reader.close();
  }
};

const policy = async (io: CliIo, dir: string, locale: "es" | "en", sub?: string) => {
  const t = T[locale];
  const id = await loadOrCreateIdentity(io.secrets!);
  const holder = new FilePolicyHolder(dir, id.sign, { anchor: await new AnchorStore(io.secrets!).load() });
  if (sub === "path") {
    io.out(`${holder.file}\n`);
    return 0;
  }
  if (sub === "show") {
    io.out(policyToYaml(holder.get()) + `\n# policyHash (in force): ${holder.hash}\n`);
    if (holder.tampered) io.err(t.policyRefused);
    return 0;
  }
  if (sub !== "edit") {
    io.err(USAGE);
    return 1;
  }

  // Edit a private temp copy; the real file only changes after validation + local confirmation.
  const tmp = mkdtempSync(join(io.tmpdir, "chalito-policy-"));
  try {
    const file = join(tmp, "policy.yaml");
    // Start from the yaml on disk when it parses: a hand edit that was refused for lacking
    // the signed lock can be reviewed and confirmed here, which is the legitimate path.
    const before = policyToYaml(holder.get());
    const onDisk = existsSync(holder.file) ? readFileSync(holder.file, "utf8") : before;
    writeFileSync(file, parsePolicyYaml(onDisk).ok ? onDisk : before, { mode: 0o600 });
    const [editor, ...editorArgs] = (
      io.env.VISUAL ||
      io.env.EDITOR ||
      (io.platform === "win32" ? "notepad" : "vi")
    ).split(/\s+/);
    const res = await io.runner.run(editor!, [...editorArgs, file], { interactive: true });
    if (res.code !== 0) {
      io.err(t.editorFailed(res.code));
      return 1;
    }
    const parsed = parsePolicyYaml(readFileSync(file, "utf8"));
    if (!parsed.ok) {
      io.err(t.invalidPolicy(parsed.error));
      return 1;
    }
    if (policyHash(parsed.policy) === holder.hash) {
      io.out(t.noChanges);
      return 0;
    }
    io.out(`${lineDiff(before, policyToYaml(parsed.policy)).join("\n")}\n\n`);
    const reader = new LineReader(io.tty);
    try {
      if (!isYes(await reader.ask(t.applyPolicy))) {
        io.out(t.cancelled);
        return 1;
      }
    } finally {
      reader.close();
    }
    // Loosening is a human decision at the OS prompt, not a "y" on stdin.
    if (!isTighterOrEqual(parsed.policy, holder.get())) {
      io.out(t.looseningAuth);
      const auth = osAuthFor(io.platform, io.runner, (m) => io.err(`${m}\n`), locale, io.osStat);
      if (!(await auth.verify("Chalito: aflojar la política local"))) {
        io.err(t.authFailed);
        return 1;
      }
    }
    await holder.set(parsed.policy, "local");
    io.out(t.policySaved(holder.hash));
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

const service = async (
  io: CliIo,
  sub: string | undefined,
  binFlag: string | true | undefined,
  locale: "es" | "en",
  passphraseFlag?: string | true,
) => {
  const t = T[locale];
  if (sub !== "install" && sub !== "uninstall") {
    io.err(USAGE);
    return 1;
  }
  const bin = typeof binFlag === "string" ? resolve(binFlag) : isInterpreter(io.execPath) ? null : io.execPath;
  if (!bin) {
    io.err(t.needBin);
    return 1;
  }
  // --passphrase-file: a 0600 file the systemd unit loads as a credential (Linux only).
  let passphraseFile: string | undefined;
  if (typeof passphraseFlag === "string") {
    passphraseFile = resolve(passphraseFlag);
    const problem = passphraseFileProblem(passphraseFile);
    if (problem) {
      io.err(t.badPassphraseFile(passphraseFile, problem));
      return 1;
    }
  }
  const plan = servicePlan(io.platform, bin, { home: io.home, ...(passphraseFile ? { passphraseFile } : {}) });

  if (sub === "install") {
    mkdirSync(join(chalitoDir(io.home), "logs"), { recursive: true, mode: 0o700 });
    for (const f of plan.files) {
      mkdirSync(dirname(f.path), { recursive: true });
      // 0600 even when the file already existed (the mode option only applies on create).
      writeFileSync(f.path, f.content, { mode: 0o600 });
      chmodSync(f.path, 0o600);
    }
    for (const c of plan.install) {
      const r = await io.runner.run(c[0]!, c.slice(1));
      if (r.code !== 0) {
        io.err(t.cmdFailed(c.join(" "), (r.stderr || r.stdout).trim()));
        return 1;
      }
    }
    io.out(t.installed(plan.files.map((f) => f.path).join(", ")));
    return 0;
  }

  let ok = true;
  for (const c of plan.uninstall) {
    const r = await io.runner.run(c[0]!, c.slice(1));
    if (r.code !== 0) {
      ok = false;
      io.err(t.cmdFailed(c.join(" "), (r.stderr || r.stdout).trim()));
    }
  }
  for (const f of plan.files) rmSync(f.path, { force: true });
  io.out(t.uninstalled);
  return ok ? 0 : 1;
};

const isEntry = (() => {
  const meta = import.meta as ImportMeta & { main?: boolean };
  if (typeof meta.main === "boolean") return meta.main;
  const argv1 = process.argv[1];
  return argv1 !== undefined && resolve(argv1) === fileURLToPath(import.meta.url);
})();

if (isEntry) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      // A broken keychain addon is the person's problem to fix (reinstall): say so plainly.
      if (err instanceof KeyringUnavailableError) {
        console.error(err.message);
        process.exit(3);
      }
      // Redacted: a crash message can carry a key or token (R-M9).
      console.error(redactError(err));
      process.exit(1);
    },
  );
}
