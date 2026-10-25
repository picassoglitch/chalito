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

const words = (list: string, from: number) => Object.fromEntries(list.split(" ").map((w, i) => [w, from + i] as const));
/** "un/una/a/an" count only before a unit ("una hora"), never alone ("un rato"). */
const ARTICLE: Record<string, number> = { un: 1, una: 1, a: 1, an: 1 };
const UNITS: Record<string, number> = {
  ...words("uno dos tres cuatro cinco seis siete ocho nueve", 1),
  ...words("one two three four five six seven eight nine", 1),
};
const TEENS: Record<string, number> = {
  ...words("diez once doce trece catorce quince", 10),
  ...words("ten eleven twelve thirteen fourteen fifteen", 10),
};
const TENS: Record<string, number> = {
  veinte: 20,
  twenty: 20,
  treinta: 30,
  thirty: 30,
  cuarenta: 40,
  forty: 40,
  cincuenta: 50,
  fifty: 50,
  sesenta: 60,
  sixty: 60,
  noventa: 90,
  ninety: 90,
};
const HOUR_WORDS = new Set(["hora", "horas", "hour", "hours", "h", "hr", "hrs"]);
const MINUTE_WORDS = new Set(["min", "mins", "minuto", "minutos", "minute", "minutes", "m"]);
const LEAD = new Set(["por", "durante", "unos", "unas", "for", "about", "like", "around", "some", "like"]);

/** A spoken number at w[i]: "45", "cuarenta y cinco", "veinticinco", "twenty five", "1h". */
const readNumber = (w: string[], i: number): { n: number; next: number; unit?: "h" | "m"; article?: true } | null => {
  const x = w[i] ?? "";
  const glued = /^(\d{1,3})(h|hr|hrs|m|min)$/.exec(x);
  if (glued) return { n: Number(glued[1]), next: i + 1, unit: glued[2]!.startsWith("h") ? "h" : "m" };
  if (/^\d{1,3}$/.test(x)) return { n: Number(x), next: i + 1 };
  const veinti = /^veinti(\w+)$/.exec(x);
  if (veinti && UNITS[veinti[1]!] !== undefined) return { n: 20 + UNITS[veinti[1]!]!, next: i + 1 };
  if (TENS[x] !== undefined) {
    const t = TENS[x]!;
    if (w[i + 1] === "y" && UNITS[w[i + 2] ?? ""] !== undefined) return { n: t + UNITS[w[i + 2]!]!, next: i + 3 };
    if (UNITS[w[i + 1] ?? ""] !== undefined) return { n: t + UNITS[w[i + 1]!]!, next: i + 2 };
    return { n: t, next: i + 1 };
  }
  if (TEENS[x] !== undefined) return { n: TEENS[x]!, next: i + 1 };
  if (UNITS[x] !== undefined) return { n: UNITS[x]!, next: i + 1 };
  if (ARTICLE[x] !== undefined) return { n: 1, next: i + 1, article: true };
  return null;
};

/** How long a pause the words right after "pausa" ask for, and how many of them that took. */
const duration = (w: string[]): { minutes: number; used: number } | null => {
  let i = 0;
  while (LEAD.has(w[i] ?? "")) i++;
  if (w[i] === "media" && w[i + 1] === "hora") return { minutes: 30, used: i + 2 };
  if (w[i] === "half" && w[i + 1] === "an" && w[i + 2] === "hour") return { minutes: 30, used: i + 3 };
  if (w[i] === "half" && w[i + 1] === "hour") return { minutes: 30, used: i + 2 };
  const num = readNumber(w, i);
  if (!num) return null;
  const unitWord = w[num.next] ?? "";
  const unit = num.unit ?? (HOUR_WORDS.has(unitWord) ? "h" : MINUTE_WORDS.has(unitWord) ? "m" : undefined);
  const used = num.unit || !unit ? num.next : num.next + 1;
  // A bare number counts as minutes only when nothing follows it ("silencio 20"); "un rato" isn't one.
  if (!unit && (num.article || w.slice(num.next).some(Boolean))) return null;
  return { minutes: unit === "h" ? num.n * 60 : num.n, used };
};

