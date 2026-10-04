import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { DevModeToggle, Locale } from "@chalito/protocol";
import type { LiabilityText } from "@chalito/config";
import type { SigningKeyPair } from "@chalito/crypto";
import { signLocal, verifyLocal } from "./local-sig.js";
import type { AnchorStore } from "./anchor.js";
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
  /** Agent-key signature over the record (prevHash and hash included). */
  sig: string;
}

/** Turning toggles off is chained too, so an old signed state can't be replayed after it. */
export interface DisableRecord {
  type: "devmode.disabled";
  toggles: DevModeToggle[];
  deviceId: string;
  by: string;
  t: number;
  prevHash: string;
  hash: string;
  sig: string;
}

/** First record of a new chain after `chalito devmode reset` archived a broken one. */
export interface ResetRecord {
  type: "devmode.reset";
  deviceId: string;
  by: string;
  epoch: number;
  /** File name the previous chain was archived under (in audit/). */
  archived: string | null;
  t: number;
  prevHash: string;
  hash: string;
  sig: string;
}

export type AuditRecord = LiabilityRecord | DisableRecord | ResetRecord;
type Unsealed<R> = R extends AuditRecord ? Omit<R, "prevHash" | "hash" | "sig"> : never;

export type DevModeTamper = "state_signature" | "audit_chain" | "stale_state" | "toggle_unbacked" | "rollback";

const GENESIS = "0".repeat(64);

/**
 * ~/.chalito/devmode.json + ~/.chalito/audit/devmode.jsonl (append-only, hash-chained).
 *
 * Both are signed with the agent key, so a shell write that slips past the classifier
 * can't turn anything on: the state file must carry a valid signature and point at the
 * current head of the audit chain, every audit line must be signed, and every enabled
 * toggle needs a signed liability record newer than its last disable. Anything that
 * fails reads as OFF and is reported as tampering. A missing state file is plain OFF.
 */
export class DevModeStore {
  #pending: Promise<void> = Promise.resolve();
  #locked = false;

  /**
   * `anchor` keeps the chain head in the keychain. With it, truncating the audit log or
   * restoring an older devmode.json + log pair reads as rollback (off). Production always
   * passes it; tests of unrelated behaviour may omit it.
   */
  constructor(
    readonly dir: string,
    private readonly keys: SigningKeyPair,
    private readonly deviceId: string,
    private readonly anchor?: AnchorStore,
  ) {
    mkdirSync(join(dir, "audit"), { recursive: true, mode: 0o700 });
  }

