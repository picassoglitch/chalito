import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { z } from "zod";
import type { SecretStore } from "../secrets.js";
import { CONNECTOR_ID, ENV_NAME, type InputSpec } from "./catalog.js";
import { registryId, safeRemoteUrl } from "./registry.js";
import type { ConnectorEntry, InstalledConnector } from "./types.js";

export const CONNECTORS_FILE = "connectors.json";
/** Keychain name for one installed value (ADR 0023 §2); `account` is the header or env var it's sent as. */
export const connectorSecretName = (id: string, account: string) => `chalito.connector.${id}.${account}`;

export type ConnectorStoreCode =
  | "held_oauth"
  | "confirm_required"
  | "warning_required"
  | "already_installed"
  | "not_installed"
  | "missing_input"
  | "bad_input"
  | "bad_url"
  | "command_not_found"
  | "state_corrupt"
  | "keychain"
  | "write_failed";
export class ConnectorStoreError extends Error {
  constructor(readonly code: ConnectorStoreCode) {
    super(code);
    this.name = "ConnectorStoreError";
  }
}

const Server = z.union([
  z
    .object({
      package: z.string().min(1).max(300),
      version: z.string().min(1).max(100),
      integrity: z.string().max(200).optional(),
      command: z.string().min(1).max(4096),
      args: z.array(z.string().max(4096)).max(64),
    })
    .strict(),
  z.object({ url: z.string().max(2048).optional() }).strict(),
]);
const Installed = z
  .object({
    id: z.string().regex(CONNECTOR_ID),
    name: z.string().max(200),
    description: z.string().max(2000),
    source: z.enum(["verified", "community", "custom"]),
    transport: z.enum(["remote", "stdio"]),
    server: Server,
    auth: z.enum(["none", "token", "oauth"]),
    held: z.literal("oauth").optional(),
    installedAt: z.union([z.number().int().nonnegative(), z.string().max(64)]),
    confirmedWarning: z.boolean(),
    secretEnv: z.array(z.string().regex(ENV_NAME)).max(16).optional(),
  })
  .strict();
const StoreFile = z.object({ v: z.literal(1), installed: z.array(Installed).max(500) }).strict();
type StoreFile = z.infer<typeof StoreFile>;

/** Keychain accounts a connector uses (the proxy's convention): `token` for a remote, `secretEnv` names for stdio. */
export const secretAccounts = (c: InstalledConnector): string[] =>
  c.transport === "remote" ? (c.auth === "token" ? ["token"] : []) : [...(c.secretEnv ?? [])];

export interface InstallRequest {
  entry: ConnectorEntry;
  inputs: InputSpec[];
  /** What the person typed, by input name. */
  values: Record<string, string>;
  /** The one install confirmation (every source). */
  confirmed: boolean;
  /** The ADR 0023 unverified warning, confirmed once (community and custom only). */
  warningAccepted: boolean;
}

const MAX_VALUE = 8192;
// A value with a line break could add a header or an env line; refuse it.
// eslint-disable-next-line no-control-regex
const SAFE_VALUE = /^[^\u0000-\u001f\u007f]+$/;

/** Installed connectors in ~/.chalito/connectors.json; one install serves every connected agent. */
export class ConnectorStore {
  #queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly d: { dir: string; secrets: SecretStore; now?: () => number }) {}

  get file() {
    return join(this.d.dir, CONNECTORS_FILE);
  }

  #read(): StoreFile {
    if (!existsSync(this.file)) return { v: 1, installed: [] };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      throw new ConnectorStoreError("state_corrupt");
    }
    const r = StoreFile.safeParse(raw);
    // Never overwrite a file we can't read: the person (or PR C's proxy) may still need it.
    if (!r.success) throw new ConnectorStoreError("state_corrupt");
    return r.data;
  }

  #write(f: StoreFile) {
    mkdirSync(this.d.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #forget(names: string[]) {
    await Promise.allSettled(names.map((n) => this.d.secrets.delete(n)));
  }

  list(): InstalledConnector[] {
    return this.#read().installed as InstalledConnector[];
  }

  slots(id: string): string[] {
    const c = this.list().find((x) => x.id === id);
    return c ? secretAccounts(c) : [];
  }

  install(req: InstallRequest): Promise<InstalledConnector> {
    return this.#serial(async () => {
      const { entry } = req;
      if (entry.held || entry.auth === "oauth") throw new ConnectorStoreError("held_oauth");
      if (!req.confirmed) throw new ConnectorStoreError("confirm_required");
      const unverified = entry.source !== "verified";
      if (unverified && !req.warningAccepted) throw new ConnectorStoreError("warning_required");
      if (!CONNECTOR_ID.test(entry.id)) throw new ConnectorStoreError("bad_input");
      const values = checkValues(req.inputs, req.values);
      const file = this.#read();
      if (file.installed.some((c) => c.id === entry.id)) throw new ConnectorStoreError("already_installed");

      const written: string[] = [];
      const secretEnv: string[] = [];
      try {
        for (const [spec, value] of values) {
          // The proxy sends a remote's `token` as `Authorization: Bearer`; stdio values go in as env.
          const remote = spec.as === "header";
          if (remote && (spec.name.toLowerCase() !== "authorization" || (spec.prefix ?? "Bearer ") !== "Bearer "))
            throw new ConnectorStoreError("bad_input");
          if (!remote && !ENV_NAME.test(spec.name)) throw new ConnectorStoreError("bad_input");
          const name = connectorSecretName(entry.id, remote ? "token" : spec.name);
          await this.d.secrets.set(name, value);
          written.push(name);
          if (!remote) secretEnv.push(spec.name);
        }
      } catch (e) {
        // Half an install is worse than none: take back what was written.
        await this.#forget(written);
        throw e instanceof ConnectorStoreError ? e : new ConnectorStoreError("keychain");
      }
      const installed: InstalledConnector = {
        ...entry,
        installedAt: (this.d.now ?? Date.now)(),
        confirmedWarning: unverified,
        ...(secretEnv.length ? { secretEnv } : {}),
      };
      try {
        this.#write({ v: 1, installed: [...file.installed, installed] });
      } catch {
        await this.#forget(written);
        throw new ConnectorStoreError("write_failed");
      }
      return installed;
    });
  }

  uninstall(id: string): Promise<void> {
    return this.#serial(async () => {
      const file = this.#read();
      if (!file.installed.some((c) => c.id === id)) throw new ConnectorStoreError("not_installed");
      // File first: a failed write keeps the connector working; a keychain leftover is reported, not hidden.
      const gone = file.installed.find((c) => c.id === id)!;
      try {
        this.#write({ v: 1, installed: file.installed.filter((c) => c.id !== id) });
      } catch {
        throw new ConnectorStoreError("write_failed");
      }
      const results = await Promise.allSettled(
        secretAccounts(gone as InstalledConnector).map((a) => this.d.secrets.delete(connectorSecretName(id, a))),
      );
      if (results.some((r) => r.status === "rejected")) throw new ConnectorStoreError("keychain");
    });
  }
}

