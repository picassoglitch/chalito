import type { BriefingScript } from "@chalito/escalation";
import type { Locale } from "@chalito/protocol";

export const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const LANG: Record<Locale, string> = { es: "es-MX", en: "en-US" };
const doc = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

/**
 * The briefing call (ADR 0011, D-014): one <Gather> (DTMF + speech, es-MX without a
 * speechModel, speechTimeout auto, one digit) around the spoken script.
 */
export const briefingTwiml = (script: BriefingScript, voice: string, gatherUrl: string) => {
  const lang = LANG[script.locale];
  return doc(
    `<Gather input="dtmf speech" language="${lang}" numDigits="1" speechTimeout="auto" actionOnEmptyResult="true" method="POST" action="${escapeXml(gatherUrl)}">` +
      `<Say voice="${escapeXml(voice)}" language="${lang}">${escapeXml(script.text)}</Say></Gather>`,
  );
};

/** DTMF 1: bridge to the companion over SIP (OpenAI Realtime; D-014). */
export const connectTwiml = (sipUri: string) => doc(`<Dial><Sip>${escapeXml(sipUri)}</Sip></Dial>`);

export const sayAndHangup = (text: string, voice: string, locale: Locale) =>
  doc(`<Say voice="${escapeXml(voice)}" language="${LANG[locale]}">${escapeXml(text)}</Say><Hangup/>`);

export const emptyTwiml = () => doc("");

export type MenuChoice = "connect" | "snooze" | "dismiss";

const SPOKEN: [RegExp, MenuChoice][] = [
  [/\b(uno|one|conectar|con[eé]ctame|connect|join)\b/i, "connect"],
  [/\b(dos|two|despu[eé]s|m[aá]s tarde|posponer|later|snooze)\b/i, "snooze"],
  [/\b(tres|three|descartar|dismiss)\b/i, "dismiss"],
];

/** The fixed menu: 1 connect, 2 snooze, 3 dismiss (digits, or the same words spoken). */
export const menuChoice = (digits: string | undefined, speech: string | undefined): MenuChoice | null => {
  if (digits === "1") return "connect";
  if (digits === "2") return "snooze";
  if (digits === "3") return "dismiss";
  if (speech) for (const [re, choice] of SPOKEN) if (re.test(speech)) return choice;
  return null;
};
