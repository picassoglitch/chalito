// Re-implemented from Alux by Omar (homiomar), pet/intent.js: rules, not a model. Free, instant,
// offline, and the card always asks, so a wrong guess costs one click.

export type VoiceCommand =
  | { kind: "approve" }
  | { kind: "deny" }
  /** `target`: the words naming the session, or null for "the one that needs me". */
  | { kind: "open"; target: string | null }
  /** An empty prompt opens the new-session form. */
  | { kind: "newSession"; prompt: string }
  | { kind: "pause"; minutes: number }
  | { kind: "dnd"; on: boolean };

export interface ParsedVoice {
  /** What was heard, without whisper's [BLANK_AUDIO] / (music) markers. */
  text: string;
  /** In the order they were said, one per kind. */
  commands: VoiceCommand[];
}

/** Lower case, no accents, punctuation as spaces; `at[i]` is folded char i's index in the original. */
const fold = (s: string): { folded: string; at: number[] } => {
  let folded = "";
  const at: number[] = [];
  [...s].reduce((i, ch) => {
    const f = ch
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, " ");
    for (const c of f) {
      folded += c;
      at.push(i);
    }
    return i + ch.length;
  }, 0);
  return { folded, at };
};

const NUM: Record<string, number> = {
  un: 1,
  uno: 1,
  one: 1,
  dos: 2,
  two: 2,
  cinco: 5,
  five: 5,
  diez: 10,
  ten: 10,
  quince: 15,
  fifteen: 15,
  veinte: 20,
  twenty: 20,
  treinta: 30,
  thirty: 30,
  cuarenta: 40,
  forty: 40,
  sesenta: 60,
  sixty: 60,
};
const N = `\\d{1,3}|${Object.keys(NUM).join("|")}`;
const DURATION = new RegExp(
  `(?:\\s(?:por|durante|unos|for|about))*\\s(?:(${N})\\s?(?:min|mins|minuto|minutos|minute|minutes)?|(media hora|half an hour|half hour)|(una hora|an hour|one hour|1 hora))(?=\\s|$)`,
);

const DND_WORDS = "(?:no molestar|no me molestes|do not disturb|dont disturb|dnd)";
const DND_OFF = new RegExp(
  `\\b(?:desactiva\\w*|quita\\w*|apaga\\w*|deshabilita\\w*|termina\\w*|turn off|switch off|disable|end|stop)(?:\\s(?:el|la|modo|mode|the))*\\s${DND_WORDS}\\b|\\b${DND_WORDS}\\s(?:off|apagado|desactivado|fuera)\\b`,
);
const DND_ON = new RegExp(
  `(?:\\b(?:activa\\w*|pon\\w*|enciende|turn on|switch on|enable)(?:\\s(?:el|la|modo|mode|the|en))*\\s)?\\b(?:modo\\s)?${DND_WORDS}\\b(?:\\s(?:on|activado|mode))?`,
);
const PAUSE =
  /\b(?:pausa\w*|pause\w*|silencio|silence|callate|quiet|mute|snooze|shh+|hush|duermete|go to sleep)\b(?:\s(?:a|al|el|la|the|chalito|mascota|pet))*/;
const DENY =
  /\b(?:rechaza\w*|deniega\w*|niegalo|niegala|no (?:lo |la )?(?:apruebes|aprobar|autorices|permitas|aceptes)|deny|reject|decline|refuse|don t (?:approve|allow)|dont (?:approve|allow)|do not (?:approve|allow))\b/;
const APPROVE =
  /\b(?:aprueba\w*|aprob\w*|autoriza\w*|acepta\w*|permitelo|permitela|dale que si|approve|allow it|allow|accept|authorize|go ahead)\b/;
const NEW_SESSION =
  /\b(?:(?:abre|crea|inicia|iniciar|empieza|comienza|arranca)\s(?:una\s)?(?:nueva\s)?sesion|nueva sesion|(?:start|open|create|begin)\s(?:a\s)?(?:new\s)?session|new session)\b(?:\s(?:para|con|que|sobre|de|to|with|about|and|y|for))?/;
