import { randomBytes } from "node:crypto";
import { canonicalize } from "@chalito/crypto";
import { ComputerError, type McpServerSpec, type ToolOutput } from "../computer/control.js";
import { LINK_DATA_RULE, quoteLinkData } from "./frame.js";
import type { LinkManager } from "./manager.js";
import { LINKS_SERVER, LINKS_TOOL_PREFIX, LinkToolArgs, isLinkToolName, type LinkToolName } from "./tools.js";

/**
 * The agent's side of the session link tools (ADR 0022 §3, M16 F): which sessions get the local
 * MCP server, and what a call may do. The MCP server (`chalito link mcp`, a child of Claude Code,
 * Codex, an ACP agent or the chat-api bridge) holds nothing but its session's token; every call
 * comes here over the links broker socket.
 *
 * - `attach`: only for a session that is the sender on at least one active link (and only while
 *   the broker is up). A session started before its link was made gets the tools on its next start
 *   or resume.
 * - A call needs a ticket from the tool gate (`admit`, after agent-core's gate allowed exactly that
 *   call), so a process that found the token still can't skip the person's approval.
 * - The link must be one of the session's sender links, in the tool's mode; then the link manager
 *   runs every check (hop and chain, the receiver's authorization, rate, budget, confirm).
 */

export class LinkToolError extends ComputerError {}

export interface LinkToolDeps {
  links: LinkManager;
  /** How to start the MCP server, or null while the links broker isn't up. */
  mcpLaunch: () => { command: string; args: string[]; socket: string } | null;
  audit: (type: string, meta: Record<string, unknown>) => void;
  now: () => number;
  newToken?: () => string;
}

const TICKET_TTL_MS = 60_000;

export class LinkTools {
  readonly #bySid = new Map<string, string>();
  readonly #byToken = new Map<string, string>();
  /** Gate-allowed calls not yet made, per session: canonical (tool, args) → expiry. */
  readonly #tickets = new Map<string, Map<string, number>>();

  constructor(private readonly d: LinkToolDeps) {}

  attach(sid: string): McpServerSpec | null {
    if (this.d.links.senderLinks(sid).length === 0) return null;
    const launch = this.d.mcpLaunch();
    if (!launch) return null;
    this.end(sid);
    const token = this.d.newToken?.() ?? randomBytes(32).toString("hex");
    this.#bySid.set(sid, token);
    this.#byToken.set(token, sid);
    this.d.audit("link.tools_attached", { sid, links: this.d.links.senderLinks(sid).length });
    return {
      name: LINKS_SERVER,
      command: launch.command,
      args: launch.args,
      env: { CHALITO_LINKS_SOCKET: launch.socket, CHALITO_LINKS_TOKEN: token },
    };
  }

  attached(sid: string): boolean {
    return this.#bySid.has(sid);
  }

  end(sid: string): void {
    const token = this.#bySid.get(sid);
    if (token) this.#byToken.delete(token);
    this.#bySid.delete(sid);
    this.#tickets.delete(sid);
  }

  /** The gate allowed this exact call (`mcp__chalito_links__<tool>` with `input`). */
  admit(sid: string, toolName: string, input: unknown): void {
    if (!this.#bySid.has(sid) || !toolName.startsWith(LINKS_TOOL_PREFIX)) return;
    const t = this.#tickets.get(sid) ?? new Map<string, number>();
    const now = this.d.now();
    for (const [k, exp] of t) if (exp <= now) t.delete(k);
    t.set(this.#key(toolName.slice(LINKS_TOOL_PREFIX.length), input), now + TICKET_TTL_MS);
    this.#tickets.set(sid, t);
  }

  #key(tool: string, input: unknown): string {
    return canonicalize({ tool, input: input ?? {} });
  }

  #take(sid: string, tool: string, input: unknown): boolean {
    const t = this.#tickets.get(sid);
    const k = this.#key(tool, input);
    const exp = t?.get(k);
    if (exp === undefined) return false;
    t!.delete(k);
    return exp > this.d.now();
  }

  /** One `tools/call` from the MCP server (the links broker). */
  async call(token: string, tool: string, rawArgs: unknown): Promise<ToolOutput> {
    const sid = this.#byToken.get(token);
    if (!sid) throw new LinkToolError("link_tools_ended", "These link tools are no longer available in this session.");
    if (!isLinkToolName(tool))
      throw new LinkToolError("unknown_tool", `There is no link tool named ${tool.slice(0, 64)}.`);
    if (!this.#take(sid, tool, rawArgs)) {
      this.d.audit("link.tool_refused", { sid, tool, reason: "not_gated" });
      throw new LinkToolError("not_gated", "This call wasn't approved through Chalito's tool gate.");
    }
    const parsed = LinkToolArgs[tool].safeParse(rawArgs ?? {});
    if (!parsed.success) throw new LinkToolError("bad_args", "Those arguments aren't valid for this tool.");
    return this.#run(sid, tool, parsed.data as Record<string, string>);
  }

  async #run(sid: string, tool: LinkToolName, args: Record<string, string>): Promise<ToolOutput> {
    const mine = this.d.links.senderLinks(sid);
    if (tool === "link_list")
      return {
        text: `${LINK_DATA_RULE}\n${quoteLinkData("chalito-links", {
          links: mine.map((l) => ({
            linkId: l.id,
            mode: l.mode,
            goal: l.goal,
            receiver: { deviceId: l.receiver.deviceId, ...(l.receiver.appId ? { appId: l.receiver.appId } : {}) },
            askEachTime: l.confirm,
            expiresAt: new Date(l.expiresAt).toISOString(),
          })),
        })}`,
      };
    const mode = tool === "link_handoff" ? "handoff" : "share";
    const link = mine.find((l) => l.id === args.linkId && l.mode === mode);
    if (!link) {
      this.d.audit("link.tool_refused", { sid, tool, linkId: args.linkId, reason: "not_a_sender_link" });
      throw new LinkToolError("unknown_link", `No ${mode} link with that id from this session; see link_list.`);
    }
    if (tool === "link_handoff") {
      const r = await this.d.links.handoff({ fromSid: sid, linkId: link.id, text: args.request! });
      this.d.audit("link.tool_call", { sid, tool, linkId: link.id, ok: r.ok });
      if (!r.ok) throw new LinkToolError(r.reason, `The hand-off was refused (${r.reason}).`);
      return {
        text: JSON.stringify({
          taskId: r.taskId,
          linkId: link.id,
          state: "sent",
          note: "The result arrives as quoted data with the person's next prompt.",
        }),
      };
    }
    const r = await this.d.links.share({ fromSid: sid, linkId: link.id, parts: [{ text: args.text! }] });
    this.d.audit("link.tool_call", { sid, tool, linkId: link.id, ok: r.ok });
    if (!r.ok) throw new LinkToolError(r.reason, `The share was refused (${r.reason}).`);
    return { text: JSON.stringify({ linkId: link.id, state: "shared" }) };
  }
}
