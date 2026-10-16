import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { AdapterKind, AppId, Origin, RemotePermissionMode, SessionId, SessionState } from "@chalito/protocol";

/**
 * M16 A (ADR 0022 §1): what the agent remembers about its coding-agent sessions so it can resume
 * them after an idle-close or a restart, in `~/.chalito/sessions.json` (0600).
 *
 * Labels and ids only: no prompt, no card, no output. Nothing here is trusted beyond that: a
 * resume re-checks the workspace (by label, in the local policy), the adapter or app (enabled
 * here), and the permission mode (against the remote ceiling) exactly like `session.start`.
 */
export const SessionRecord = z.object({
  sid: SessionId,
  adapter: AdapterKind,
  appId: AppId.optional(),
  workspaceLabel: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  permissionMode: RemotePermissionMode,
  startedBy: Origin,
  /** Claude session_id, Codex thread id or ACP sessionId; without it there is nothing to resume. */
  providerSessionId: z.string().min(1).max(200).optional(),
  /** The next event seq (a restart adds a margin: a crash may have used some after the last save). */
  seq: z.number().int().nonnegative(),
  state: SessionState,
  lastActiveAt: z.number().int().nonnegative(),
  /** A process was running for it when this was saved (false once idle-closed). */
  live: z.boolean(),
});
export type SessionRecord = z.infer<typeof SessionRecord>;

export interface SessionRegistry {
  load(): SessionRecord[];
  save(records: SessionRecord[]): void;
}

/** Older records can't be resumed usefully: their events are gone (7-day TTL). */
export const RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const RECORD_MAX = 200;

/** Newest first, at most RECORD_MAX, none older than RECORD_MAX_AGE_MS. */
export const pruneRecords = (records: SessionRecord[], now: number): SessionRecord[] =>
  records
    .filter((r) => now - r.lastActiveAt <= RECORD_MAX_AGE_MS)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, RECORD_MAX);

/** The file-backed registry. An unreadable file is ignored (nothing to resume), never fatal. */
export class FileSessionRegistry implements SessionRegistry {
  constructor(
    readonly dir: string,
    private readonly log?: { warn(msg: string, meta?: Record<string, unknown>): void },
  ) {}

  get file(): string {
    return join(this.dir, "sessions.json");
  }

  load(): SessionRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as { sessions?: unknown[] };
      return (raw.sessions ?? []).flatMap((r) => {
        const p = SessionRecord.safeParse(r);
        return p.success ? [p.data] : [];
      });
    } catch (err) {
      this.log?.warn("sessions.registry_unreadable", { error: err instanceof Error ? err.message : "error" });
      return [];
    }
  }

  save(records: SessionRecord[]): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, sessions: records }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}

/** In memory, for tests and setups without a state dir. */
export class MemorySessionRegistry implements SessionRegistry {
  records: SessionRecord[] = [];
  saves = 0;
  load(): SessionRecord[] {
    return this.records.map((r) => ({ ...r }));
  }
  save(records: SessionRecord[]): void {
    this.saves++;
    this.records = records.map((r) => ({ ...r }));
  }
}
