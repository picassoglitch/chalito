import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DevModeToggle, Locale } from "@chalito/protocol";
import type { LiabilityText } from "@chalito/config";
import { DEVMODE_OFF, type DevModeState } from "./policy/decide.js";

/** OS user authentication (macOS LocalAuthentication, Windows Hello, polkit/PAM on Linux). */
export interface OsAuth {
  verify(reason: string): Promise<boolean>;
}

/** The three separate confirmations, rendered by the desktop app or the CLI (a TTY). */
export interface ConfirmPrompter {
  /** 1: "¿Activar {toggle}?" with concrete examples of what can go wrong. */
  first(toggle: DevModeToggle, examples: string[]): Promise<boolean>;
  /** 2: restates the risk. */
  second(toggle: DevModeToggle, risk: string): Promise<boolean>;
  /** 3: liability acceptance: checkbox + typed phrase. */
  liability(text: LiabilityText): Promise<{ checked: boolean; typed: string }>;
}

export const RISK_COPY: Record<Locale, Record<DevModeToggle, { examples: string[]; risk: string }>> = {
  es: {
    allowSudo: {
      examples: [
        "Instalar o borrar paquetes del sistema",
        "Cambiar permisos de archivos del sistema",
        "Detener servicios",
      ],
      risk: "sudo puede dañar tu sistema de forma irreversible.",
    },
    autoApproveHigh: {
      examples: ["Hacer git push sin preguntarte", "Borrar archivos", "Editar .env o la configuración de CI"],
      risk: "Las acciones de riesgo ALTO se ejecutarán sin tu aprobación.",
    },
    autoApproveCritical: {
      examples: ["Leer credenciales", "Forzar push a main", "Ejecutar scripts descargados"],
      risk: "Las acciones CRÍTICAS se ejecutarán sin tu aprobación. Puedes perder datos o exponer secretos.",
    },
    bypassStyle: {
      examples: ["Cualquier acción sin confirmación"],
      risk: "Nada pedirá confirmación.",
    },
  },
  en: {
    allowSudo: {
      examples: ["Install or remove system packages", "Change system file permissions", "Stop services"],
      risk: "sudo can damage your system irreversibly.",
    },
    autoApproveHigh: {
      examples: ["git push without asking you", "Delete files", "Edit .env or CI configuration"],
      risk: "HIGH-risk actions will run without your approval.",
    },
    autoApproveCritical: {
      examples: ["Read credentials", "Force-push to main", "Run downloaded scripts"],
      risk: "CRITICAL actions will run without your approval. You can lose data or expose secrets.",
    },
    bypassStyle: {
      examples: ["Any action without confirmation"],
      risk: "Nothing will ask for confirmation.",
    },
  },
};

export interface LiabilityRecord {
  type: "devmode.liability_accepted";
  toggle: DevModeToggle;
  deviceId: string;
  locale: Locale;
  textVersion: number;
  text: string;
  t: number;
  prevHash: string;
  hash: string;
}

/** ~/.chalito/devmode.json + ~/.chalito/audit/devmode.jsonl (append-only, hash-chained). */
export class DevModeStore {
  constructor(readonly dir: string) {
    mkdirSync(join(dir, "audit"), { recursive: true, mode: 0o700 });
  }

