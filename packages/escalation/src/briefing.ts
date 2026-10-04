import { CallBriefing, CallLine, type Locale } from "@chalito/protocol";

/** The fixed DTMF menu (ADR 0011). Nothing on a call can approve anything. */
export const CALL_MENU = { "1": "connect", "2": "snooze", "3": "dismiss" } as const;

export interface BriefingScript {
  locale: Locale;
  /** One sentence each, in speaking order. */
  segments: string[];
  /** The segments joined, ready for <Say> (the notifier XML-escapes it). */
  text: string;
  menu: typeof CALL_MENU;
}

export interface BriefingOptions {
  /** DTMF 2 re-call delay for non-Mesa calls, spoken in the menu. */
  snoozeMin?: number;
  /** Items read out one by one before the menu; the rest are summarised as "and N more". */
  maxItems?: number;
}

const LINE = CallLine.shape.line;
const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const T = {
  es: {
    hello: "Hola, habla Chalito.",
    mesa: (title: string, min: number) =>
      `Tu Mesa «${title}» empieza ${min === 0 ? "ahora" : `en ${plural(min, "minuto", "minutos")}`}.`,
    agents: (n: number) =>
      n === 1
        ? "Tienes 1 agente en espera que necesita tu respuesta"
        : `Tienes ${n} agentes en espera que necesitan tu respuesta`,
    messages: (n: number, hours?: number, joined = false) =>
      `${joined ? "y" : "Tienes"} ${plural(n, "mensaje sin contestar", "mensajes sin contestar")}${
        hours ? ` en ${hours === 1 ? "la última hora" : `las últimas ${hours} horas`}` : ""
      }`,
    approvals: (n: number, also: boolean) =>
      `${also ? "También tienes" : "Tienes"} ${plural(n, "aprobación pendiente", "aprobaciones pendientes")}; ${n === 1 ? "esa solo se aprueba" : "esas solo se aprueban"} desde tu app.`,
    asks: (device: string, session: string, line: string) => `En ${device}, ${session} pregunta: ${line}`,
    waits: (device: string, session: string) => `En ${device}, ${session} espera tu respuesta.`,
    more: (n: number) => `Y ${plural(n, "pendiente más", "pendientes más")}.`,
    menuMesa: "Oprime 1 para conectarte ahora, 2 para que te llame un minuto antes, o 3 para descartar.",
    menu: (min: number, one: boolean) =>
      `Oprime 1 para ${one ? "escucharlo" : "escucharlos"} y responder, 2 para que te llame en ${plural(min, "minuto", "minutos")}, o 3 para descartar.`,
  },
  en: {
    hello: "Hi, this is Chalito.",
    mesa: (title: string, min: number) =>
      `Your Mesa "${title}" starts ${min === 0 ? "now" : `in ${plural(min, "minute", "minutes")}`}.`,
    agents: (n: number) =>
      n === 1 ? "You have 1 agent waiting for your answer" : `You have ${n} agents waiting for your answer`,
    messages: (n: number, hours?: number, joined = false) =>
      `${joined ? "and" : "You have"} ${plural(n, "unanswered message", "unanswered messages")}${
        hours ? ` from the last ${hours === 1 ? "hour" : `${hours} hours`}` : ""
      }`,
    approvals: (n: number, also: boolean) =>
      `${also ? "You also have" : "You have"} ${plural(n, "pending approval", "pending approvals")}; ${n === 1 ? "it can" : "those can"} only be approved in your app.`,
    asks: (device: string, session: string, line: string) => `On ${device}, ${session} asks: ${line}`,
    waits: (device: string, session: string) => `On ${device}, ${session} is waiting for you.`,
    more: (n: number) => `And ${plural(n, "more item", "more items")}.`,
    menuMesa: "Press 1 to join now, 2 to get a call one minute before, or 3 to dismiss.",
    menu: (min: number, one: boolean) =>
      `Press 1 to hear ${one ? "it" : "them"} and answer, 2 to get a call in ${plural(min, "minute", "minutes")}, or 3 to dismiss.`,
  },
} as const;

/**
 * The spoken call briefing: deterministic, from metadata (counts, labels, Mesa title and
 * time, unanswered window) plus, only when call briefing is enabled, each item's call line
 * (re-checked against the CallLine rules; a failing line falls back to metadata).
 */
export const buildBriefing = (input: CallBriefing, opts: BriefingOptions = {}): BriefingScript => {
  const b = CallBriefing.parse(input);
  const t = T[b.locale];
  const maxItems = opts.maxItems ?? 3;
  const segments: string[] = [t.hello];

  if (b.mesa && (b.kind === "mesa_starting" || b.kind === "mixed"))
    segments.push(t.mesa(clean(b.mesa.title), b.mesa.startsInMin));

  const q = b.counts.questions;
  const m = b.kind === "mesa_starting" ? 0 : b.counts.messages;
  if (q > 0 && m > 0) segments.push(`${t.agents(q)} ${t.messages(m, b.unansweredWindowHours, true)}.`);
  else if (q > 0) segments.push(`${t.agents(q)}.`);
  else if (m > 0) segments.push(`${t.messages(m, b.unansweredWindowHours)}.`);

  if (b.counts.approvals > 0) segments.push(t.approvals(b.counts.approvals, q > 0 || m > 0));

  for (const item of b.items.slice(0, maxItems)) {
    const device = clean(item.deviceLabel);
    const session = clean(item.sessionLabel);
    const line =
      b.callBriefingEnabled && item.line !== undefined && LINE.safeParse(item.line).success ? clean(item.line) : null;
    segments.push(line ? t.asks(device, session, line) : t.waits(device, session));
  }
  if (b.items.length > maxItems) segments.push(t.more(b.items.length - maxItems));

  const waiting = q + m + b.counts.approvals;
  segments.push(b.kind === "mesa_starting" ? t.menuMesa : t.menu(opts.snoozeMin ?? 10, waiting === 1));
  return { locale: b.locale, segments, text: segments.join(" "), menu: CALL_MENU };
};
