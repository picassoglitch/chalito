import type { ProcessRunner } from "../runner.js";
import type { PrEvent } from "./events.js";

/** A live Chalito session as the agent knows it. */
export interface SessionPlace {
  sid: string;
  label: string;
  cwd: string;
  lastActiveAt: number;
}

/** Where a session's folder sits in git: its branch and every remote's `owner/repo`. */
export interface SessionRepo extends SessionPlace {
  branch: string | null;
  repos: string[];
}

export interface LinkedSession {
  sid: string;
  label: string;
}

/** A github.com remote (https, ssh or scp-style) → `owner/repo`; other hosts are someone else's repo. */
export const repoOfRemote = (url: string): string | null => {
  const m = /github\.com[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
};

/** Reads one session's branch and remotes; a folder that isn't a repo gives no match, never an error. */
export const readSessionRepo = async (runner: ProcessRunner, s: SessionPlace): Promise<SessionRepo> => {
  const [head, remotes] = await Promise.all([
    runner.run("git", ["-C", s.cwd, "rev-parse", "--abbrev-ref", "HEAD"]),
    runner.run("git", ["-C", s.cwd, "remote", "-v"]),
  ]);
  const name = head.code === 0 ? head.stdout.trim() : "";
  const repos =
    remotes.code === 0
      ? remotes.stdout.split("\n").flatMap((l) => {
          const r = repoOfRemote(l.split(/\s+/)[1] ?? "");
          return r ? [r.toLowerCase()] : [];
        })
      : [];
  return { ...s, branch: name && name !== "HEAD" ? name : null, repos: [...new Set(repos)] };
};

/** The newest session on the PR's branch in its repo (or its fork), if any. */
export const sessionFor = (e: PrEvent, sessions: readonly SessionRepo[]): LinkedSession | null => {
  const repos = [e.repo, e.headRepo].flatMap((r) => (r ? [r.toLowerCase()] : []));
  const hit = sessions
    .filter((s) => s.branch === e.branch && s.repos.some((r) => repos.includes(r)))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
  return hit ? { sid: hit.sid, label: hit.label } : null;
};