  get #stateFile() {
    return join(this.dir, "devmode.json");
  }
  get #auditFile() {
    return join(this.dir, "audit", "devmode.jsonl");
  }

  read(): DevModeState {
    if (!existsSync(this.#stateFile)) return DEVMODE_OFF;
    return JSON.parse(readFileSync(this.#stateFile, "utf8")) as DevModeState;
  }

  write(state: DevModeState): void {
    writeFileSync(this.#stateFile, JSON.stringify(state), { mode: 0o600 });
  }

  records(): LiabilityRecord[] {
    if (!existsSync(this.#auditFile)) return [];
    return readFileSync(this.#auditFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LiabilityRecord);
  }

  append(rec: Omit<LiabilityRecord, "prevHash" | "hash">): LiabilityRecord {
    const prevHash = this.records().at(-1)?.hash ?? "0".repeat(64);
    const hash = createHash("sha256").update(prevHash).update(JSON.stringify(rec)).digest("hex");
    const full = { ...rec, prevHash, hash };
    appendFileSync(this.#auditFile, `${JSON.stringify(full)}\n`, { mode: 0o600 });
    return full;
  }

  /** True when no line was edited or removed from the middle. */
  verifyChain(): boolean {
    let prev = "0".repeat(64);
    for (const r of this.records()) {
      const { prevHash, hash, ...rest } = r;
      if (prevHash !== prev) return false;
      if (createHash("sha256").update(prevHash).update(JSON.stringify(rest)).digest("hex") !== hash) return false;
      prev = hash;
    }
    return true;
  }
}

export interface DevModeDeps {
  store: DevModeStore;
  osAuth: OsAuth;
  prompter: ConfirmPrompter;
  liability: LiabilityText;
  deviceId: string;
  now: () => number;
  /** Cloud audit + DeviceEvent publisher. */
  emit: (event: { type: string; [k: string]: unknown }) => Promise<void>;
}

export type EnableResult = { ok: true; state: DevModeState } | { ok: false; reason: "os_auth_failed" | "cancelled" };

/**
 * Local-only. Turning Developer mode itself on needs OS auth + one confirmation; each
 * toggle needs OS auth + three separate confirmations. Cancelling at any step leaves
 * everything off and writes no acceptance.
 */
export class DevMode {
  constructor(private readonly deps: DevModeDeps) {}

  get state(): DevModeState {
    return this.deps.store.read();
  }

  async enableToggle(toggle: DevModeToggle): Promise<EnableResult> {
    const { store, osAuth, prompter, liability, deviceId, now, emit } = this.deps;
    if (!(await osAuth.verify(`Chalito: activar ${toggle}`))) return { ok: false, reason: "os_auth_failed" };
    const copy = RISK_COPY[liability.locale][toggle];
    if (!(await prompter.first(toggle, copy.examples))) return { ok: false, reason: "cancelled" };
    if (!(await prompter.second(toggle, copy.risk))) return { ok: false, reason: "cancelled" };
    const accepted = await prompter.liability(liability);
    if (!accepted.checked || accepted.typed.trim() !== liability.phrase) return { ok: false, reason: "cancelled" };

    const rec = store.append({
      type: "devmode.liability_accepted",
      toggle,
      deviceId,
      locale: liability.locale,
      textVersion: liability.version,
      text: liability.text,
      t: now(),
    });
    const cur = store.read();
    const state: DevModeState = {
      on: true,
      toggles: [...new Set([...cur.toggles, toggle])],
      since: cur.since ?? now(),
    };
    store.write(state);
    await emit({ type: "devmode.liability_accepted", toggle, textVersion: rec.textVersion, hash: rec.hash });
    await emit({ type: "devmode.changed", on: true, toggles: state.toggles });
    return { ok: true, state };
  }

  /** Always allowed, locally or from a verified signed remote command. */
  async off(by: string): Promise<DevModeState> {
    this.deps.store.write(DEVMODE_OFF);
    await this.deps.emit({ type: "devmode.changed", on: false, toggles: [], by });
    return DEVMODE_OFF;
  }

  async toggleOff(toggle: DevModeToggle, by: string): Promise<DevModeState> {
    const cur = this.deps.store.read();
    const toggles = cur.toggles.filter((t) => t !== toggle);
    const state: DevModeState = toggles.length ? { ...cur, toggles } : DEVMODE_OFF;
    this.deps.store.write(state);
    await this.deps.emit({ type: "devmode.changed", on: state.on, toggles: state.toggles, by });
    return state;
  }
}
