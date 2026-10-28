import { execFile } from "node:child_process";

/** Process names that only run while a call is live. Zoom's CptHost is the one sure signal (Alux, focus.js). */
const CALL_PROCESSES = [/(^|[/\\])CptHost(\.exe)?$/i];

export type ListProcesses = () => Promise<string[]>;

/** Running process names (or paths). Empty when the OS won't say: then nobody looks in a call. */
export const listProcesses =
  (platform: NodeJS.Platform = process.platform, run: typeof execFile = execFile): ListProcesses =>
  () =>
    new Promise((resolve) => {
      const [cmd, args] = platform === "win32" ? ["tasklist", ["/fo", "csv", "/nh"]] : ["ps", ["-A", "-o", "comm="]];
      run(cmd, args, { timeout: 3000, maxBuffer: 8 << 20, windowsHide: true }, (err, out) => {
        if (err) return resolve([]);
        const lines = String(out).split(/\r?\n/).filter(Boolean);
        resolve(
          platform === "win32"
            ? lines.map((l) => /^"([^"]*)"/.exec(l)?.[1] ?? "").filter(Boolean)
            : lines.map((l) => l.trim()),
        );
      });
    });

/** Whether a call app looks mid-call. Meet in a browser and Teams give no such signal, so they read as no. */
export const inCall = async (list: ListProcesses): Promise<boolean> => {
  const names = await list().catch(() => []);
  return names.some((n) => CALL_PROCESSES.some((re) => re.test(n)));
};
