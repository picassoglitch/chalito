import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { KNOWN_PROVIDERS, TeamProvider } from "./hub.js";
import { expandHome } from "../workspace-path.js";

const TrustFile = z
  .object({
    v: z.literal(1),
    entries: z.array(z.object({ path: z.string(), provider: TeamProvider }).strict()).max(256),
  })
  .strict();

/** Trust belongs to a configured folder and app, not a reusable label or provider login. */
export class TeamConnections {
  #trusted = new Set<string>();
  /** Untrusted ids that tried to join, per canonical folder: shown so they can be trusted, never trusted by asking. */
  #requested = new Map<string, Set<TeamProvider>>();
  readonly #file: string;
  constructor(
    private readonly d: {
      dir: string;
      home: string;
      workspaces: () => { label: string; path: string }[];
      workspaceFor: (cwd: string) => string | null;
      launch: { command: string; args: string[] };
      connected: (provider: TeamProvider, workspace: string) => boolean;
    },
  ) {
    this.#file = join(d.dir, "team-trust.json");
    try {
      if (!existsSync(this.#file)) return;
      this.#assertFile();
      const data = TrustFile.parse(JSON.parse(readFileSync(this.#file, "utf8")));
      for (const entry of data.entries) this.#trusted.add(JSON.stringify([entry.path, entry.provider]));
    } catch {
      this.#trusted.clear();
    }
  }

  #assertFile() {
    if (lstatSync(this.d.dir).isSymbolicLink()) throw new Error("unsafe_path");
    if (!existsSync(this.#file)) return;
    const stat = lstatSync(this.#file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024) throw new Error("unsafe_path");
  }

  #path(label: string): string | null {
    const workspace = this.d.workspaces().find((w) => w.label === label);
    if (!workspace) return null;
    try {
      return realpathSync(expandHome(workspace.path, this.d.home));
    } catch {
      return null;
    }
  }

  trusted(provider: TeamProvider, cwd: string): boolean {
    const label = this.d.workspaceFor(cwd);
    const path = label && this.#path(label);
    return !!path && this.#trusted.has(JSON.stringify([path, provider]));
  }

  requested(provider: TeamProvider, cwd: string): void {
    if (!TeamProvider.safeParse(provider).success) return;
    const label = this.d.workspaceFor(cwd);
    const path = label && this.#path(label);
    if (!path) return;
    const ids = this.#requested.get(path) ?? new Set();
    if (ids.size >= 16 && !ids.has(provider)) return;
    this.#requested.set(path, ids.add(provider));
  }

  #providers(path: string): TeamProvider[] {
    const ids = new Set<TeamProvider>(KNOWN_PROVIDERS);
    for (const key of this.#trusted) {
      const [p, provider] = JSON.parse(key) as [string, TeamProvider];
      if (p === path) ids.add(provider);
    }
    for (const provider of this.#requested.get(path) ?? []) ids.add(provider);
    return [...ids];
  }

  set(provider: TeamProvider, workspace: string, trusted: boolean, expectedPath?: string): void {
    TeamProvider.parse(provider);
    const path = this.#path(workspace);
    if (!path) throw new Error("unknown_workspace");
    if (expectedPath !== undefined && path !== expectedPath) throw new Error("workspace_changed");
    this.#assertFile();
    const next = new Set(this.#trusted);
    const key = JSON.stringify([path, provider]);
    if (trusted) next.add(key);
    else next.delete(key);
    const entries = [...next].map((key) => {
      const [path, provider] = JSON.parse(key) as [string, TeamProvider];
      return { path, provider };
    });
    const data = TrustFile.parse({ v: 1, entries });
    const text = JSON.stringify(data, null, 2) + "\n";
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new Error("trust_limit");
    const temp = `${this.#file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
      renameSync(temp, this.#file);
      this.#trusted = next;
    } finally {
      rmSync(temp, { force: true });
    }
  }

  view() {
    return {
      workspaces: this.d.workspaces().map((w) => {
        // MCP clients start the command without a shell, so `~` must already be expanded.
        const path = this.#path(w.label) ?? expandHome(w.path, this.d.home);
        return {
          ...w,
          path,
          connections: this.#providers(path).map((provider) => ({
            provider,
            known: (KNOWN_PROVIDERS as readonly string[]).includes(provider),
            trusted: this.trusted(provider, path),
            connected: this.d.connected(provider, w.label),
            command: this.d.launch.command,
            args: [...this.d.launch.args, "team", "mcp", provider, path],
          })),
        };
      }),
    };
  }
}