const OPEN =
  /\b(?:abre\w*|abrir|muestra\w*|ensename|ve a|ir a|cambia a|open|show(?: me)?|go to|switch to)\s(?:(?:la|el|mi|the|my)\s)?(?:(?:siguiente|proxima|next)\s?)?(?:sesion|session|chat)?\b/;
const NEXT_ALONE = /^\s*(?:(?:la|the)\s)?(?:siguiente|proxima|next)(?:\s(?:sesion|session))?\s*$/;
const FILLER = new Set(
  "y and tambien also luego then porfa por favor please oye hey ok okay chalito ya now de del of for called llamada la el the a an mi my que se llama sesion session".split(
    " ",
  ),
);

const minutesOf = (m: RegExpMatchArray | null): number => {
  if (!m) return 15;
  if (m[2]) return 30;
  if (m[3]) return 60;
  const n = NUM[m[1]!] ?? Number(m[1]);
  return Math.min(Math.max(n, 1), 240);
};

const trimFiller = (s: string): string => {
  const w = s.split(/\s+/).filter(Boolean);
  while (w.length && FILLER.has(w[0]!)) w.shift();
  while (w.length && FILLER.has(w[w.length - 1]!)) w.pop();
  return w.join(" ");
};

export const parseIntent = (raw: string): ParsedVoice => {
  const text = String(raw ?? "")
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const { folded, at } = fold(text);
  const found: { index: number; cmd: VoiceCommand }[] = [];
  let rest = ` ${folded} `;
  const blank = (start: number, len: number) =>
    (rest = rest.slice(0, start) + " ".repeat(len) + rest.slice(start + len));

  // A new session's prompt is free text: commands said inside it are part of the prompt.
  const ns = NEW_SESSION.exec(rest);
  if (ns) {
    const from = ns.index + ns[0].length - 1;
    const prompt = from < at.length ? text.slice(at[Math.max(0, from)] ?? text.length).trim() : "";
    found.push({ index: ns.index, cmd: { kind: "newSession", prompt: prompt.replace(/^[\s,.:;-]+/, "") } });
    rest = rest.slice(0, ns.index).padEnd(rest.length);
  }
  const off = DND_OFF.exec(rest);
  if (off) {
    found.push({ index: off.index, cmd: { kind: "dnd", on: false } });
    blank(off.index, off[0].length);
  }
  const on = DND_ON.exec(rest);
  if (on) {
    found.push({ index: on.index, cmd: { kind: "dnd", on: true } });
    blank(on.index, on[0].length);
  }
  const pause = PAUSE.exec(rest);
  if (pause) {
    const tail = rest.slice(pause.index + pause[0].length);
    const d = DURATION.exec(` ${tail}`);
    const near = d && d.index <= 1 ? d : null;
    found.push({ index: pause.index, cmd: { kind: "pause", minutes: minutesOf(near) } });
    const end = pause.index + pause[0].length + (near ? near.index - 1 + near[0].length : 0);
    blank(pause.index, end - pause.index);
  }
  const deny = DENY.exec(rest);
  if (deny) {
    found.push({ index: deny.index, cmd: { kind: "deny" } });
    blank(deny.index, deny[0].length);
  }
  const approve = deny ? null : APPROVE.exec(rest);
  if (approve) {
    found.push({ index: approve.index, cmd: { kind: "approve" } });
    blank(approve.index, approve[0].length);
  }
  const open = OPEN.exec(rest);
  const opensSomething = open && (/sesion|session|chat|siguiente|proxima|next/.test(open[0]) || !found.length);
  if (open && opensSomething) {
    const target = trimFiller(rest.slice(open.index + open[0].length).replace(/\s+/g, " "));
    found.push({
      index: open.index,
      cmd: { kind: "open", target: target && !/^(?:siguiente|proxima|next|pendiente)$/.test(target) ? target : null },
    });
  } else if (NEXT_ALONE.test(rest)) {
    found.push({ index: 0, cmd: { kind: "open", target: null } });
  }
  return { text, commands: found.sort((a, b) => a.index - b.index).map((f) => f.cmd) };
};
