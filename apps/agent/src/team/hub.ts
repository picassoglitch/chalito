import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";

export const TeamProvider = z.enum(["claude", "codex", "grok", "cursor"]);
const Join = z.object({ provider: TeamProvider, cwd: z.string().max(4096).refine(isAbsolute) }).strict();
const Send = z
  .object({
    to: z.string().uuid().optional(),
    kind: z.enum(["status", "request", "result"]).default("status"),
    text: z.string().trim().min(1).max(8000),
  })
  .strict();
interface Message {
  workspace: string;
  seq: number;
  from: string;
  provider: z.infer<typeof TeamProvider>;
  to?: string;
  kind: "status" | "request" | "result";
  text: string;
  at: number;
}
interface Peer {
  id: string;
  cwd: string;
  provider: z.infer<typeof TeamProvider>;
  workspace: string;
  cursor: number;
  recent: number[];
}

/** Same-user, local messaging only. Provider names are labels, never proof of identity or authority. */
export class TeamHub {
  #peers = new Map<AbortSignal, Peer>();
  #messages: Message[] = [];
  #seq = 0;
  constructor(
    private readonly workspaceFor: (cwd: string) => string | null,
    private readonly now = Date.now,
  ) {}

  call(signal: AbortSignal, action: string, raw: unknown): Record<string, unknown> {
    if (signal.aborted) return { ok: false, error: "closed" };
    for (const [connection, member] of this.#peers)
      if (this.workspaceFor(member.cwd) !== member.workspace) this.#peers.delete(connection);
    this.#messages = this.#messages.filter(
      (m) => m.at > this.now() - 60 * 60_000 && [...this.#peers.values()].some((p) => p.workspace === m.workspace),
    );
    let peer = this.#peers.get(signal);
    if (action === "team_join") {
      const p = Join.safeParse(raw);
      if (!p.success) return { ok: false, error: "bad_params" };
      const workspace = this.workspaceFor(p.data.cwd);
      if (!workspace) return { ok: false, error: "unknown_workspace" };
      if (peer && (peer.workspace !== workspace || peer.provider !== p.data.provider))
        return { ok: false, error: "already_joined" };
      if (!peer) {
        if (this.#peers.size >= 64) return { ok: false, error: "team_full" };
        peer = {
          id: randomUUID(),
          cwd: p.data.cwd,
          provider: p.data.provider,
          workspace,
          cursor: this.#seq,
          recent: [],
        };
        this.#peers.set(signal, peer);
        signal.addEventListener(
          "abort",
          () => {
            this.#peers.delete(signal);
            // Forget messages after the last participant leaves a workspace.
            this.#messages = this.#messages.filter((m) =>
              [...this.#peers.values()].some((p) => p.workspace === m.workspace),
            );
          },
          { once: true },
        );
      }
    }
    if (!peer) return { ok: false, error: "join_first" };
    if (action === "team_read" && !z.object({}).strict().safeParse(raw).success)
      return { ok: false, error: "bad_params" };
    if (action === "team_send") {
      const p = Send.safeParse(raw);
      if (!p.success) return { ok: false, error: "bad_params" };
      if (
        p.data.to &&
        ![...this.#peers.values()].some(
          (other) => other.id === p.data.to && other.id !== peer.id && other.workspace === peer.workspace,
        )
      )
        return { ok: false, error: "recipient_unavailable" };
      peer.recent = peer.recent.filter((t) => t > this.now() - 60_000);
      if (peer.recent.length >= 30) return { ok: false, error: "rate_limited" };
      peer.recent.push(this.now());
      this.#messages.push({
        seq: ++this.#seq,
        workspace: peer.workspace,
        from: peer.id,
        provider: peer.provider,
        ...p.data,
        at: this.now(),
      });
      this.#messages = this.#messages.slice(-64);
    } else if (action !== "team_join" && action !== "team_read") return { ok: false, error: "unknown_tool" };
    const historyTruncated = this.#messages.length > 0 && this.#messages[0]!.seq > peer.cursor + 1;
    const messages = this.#messages.filter(
      (m) =>
        m.seq > peer.cursor &&
        m.from !== peer.id &&
        (!m.to || m.to === peer.id) &&
        m.workspace === peer.workspace &&
        m.at > this.now() - 60 * 60_000,
    );
    peer.cursor = this.#seq;
    return {
      ok: true,
      result: {
        self: peer.id,
        workspace: peer.workspace,
        historyTruncated,
        peers: [...this.#peers.values()]
          .filter((p) => p.workspace === peer.workspace && p.id !== peer.id)
          .map((p) => ({ id: p.id, provider: p.provider })),
        messages,
      },
    };
  }
}