const checkValues = (inputs: InputSpec[], values: Record<string, string>): [InputSpec, string][] => {
  const specs = new Map(inputs.map((i) => [i.name, i]));
  for (const k of Object.keys(values)) if (!specs.has(k)) throw new ConnectorStoreError("bad_input");
  const out: [InputSpec, string][] = [];
  for (const spec of inputs) {
    const v = Object.hasOwn(values, spec.name) ? values[spec.name]!.trim() : "";
    if (!v) {
      if (spec.required) throw new ConnectorStoreError("missing_input");
      continue;
    }
    if (v.length > MAX_VALUE || !SAFE_VALUE.test(v)) throw new ConnectorStoreError("bad_input");
    out.push([spec, v]);
  }
  return out;
};

const customId = (name: string) => {
  const slug = registryId(name).slice(0, 56).replace(/-+$/, "");
  if (!slug || slug === "server") throw new ConnectorStoreError("bad_input");
  return `custom-${slug}`;
};
const customName = (name: string) => {
  const n = name.trim();
  // eslint-disable-next-line no-control-regex
  if (!n || n.length > 80 || /[\u0000-\u001f\u007f]/.test(n)) throw new ConnectorStoreError("bad_input");
  return n;
};

/** "Agregar la tuya" by URL: a remote streamable HTTP server; an optional bearer token. */
export const customRemote = (p: { name: string; url: string; token: boolean }) => {
  const url = safeRemoteUrl(p.url.trim(), { local: true });
  if (!url) throw new ConnectorStoreError("bad_url");
  const inputs: InputSpec[] = p.token
    ? [{ name: "Authorization", as: "header", secret: true, required: true, prefix: "Bearer " }]
    : [];
  const entry: ConnectorEntry = {
    id: customId(p.name),
    name: customName(p.name),
    description: url,
    source: "custom",
    transport: "remote",
    server: { url },
    auth: p.token ? "token" : "none",
  };
  return { entry, inputs };
};

/** Finds the executable a command runs (absolute, or the first match on PATH). */
export const resolveCommand = (command: string, env: NodeJS.ProcessEnv = process.env): string | null => {
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (isAbsolute(command)) return isFile(command) ? command : null;
  if (/[\\/]/.test(command)) return null; // relative paths depend on the working folder
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean))
    for (const ext of exts) if (isFile(join(dir, command + ext))) return join(dir, command + ext);
  return null;
};

export const sha256File = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });

/** "Agregar la tuya" by command (stdio). Pins the resolved executable's hash (ADR 0023 §1a). */
export const customStdio = async (
  p: { name: string; command: string; args: string[]; env: string[] },
  pathEnv: NodeJS.ProcessEnv = process.env,
) => {
  const name = customName(p.name);
  const cmd = p.command.trim();
  if (!cmd || cmd.length > 4096 || !SAFE_VALUE.test(cmd)) throw new ConnectorStoreError("bad_input");
  if (p.args.length > 64 || p.args.some((a) => a.length > 4096 || (a !== "" && !SAFE_VALUE.test(a))))
    throw new ConnectorStoreError("bad_input");
  if (p.env.length > 16 || p.env.some((e) => !ENV_NAME.test(e))) throw new ConnectorStoreError("bad_input");
  const exe = resolveCommand(cmd, pathEnv);
  if (!exe) throw new ConnectorStoreError("command_not_found");
  const inputs: InputSpec[] = p.env.map((n) => ({ name: n, as: "env", secret: true, required: true }));
  const entry: ConnectorEntry = {
    id: customId(name),
    name,
    description: [cmd, ...p.args].join(" ").slice(0, 300),
    source: "custom",
    transport: "stdio",
    server: {
      package: cmd,
      version: "local",
      integrity: `sha256-${await sha256File(exe)}`,
      command: exe,
      args: p.args,
    },
    auth: inputs.length ? "token" : "none",
  };
  return { entry, inputs };
};
