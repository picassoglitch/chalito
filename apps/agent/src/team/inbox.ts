import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

/** Where the team server of the app process `pid` waits for its in-app helper (a Claude Code mod). */
export const inboxPath = (dir: string, provider: string, pid: number): string =>
  join(dir, "team-inbox", `${provider}-${pid}.sock`);

export interface Inbox {
  /** Hands one batch to the newest connected helper; false when none is connected. */
  send(line: { seqs: number[]; text: string }): boolean;
  readonly connected: boolean;
  close(): void;
}

/** A same-user socket (0700 folder) the app's helper connects to; connected or not is the liveness signal. */
export const openInbox = (path: string, changed: (connected: boolean) => void): Promise<Inbox | null> =>
  new Promise((resolve) => {
    const folder = join(path, "..");
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      // A real folder this user owns, never a link: other users can't plant or watch a socket here.
      const f = lstatSync(folder);
      if (!f.isDirectory() || (process.getuid && f.uid !== process.getuid())) return resolve(null);
      chmodSync(folder, 0o700);
      // A file left by a crashed process with the same pid: nothing listens on it.
      if (existsSync(path)) unlinkSync(path);
    } catch {
      return resolve(null);
    }
    const helpers: Socket[] = [];
    const server: Server = createServer((socket) => {
      helpers.push(socket);
      socket.on("error", () => undefined);
      // The helper never talks; anything it sends is ignored.
      socket.resume();
      if (helpers.length === 1) changed(true);
      socket.once("close", () => {
        helpers.splice(helpers.indexOf(socket), 1);
        if (!helpers.length) changed(false);
      });
    });
    server.once("error", () => resolve(null));
    server.listen(path, () => {
      try {
        chmodSync(path, 0o600);
      } catch {
        // The 0700 folder already keeps other users out.
      }
      resolve({
        send: (line) => {
          const helper = helpers.at(-1);
          if (!helper || helper.destroyed) return false;
          helper.write(`${JSON.stringify(line)}\n`);
          return true;
        },
        get connected() {
          return helpers.length > 0;
        },
        close: () => {
          for (const h of helpers) h.destroy();
          server.close();
          try {
            unlinkSync(path);
          } catch {
            // Already gone.
          }
        },
      });
    });
  });

/** `chalito team watch <pid>`: the helper's end, each batch as one JSON line on stdout until the server goes. */
export const runTeamWatch = (path: string, out: (text: string) => void, err: (text: string) => void): Promise<number> =>
  new Promise((resolve) => {
    const socket = connect(path);
    let connected = false;
    socket.setEncoding("utf8");
    socket.on("connect", () => (connected = true));
    socket.on("data", (chunk: string) => out(chunk));
    socket.on("error", (e: NodeJS.ErrnoException) => {
      if (!connected) err(`chalito team watch: no team server for this session yet (${e.code ?? "error"}).\n`);
    });
    socket.on("close", () => resolve(connected ? 0 : 3));
  });

/** The parent of `pid`, or null where it can't be read. */
const parentOf = (pid: number, platform: NodeJS.Platform): number | null => {
  try {
    if (platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) || null;
    }
    return (
      Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim()) || null
    );
  } catch {
    return null;
  }
};

/** The inbox of the nearest ancestor that has one: the Claude Code session this process runs under, mods included. */
export const findSessionInbox = (
  dir: string,
  start = process.ppid,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null => {
  let pid: number | null = start;
  for (let hops = 0; pid && pid > 1 && hops < 16; hops++) {
    const path = inboxPath(dir, "claude", pid);
    if (exists(path)) return path;
    pid = parentOf(pid, platform);
  }
  return null;
};