const DND_WORDS = "(?:no molestar|no me molestes|do not disturb|dont disturb|don t disturb|dnd)";
const DND_OFF = new RegExp(
  `\\b(?:desactiva\\w*|quita\\w*|apaga\\w*|deshabilita\\w*|termina\\w*|turn off|switch off|disable|end|stop)(?:\\s(?:el|la|modo|mode|the))*\\s${DND_WORDS}\\b|\\b${DND_WORDS}\\s(?:off|apagado|desactivado|fuera)\\b`,
);
const DND_ON = new RegExp(
  `(?:\\b(?:activa\\w*|pon\\w*|enciende|turn on|switch on|enable)(?:\\s(?:el|la|modo|mode|the|en))*\\s)?\\b(?:modo\\s)?${DND_WORDS}\\b(?:\\s(?:on|activado|mode))?`,
);
const PAUSE =
  /\b(?:pausa\w*|pause\w*|silencio|silence|callate|quiet|mute|snooze|shh+|hush|duermete|go to sleep)\b(?:\s(?:a|al|el|la|the|chalito|mascota|pet))*/;
const DENY =
  /\b(?:rechaza\w*|deniega\w*|niegalo|niegala|no (?:\w+ ){0,3}(?:apruebes|autorices|permitas|aceptes|dejes)|deny|reject|decline|refuse)\b/;
const APPROVE =
  /\b(?:aprueba\w*|aprobar(?:lo|la|los|las)?|autoriza(?:lo|la|los|las|r)?|acepta(?:lo|la|los|las|r)?|permitelo|permitela|dale que si|approve|allow it|allow|accept|authorize|go ahead)\b/;
/** "no / don't / never" a few words before an approve verb turns it into a deny. */
const NEGATED =
  /\b(?:no|don t|dont|not|never|nunca|jamas|ni|can t|cant|cannot|won t|wont|shouldn t|shouldnt)\b(?:\s+\S+){0,5}\s*$/;
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
    const from = pause.index + pause[0].length;
    const tokens = [...rest.slice(from).matchAll(/\S+/g)];
    const d = duration(tokens.map((t) => t[0]));
    const minutes = d ? Math.min(Math.max(d.minutes, 1), 240) : 15;
    found.push({ index: pause.index, cmd: { kind: "pause", minutes } });
    const last = d && d.used ? tokens[d.used - 1]! : null;
    blank(pause.index, (last ? from + last.index + last[0].length : from) - pause.index);
  }
  // A question ("¿ya lo aprobaste?") neither approves nor denies.
  const asks = /[?¿]/.test(text);
  const deny = asks ? null : DENY.exec(rest);
  if (deny) {
    found.push({ index: deny.index, cmd: { kind: "deny" } });
    blank(deny.index, deny[0].length);
  }
  const approve = deny || asks ? null : APPROVE.exec(rest);
  if (approve) {
    const negated = NEGATED.test(rest.slice(0, approve.index));
    found.push({ index: approve.index, cmd: { kind: negated ? "deny" : "approve" } });
    blank(approve.index, approve[0].length);
  }
  const open = OPEN.exec(rest);
  const target = open ? trimFiller(rest.slice(open.index + open[0].length).replace(/\s+/g, " ")) : "";
  const opensSomething =
    open && (/sesion|session|chat|siguiente|proxima|next/.test(open[0]) || !found.length || target);
  if (open && opensSomething) {
    found.push({
      index: open.index,
      cmd: { kind: "open", target: target && !/^(?:siguiente|proxima|next|pendiente)$/.test(target) ? target : null },
    });
  } else if (NEXT_ALONE.test(rest)) {
    found.push({ index: 0, cmd: { kind: "open", target: null } });
  }
  return { text, commands: found.sort((a, b) => a.index - b.index).map((f) => f.cmd) };
};
