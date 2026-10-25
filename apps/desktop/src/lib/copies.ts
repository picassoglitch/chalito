import { invoke, isTauri } from "@tauri-apps/api/core";

/** Other copies of Chalito on this computer (src-tauri/src/copies.rs). Nothing changes without a click. */

/** Where autostart or the chalito:// handler sends Chalito. */
export type Link =
  { state: "none" } | { state: "ours" } | { state: "gone"; path: string } | { state: "other"; path: string };

export interface OldCopy {
  path: string;
  version: string | null;
  bytes: number;
}

export interface OtherInstance {
  pid: number;
  /** "agent": a chalito-agent left running without the app that started it. */
  kind: "desktop" | "agent";
  path: string;
}

export interface CopiesReport {
  running: string;
  autostart: Link;
  handler: Link;
  copies: OldCopy[];
  instances: OtherInstance[];
}

/** Each call resolves to a fresh report; a refusal rejects with its code (`running`, `not_a_copy`…). */
export interface CopiesApi {
  report(): Promise<CopiesReport>;
  useThis(): Promise<CopiesReport>;
  trash(path: string): Promise<CopiesReport>;
  close(pid: number): Promise<CopiesReport>;
}

type Invoke = <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;

export const invokeCopies = (call: Invoke): CopiesApi => ({
  report: () => call<CopiesReport>("copies_report", {}),
  useThis: () => call<CopiesReport>("copies_use_this", {}),
  trash: (path) => call<CopiesReport>("copies_trash", { path }),
  close: (pid) => call<CopiesReport>("copies_close", { pid }),
});

export const needsFix = (l: Link): l is Extract<Link, { path: string }> => l.state === "other" || l.state === "gone";

export const anythingFound = (r: CopiesReport): boolean =>
  needsFix(r.autostart) || needsFix(r.handler) || r.copies.length > 0 || r.instances.length > 0;

/** null in `vite dev` (no native side): the notice stays hidden. */
export const copiesApi = (): CopiesApi | null => (isTauri() ? invokeCopies(invoke) : null);
