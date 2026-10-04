import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLiabilityText } from "@chalito/config";
import { DevModeToggle } from "@chalito/protocol";
import type { FetchFn, PairingWatcher } from "./cloud.js";
import { chalitoDir, ensureChalitoDir, envLocale, isPaired, readConfig, type AgentConfig } from "./config.js";
import { runDaemon, type DaemonDeps, type Daemon } from "./daemon.js";
import { ChainHeadStore, DevMode, DevModeStore } from "./devmode.js";
import { loadOrCreateIdentity } from "./identity.js";
import { osAuthFor } from "./os-auth.js";
import { runPair } from "./pair.js";
import { FilePolicyHolder, parsePolicyYaml, policyToYaml } from "./policy-file.js";
import { policyHash } from "./policy/index.js";
import { spawnRunner, which, type ProcessRunner } from "./runner.js";
import { KeyringStore, SECRET_NAMES, type SecretStore } from "./secrets.js";
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
  secrets: SecretStore;
  runner: ProcessRunner;
  fetch: FetchFn;
  now: () => number;
  /** The running binary, used as the service's ExecStart unless --bin is given. */
  execPath: string;
  tmpdir: string;
  daemon?: (deps: DaemonDeps) => Promise<Daemon>;
  pairWatcher?: PairingWatcher;
  hostname?: string;
}

export const USAGE = `chalito <command>

  run                                  run the agent (the OS service does this)
  pair [--laptop]                      pair this computer with your phone
  status                               show pairing, policy, Developer mode and keys
  devmode on <toggle>                  turn a Developer-mode toggle on (local only, 3 confirmations)
  devmode off [toggle]                 turn Developer mode (or one toggle) off
  policy show|path|edit                show, locate or edit ~/.chalito/policy.yaml
  keys set anthropic|openai|xai        save a BYO API key in the OS keychain
  service install|uninstall [--bin p]  register the agent as a per-user OS service

toggles: allowSudo, autoApproveHigh, autoApproveCritical
`;

const ON_TOGGLES = ["allowSudo", "autoApproveHigh", "autoApproveCritical"] as const;
const KEY_NAMES = {
  anthropic: SECRET_NAMES.anthropicApiKey,
  openai: SECRET_NAMES.openaiApiKey,
  xai: SECRET_NAMES.xaiApiKey,
} as const;

const T = {
  es: {
    unknown: (c: string) => `Comando desconocido: ${c}\n`,
    toggleOnUsage: `Uso: chalito devmode on <${ON_TOGGLES.join("|")}>\n`,
    needTty: "El Modo desarrollador solo se activa desde una terminal interactiva.\n",
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
    installed: (f: string) => `Servicio instalado (${f}).\n`,
    uninstalled: "Servicio desinstalado.\n",
    cmdFailed: (c: string, e: string) => `Falló \`${c}\`: ${e}\n`,
  },
  en: {
    unknown: (c: string) => `Unknown command: ${c}\n`,
    toggleOnUsage: `Usage: chalito devmode on <${ON_TOGGLES.join("|")}>\n`,
    needTty: "Developer mode can only be turned on from an interactive terminal.\n",
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
export const parseArgs = (argv: string[], valueFlags: readonly string[] = ["bin"]): ParsedArgs => {
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
  secrets: new KeyringStore(),
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

  try {
    switch (cmd) {
      case "run": {
        const d = await (io.daemon ?? runDaemon)({
          home: io.home,
          env: io.env,
          secrets: io.secrets,
          fetch: io.fetch,
          now: io.now,
        });
        await d.done;
        return 0;
      }

      case "pair": {
        const reader = new LineReader(io.tty);
        try {
          const res = await runPair({
            dir: ensureChalitoDir(dir),
            env: io.env,
            secrets: io.secrets,
            fetch: io.fetch,
            confirm: async (q) => isYes(await reader.ask(q)),
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
        await status(io, dir, cfg);
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
        await io.secrets.set(KEY_NAMES[provider], value);
        io.out(t.keySaved(provider));
        return 0;
      }

      case "service":
        return await service(io, sub, flags.bin, locale);

      default:
        io.err(t.unknown(cmd) + USAGE);
        return 1;
    }
  } catch (err) {
    io.err(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
};

const status = async (io: CliIo, dir: string, cfg: AgentConfig | null) => {
  const lines: string[] = ["Chalito agent"];
  const row = (k: string, v: string) => lines.push(`  ${k.padEnd(16)} ${v}`);
  if (!cfg) row("Config", `missing (${join(dir, "config.json")})`);
  row("Paired", cfg && isPaired(cfg) ? `yes (owner ${cfg.owner})` : "no — run `chalito pair`");

  const hasIdentity = (await io.secrets.get(SECRET_NAMES.identity)) !== null;
  if (hasIdentity) {
    const id = await loadOrCreateIdentity(io.secrets);
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
    const holder = new FilePolicyHolder(dir, (await loadOrCreateIdentity(io.secrets)).sign);
    const p = holder.get();
    row(
      "Policy",
      `${policyFile} (policyHash ${holder.hash.slice(0, 12)}…, ${p.workspaces.length} workspace(s))` +
        (holder.tampered ? " — edited without `chalito policy edit`: refused, signed policy in force" : ""),
    );
  } else if (existsSync(policyFile)) row("Policy", `${policyFile} (not verifiable yet: no device identity)`);
  else row("Policy", "defaults (no file yet, no workspaces: nothing runs)");

  if (hasIdentity && existsSync(dir)) {
    const id = await loadOrCreateIdentity(io.secrets);
    const head = await new ChainHeadStore(io.secrets).load();
    const dm = new DevModeStore(dir, id.sign, id.deviceId, head).inspect();
    row(
      "Developer mode",
      (dm.state.on ? `ACTIVE (${dm.state.toggles.join(", ")})` : "off") +
        (dm.tampered ? ` — devmode files failed verification (${dm.tampered}), forced off` : ""),
    );
  } else row("Developer mode", "off");

  const keys = await Promise.all(
    Object.entries(KEY_NAMES).map(async ([p, n]) => `${p}: ${(await io.secrets.get(n)) ? "set" : "missing"}`),
  );
  row("Keys", keys.join(", "));
  row("Claude Code", cfg?.claudePath ?? which("claude", io.env, io.platform) ?? "not found");
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
    const id = await loadOrCreateIdentity(io.secrets);
    const dm = new DevMode({
      store: new DevModeStore(dir, id.sign, id.deviceId, await new ChainHeadStore(io.secrets).load()),
      osAuth: osAuthFor(io.platform, io.runner, (m) => io.err(`${m}\n`), locale),
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
      if (!io.tty.input.isTTY) {
        io.err(t.needTty);
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
  const id = await loadOrCreateIdentity(io.secrets);
  const holder = new FilePolicyHolder(dir, id.sign);
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
    await holder.set(parsed.policy, "local");
    io.out(t.policySaved(holder.hash));
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

const service = async (io: CliIo, sub: string | undefined, binFlag: string | true | undefined, locale: "es" | "en") => {
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
  const plan = servicePlan(io.platform, bin, { home: io.home });

  if (sub === "install") {
    mkdirSync(join(chalitoDir(io.home), "logs"), { recursive: true, mode: 0o700 });
    for (const f of plan.files) {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.content, { mode: 0o644 });
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
      console.error(err);
      process.exit(1);
    },
  );
}
