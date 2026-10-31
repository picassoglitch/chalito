import { z } from "zod";
import { IpcError, type IpcHandlers } from "../ipc-server.js";
import type { OpenResult } from "./open.js";
import type { OwnSessionView } from "./own-sessions.js";
import type { OwnSessionWatcher } from "./watcher.js";

export interface OwnSessionsDeps {
  watcher: OwnSessionWatcher;
  open: (s: OwnSessionView) => Promise<OpenResult>;
}

const SetEnabled = z.object({ enabled: z.boolean() }).strict();
const ForKey = z.object({ key: z.string().min(1).max(200) }).strict();

const parse = <T>(schema: z.ZodType<T>, params: unknown): T => {
  const r = schema.safeParse(params);
  if (!r.success) throw new IpcError("bad_params");
  return r.data;
};

/** The panel's calls for "Ver sesiones que abrí yo"; absent watcher = each answers `unavailable`. */
export const ownSessionHandlers = (d: OwnSessionsDeps | null | undefined): IpcHandlers => {
  const of = (): OwnSessionsDeps => {
    if (!d) throw new IpcError("unavailable");
    return d;
  };
  return {
    ownSessions: async () => {
      return of().watcher.snapshot();
    },
    ownSessionsSet: async (params) => {
      const { enabled } = parse(SetEnabled, params);
      of().watcher.setEnabled(enabled);
      return { enabled };
    },
    ownSessionOpen: async (params) => {
      const { key } = parse(ForKey, params);
      const { watcher, open } = of();
      const s = watcher.poll().find((v) => v.key === key);
      if (!s) throw new IpcError("not_found");
      return { ...(await open(s)), id: s.id, cwd: s.cwd };
    },
  };
};
