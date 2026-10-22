import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { DeviceSetup, RemotePermissionMode } from "@chalito/protocol";
import type { AgentCore, CommandResult } from "../agent-core.js";
import type { Policy } from "../policy/schema.js";
import type { LocalTap } from "./events.js";

/** What the panel's IPC and `code.sock` may do with sessions on this computer (ADR 0031 §1). */
export interface CodeService {
  apps(): { apps: string[]; workspaces: string[] };
  /** The workspace whose folder holds `cwd` (the deepest one), or null. */
  workspaceFor(cwd: string): string | null;
  start(i: {
    appId: string;
    workspaceLabel: string;
    prompt: string;
    permissionMode: RemotePermissionMode;
  }): Promise<CommandResult>;
  prompt(sid: string, text: string): Promise<CommandResult>;
  stop(sid: string): Promise<CommandResult>;
  tap(fn: LocalTap): () => void;
}

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const within = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

export const codeService = (
  core: Pick<AgentCore, "localCommand" | "tap">,
  policy: () => Pick<Policy, "workspaces">,
  setup: () => DeviceSetup,
  /** `local` for the panel (its secret proves the desktop app), `local:cli` for code.sock (ADR 0031 §6a). */
  origin: "local" | "local:cli",
): CodeService => ({
  apps: () => ({ apps: [...setup().adapters], workspaces: policy().workspaces.map((w) => w.label) }),
  workspaceFor: (cwd) => {
    const here = real(cwd);
    const hits = policy()
      .workspaces.map((w) => ({ label: w.label, path: real(w.path) }))
      .filter((w) => within(here, w.path))
      .sort((a, b) => b.path.length - a.path.length);
    return hits[0]?.label ?? null;
  },
  start: (i) => core.localCommand(origin, { type: "session.start", ...i }),
  prompt: (sid, text) => core.localCommand(origin, { type: "session.prompt", sid, text }),
  stop: (sid) => core.localCommand(origin, { type: "session.interrupt", sid }),
  tap: (fn) => core.tap(fn),
});
