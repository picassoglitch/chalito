import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { basename, join } from "node:path";

/** Where the team server of the app process `pid` waits for its in-app helper (a Claude Code mod). */
export const inboxPath = (dir: string, provider: string, pid: number): string =>
  join(dir, "team-inbox", `${provider}-${pid}.sock`);

/** One batch for the helper. `epoch` changes when Chalito restarts (seqs start over), so the helper keys seqs by it. */
export interface InboxLine {
  epoch: string;
  items: { seq: number; text: string }[];
}

export interface Inbox {
  /** Hands one batch to the newest connected helper; false when none is connected. */
  send(line: InboxLine): boolean;
  readonly connected: boolean;
  close(): void;
}

const HELLO = "chalito-team-watch\n";

/** Something already answers on `path`: another live team server of the same session. */
const answers = (path: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });

/** A same-user socket (0700 folder) the app's helper connects to; connected or not is the liveness signal. */
export const openInbox = async (path: string, changed: (connected: boolean) => void): Promise<Inbox | null> => {
  const folder = join(path, "..");
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    // A real folder this user owns, never a link: other users can't plant or watch a socket here.
    const f = lstatSync(folder);
    if (!f.isDirectory() || (process.getuid && f.uid !== process.getuid())) return null;
    chmodSync(folder, 0o700);
    if (existsSync(path)) {
      // A sibling server of this session keeps its inbox; only a dead one's file is cleared.
      if (await answers(path)) return null;
      unlinkSync(path);
    }
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const helpers: Socket[] = [];
    const server: Server = createServer((socket) => {
      socket.on("error", () => undefined);
      // A helper says hello first: a probe (another server checking the path) never counts as one.
      let joined = false;
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        if (joined || !chunk.startsWith(HELLO)) return;
        joined = true;
        helpers.push(socket);
        if (helpers.length === 1) changed(true);
      });
      socket.once("close", () => {
        if (!joined) return;
        helpers.splice(helpers.indexOf(socket), 1);
        if (!helpers.length) changed(false);
      });
    });
    server.once("error", () => resolve(null));
    server.listen(path, () => {
      // Inode numbers are reused on a real disk: times make the identity of our own file.
      let mine: { ino: number; dev: number; birth: number; changed: number } | null = null;
      try {
        chmodSync(path, 0o600);
        const s = lstatSync(path);
        mine = { ino: s.ino, dev: s.dev, birth: s.birthtimeMs, changed: s.ctimeMs };
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
            // Only our own file: a newer server of the session may have taken the path since.
            const s = lstatSync(path);
            const same =
              mine &&
              s.ino === mine.ino &&
              s.dev === mine.dev &&
              s.birthtimeMs === mine.birth &&
              s.ctimeMs === mine.changed;
            if (same) unlinkSync(path);
          } catch {
            // Already gone.
          }
        },
      });
    });
  });
};

/** `chalito team watch`: the helper's end, each batch as one JSON line on stdout until the server goes. */
export const runTeamWatch = (path: string, out: (text: string) => void, err: (text: string) => void): Promise<number> =>
  new Promise((resolve) => {
    const socket = connect(path);
    let connected = false;
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      connected = true;
      socket.write(HELLO);
    });
    socket.on("data", (chunk: string) => out(chunk));
    socket.on("error", (e: NodeJS.ErrnoException) => {
      if (!connected) err(`chalito team watch: no team server for this session yet (${e.code ?? "error"}).\n`);
    });
    socket.on("close", () => resolve(connected ? 0 : 3));
  });

/** The parent and command line of `pid`, or null where they can't be read. */
const procOf = (pid: number, platform: NodeJS.Platform): { ppid: number | null; argv: string[] } | null => {
  try {
    if (platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) || null;
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      return { ppid, argv };
    }
    const [ppid, ...argv] = execFileSync("ps", ["-o", "ppid=,args=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
    })
      .trim()
      .split(/\s+/);
    return { ppid: Number(ppid) || null, argv };
  } catch {
    return null;
  }
};

/** Claude Code itself: its binary is `claude`, or node running the package's `claude` script. */
const isClaude = (argv: string[]) => argv.slice(0, 2).some((a) => basename(a) === "claude" || /claude-code/.test(a));

/** The inbox of the Claude Code session this process runs under: the nearest `claude` ancestor's, never one further up. */
export const findSessionInbox = (
  dir: string,
  start = process.ppid,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
  proc: (pid: number) => { ppid: number | null; argv: string[] } | null = (pid) => procOf(pid, platform),
): string | null => {
  let pid: number | null = start;
  for (let hops = 0; pid && pid > 1 && hops < 16; hops++) {
    const info = proc(pid);
    if (!info) return null;
    if (isClaude(info.argv)) {
      const path = inboxPath(dir, "claude", pid);
      // Its team server may still be starting: not found yet, and no outer session's inbox instead.
      return exists(path) ? path : null;
    }
    pid = info.ppid;
  }
  return null;
};