  get #stateFile() {
    return join(this.dir, "devmode.json");
  }
  get #auditFile() {
    return join(this.dir, "audit", "devmode.jsonl");
  }
  get #lockFile() {
    return join(this.dir, "audit", "devmode.lock");
  }

  /**
   * Runs `fn` holding an exclusive lock file, so the CLI (`devmode on`) and the daemon
   * (`devmode.off` from a phone) never append at the same time and fork the chain.
   * A lock older than 30 s is taken over (its holder died).
   */
  async transact<T>(fn: () => Promise<T>, timeoutMs = 5000): Promise<T> {
    if (this.#locked) return fn();
    const t0 = Date.now();
    for (;;) {
      try {
        closeSync(openSync(this.#lockFile, "wx", 0o600));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          if (Date.now() - statSync(this.#lockFile).mtimeMs > 30_000) rmSync(this.#lockFile, { force: true });
        } catch {
          /* released meanwhile */
        }
        if (Date.now() - t0 > timeoutMs)
          throw new Error("Developer mode is being changed by another process. Try again.", { cause: err });
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    this.#locked = true;
    try {
      return await fn();
    } finally {
      this.#locked = false;
      rmSync(this.#lockFile, { force: true });
    }
  }

  /**
   * Archives the current chain (kept for audit), starts a new epoch with a signed reset
   * record and writes an OFF state. The way out of a forked or broken chain; the caller
   * (`chalito devmode reset`) does OS auth and a typed confirmation first.
   */
  async resetChain(by: string, now: number): Promise<ResetRecord> {
    return this.transact(async () => {
      const old = this.records();
      const oldEpoch = old[0]?.type === "devmode.reset" ? old[0].epoch : 0;
      const epoch = Math.max(oldEpoch, this.anchor?.devmodeHead()?.epoch ?? 0) + 1;
      let archived: string | null = null;
      if (existsSync(this.#auditFile)) {
        archived = `devmode.${now}.archived.jsonl`;
        renameSync(this.#auditFile, join(this.dir, "audit", archived));
      }
      const rec = this.append<ResetRecord>({
        type: "devmode.reset",
        deviceId: this.deviceId,
        by,
        epoch,
        archived,
        t: now,
      });
      await this.flush();
      this.write(DEVMODE_OFF);
      return rec;
    });
  }

  /** Verified state plus the reason it was forced off, if any. */
  inspect(): { state: DevModeState; tampered: DevModeTamper | null } {
    if (!existsSync(this.#stateFile)) return { state: DEVMODE_OFF, tampered: null };
    let file: { deviceId?: unknown; state?: DevModeState; chainHead?: unknown; sig?: unknown };
    try {
      file = JSON.parse(readFileSync(this.#stateFile, "utf8")) as typeof file;
    } catch {
      return { state: DEVMODE_OFF, tampered: "state_signature" };
    }
    const { sig, ...body } = file;
    if (
      body.deviceId !== this.deviceId ||
      !body.state ||
      !verifyLocal("chalito.devmode-state.v1", body, sig, this.keys.publicKey)
    )
      return { state: DEVMODE_OFF, tampered: "state_signature" };
    const records = this.#verifiedRecords();
    if (!records) return { state: DEVMODE_OFF, tampered: "audit_chain" };
    if (!this.#containsKeychainHead(records)) return { state: DEVMODE_OFF, tampered: "rollback" };
    if (body.chainHead !== (records.at(-1)?.hash ?? GENESIS)) return { state: DEVMODE_OFF, tampered: "stale_state" };

    const state = body.state;
    if (!state.on) return { state: DEVMODE_OFF, tampered: null };
    const backed = state.toggles.filter((toggle) => {
      const lastAccept = records.findLastIndex((r) => r.type === "devmode.liability_accepted" && r.toggle === toggle);
      const lastDisable = records.findLastIndex((r) => r.type === "devmode.disabled" && r.toggles.includes(toggle));
      return lastAccept > lastDisable;
    });
    if (backed.length !== state.toggles.length) {
      const s: DevModeState = backed.length ? { ...state, toggles: backed } : DEVMODE_OFF;
      return { state: s, tampered: "toggle_unbacked" };
    }
    return { state, tampered: null };
  }

  read(): DevModeState {
    return this.inspect().state;
  }

  write(state: DevModeState): void {
    const body = { deviceId: this.deviceId, state, chainHead: this.records().at(-1)?.hash ?? GENESIS };
    const tmp = `${this.#stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...body, sig: signLocal("chalito.devmode-state.v1", body, this.keys) }), {
      mode: 0o600,
    });
    renameSync(tmp, this.#stateFile);
  }

  records(): AuditRecord[] {
    if (!existsSync(this.#auditFile)) return [];
    return readFileSync(this.#auditFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AuditRecord);
  }

  liabilityRecords(): LiabilityRecord[] {
    return this.records().filter((r): r is LiabilityRecord => r.type === "devmode.liability_accepted");
  }

  append<R extends AuditRecord>(rec: Unsealed<R>): R {
    const prevHash = this.records().at(-1)?.hash ?? GENESIS;
    const hash = createHash("sha256").update(prevHash).update(JSON.stringify(rec)).digest("hex");
    const unsigned = { ...rec, prevHash, hash };
    const full = { ...unsigned, sig: signLocal("chalito.devmode-liability.v1", unsigned, this.keys) } as unknown as R;
    appendFileSync(this.#auditFile, `${JSON.stringify(full)}\n`, { mode: 0o600 });
    if (this.anchor) {
      const records = this.records();
      const first = records[0];
      const head = {
        hash: (full as AuditRecord).hash,
        count: records.length,
        epoch: first?.type === "devmode.reset" ? first.epoch : 0,
      };
      // A failed keychain write surfaces from flush() but doesn't block the next one.
      this.#pending = this.#pending.catch(() => undefined).then(() => this.anchor!.setDevmodeHead(head));
    }
    return full;
  }

  /**
   * The log may be longer than the keychain head (a write whose keychain update failed,
   * or another process's append this one hasn't reloaded); it may never be shorter or
   * diverge from it. No head while records exist means the head was removed.
   */
  #containsKeychainHead(records: AuditRecord[]): boolean {
    if (!this.anchor) return true;
    const h = this.anchor.devmodeHead();
    if (!h) return records.length === 0;
    const first = records[0];
    const epoch = first?.type === "devmode.reset" ? first.epoch : 0;
    if (epoch !== h.epoch) return false;
    return records.length >= h.count && (h.count === 0 || records[h.count - 1]?.hash === h.hash);
  }

  /** Waits for the keychain write of the latest append. */
  flush(): Promise<void> {
    return this.#pending;
  }

  /** True when no line was edited, removed from the middle, or written without the agent key. */
  verifyChain(): boolean {
    return this.#verifiedRecords() !== null;
  }

  #verifiedRecords(): AuditRecord[] | null {
    let records: AuditRecord[];
    try {
      records = this.records();
    } catch {
      return null;
    }
    let prev = GENESIS;
    for (const [i, r] of records.entries()) {
      const { prevHash, hash, sig, ...rest } = r;
      if (prevHash !== prev || rest.deviceId !== this.deviceId) return null;
      // A reset can only start a chain.
      if (rest.type === "devmode.reset" && i !== 0) return null;
      if (createHash("sha256").update(prevHash).update(JSON.stringify(rest)).digest("hex") !== hash) return null;
      if (!verifyLocal("chalito.devmode-liability.v1", { ...rest, prevHash, hash }, sig, this.keys.publicKey))
        return null;
      prev = hash;
    }
    return records;
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
  #lastTamper: DevModeTamper | null = null;

  constructor(private readonly deps: DevModeDeps) {}

  /** Verified on every read; tampering reads as off and is emitted once per occurrence. */
  get state(): DevModeState {
    const { state, tampered } = this.deps.store.inspect();
    if (tampered !== this.#lastTamper) {
      this.#lastTamper = tampered;
      if (tampered) void this.deps.emit({ type: "devmode.tampered", reason: tampered }).catch(() => undefined);
    }
    return state;
  }

  async enableToggle(toggle: DevModeToggle): Promise<EnableResult> {
    const { store, osAuth, prompter, liability, deviceId, now, emit } = this.deps;
    if (!(await osAuth.verify(`Chalito: activar ${toggle}`))) return { ok: false, reason: "os_auth_failed" };
    const copy = RISK_COPY[liability.locale][toggle];
    if (!(await prompter.first(toggle, copy.examples))) return { ok: false, reason: "cancelled" };
    if (!(await prompter.second(toggle, copy.risk))) return { ok: false, reason: "cancelled" };
    const accepted = await prompter.liability(liability);
    if (!accepted.checked || accepted.typed.trim() !== liability.phrase) return { ok: false, reason: "cancelled" };

    const { rec, state } = await store.transact(async () => {
      // Read before appending: the state is bound to the chain head it was written with.
      const cur = this.state;
      const rec = store.append<LiabilityRecord>({
        type: "devmode.liability_accepted",
        toggle,
        deviceId,
        locale: liability.locale,
        textVersion: liability.version,
        text: liability.text,
        t: now(),
      });
      await store.flush();
      const state: DevModeState = {
        on: true,
        toggles: [...new Set([...cur.toggles, toggle])],
        since: cur.since ?? now(),
      };
      store.write(state);
      return { rec, state };
    });
    await emit({ type: "devmode.liability_accepted", toggle, textVersion: rec.textVersion, hash: rec.hash });
    await emit({ type: "devmode.changed", on: true, toggles: state.toggles });
    return { ok: true, state };
  }

  /** Always allowed, locally or from a verified signed remote command. */
  async off(by: string): Promise<DevModeState> {
    const { store } = this.deps;
    await store.transact(async () => {
      const cur = store.read();
      store.append<DisableRecord>({
        type: "devmode.disabled",
        toggles: cur.toggles,
        deviceId: this.deps.deviceId,
        by,
        t: this.deps.now(),
      });
      await store.flush();
      store.write(DEVMODE_OFF);
    });
    await this.deps.emit({ type: "devmode.changed", on: false, toggles: [], by });
    return DEVMODE_OFF;
  }

  async toggleOff(toggle: DevModeToggle, by: string): Promise<DevModeState> {
    const { store } = this.deps;
    const state = await store.transact(async () => {
      const cur = store.read();
      const toggles = cur.toggles.filter((t) => t !== toggle);
      store.append<DisableRecord>({
        type: "devmode.disabled",
        toggles: [toggle],
        deviceId: this.deps.deviceId,
        by,
        t: this.deps.now(),
      });
      await store.flush();
      const next: DevModeState = toggles.length ? { ...cur, toggles } : DEVMODE_OFF;
      store.write(next);
      return next;
    });
    await this.deps.emit({ type: "devmode.changed", on: state.on, toggles: state.toggles, by });
    return state;
  }

  /**
   * Local only: archives a broken or forked audit chain and starts a new one with
   * everything off. Needs OS auth plus the caller's typed confirmation.
   */
  async reset(
    by: string,
    confirmTyped: () => Promise<boolean>,
  ): Promise<{ ok: true } | { ok: false; reason: "os_auth_failed" | "cancelled" }> {
    if (!(await this.deps.osAuth.verify("Chalito: reiniciar el registro del Modo desarrollador")))
      return { ok: false, reason: "os_auth_failed" };
    if (!(await confirmTyped())) return { ok: false, reason: "cancelled" };
    const rec = await this.deps.store.resetChain(by, this.deps.now());
    this.#lastTamper = null;
    await this.deps.emit({ type: "devmode.reset", epoch: rec.epoch, archived: rec.archived, hash: rec.hash });
    await this.deps.emit({ type: "devmode.changed", on: false, toggles: [], by });
    return { ok: true };
  }
}
