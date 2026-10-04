import { CallLine, FORBIDDEN_IN_CALL_LINE, sanitizeCallText } from "@chalito/protocol";
import { redact } from "./redact.js";
import type { AgentStore } from "./store.js";

const TTL_MS = 30 * 60 * 1000;

/**
 * One plaintext sentence per waiting item for call briefings (ADR 0011). Published only
 * when the user enabled call briefing AND local policy allows it. A line that would carry
 * a path, URL, diff or command is replaced with a generic one.
 */
export const buildCallLine = (rawLabel: string, question: string | null, locale: "es" | "en"): string => {
  const sessionLabel = sanitizeCallText(rawLabel).slice(0, 60) || (locale === "es" ? "tu sesión" : "your session");
  const generic =
    locale === "es"
      ? `El agente de ${sessionLabel} necesita tu respuesta.`
      : `The ${sessionLabel} agent needs your answer.`;
  if (!question) return generic;
  const redacted = redact(question);
  // Paths, URLs and commands are judged on the raw text: sanitizing would hide them.
  if (FORBIDDEN_IN_CALL_LINE.test(redacted.normalize("NFKC"))) return generic;
  const q = sanitizeCallText(redacted).replace(/[.?!]+$/, "");
  const candidate =
    locale === "es"
      ? `El agente de ${sessionLabel} pregunta: ¿${q.replace(/^¿/, "")}?`
      : `The ${sessionLabel} agent asks: ${q}?`;
  const check = CallLine.shape.line.safeParse(candidate);
  return check.success ? candidate : generic;
};

export class CallLinePublisher {
  constructor(
    private readonly deps: {
      store: AgentStore;
      deviceId: string;
      policyAllows: () => boolean;
      locale: () => "es" | "en";
      now: () => number;
    },
  ) {}

  async publish(
    id: string,
    input: { notificationId: string; sid: string; sessionLabel: string; question: string | null },
  ): Promise<boolean> {
    if (!this.deps.policyAllows()) return false;
    if (!(await this.deps.store.callBriefingEnabled())) return false;
    const line = CallLine.parse({
      v: 1,
      notificationId: input.notificationId,
      deviceId: this.deps.deviceId,
      sid: input.sid,
      line: buildCallLine(input.sessionLabel, input.question, this.deps.locale()),
      expireAt: this.deps.now() + TTL_MS,
    });
    await this.deps.store.writeCallLine(id, line);
    return true;
  }

  async remove(id: string): Promise<void> {
    await this.deps.store.deleteCallLine(id);
  }
}
