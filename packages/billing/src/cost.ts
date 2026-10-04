import type { PricesConfig } from "@chalito/config";

/**
 * Provider cost in integer USD micros (the hub's `cost_usd_micros`), from prices.yaml. Pure.
 * Every function rounds UP: the hub bills cost × (1 + margin), so rounding never undercharges.
 * Unknown models throw (we can't price them, so callers fail closed before spending).
 */
const PER_MILLION = 1_000_000;
const micros = (usd: number) => Math.ceil(Math.round(usd * 1e12) / 1e6);

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Anthropic prices 5-minute and 1-hour cache writes differently. */
  cacheWriteTtl?: "5m" | "1h";
}

export const llmCostMicros = (prices: PricesConfig, provider: string, model: string, t: TokenUsage): number => {
  const p = (prices.llm as Record<string, Record<string, Record<string, number | undefined>>>)[provider]?.[model];
  if (!p || p.input === undefined || p.output === undefined) throw new Error(`no price for ${provider}/${model}`);
  const cacheWriteRate = (t.cacheWriteTtl === "1h" ? p.cacheWrite1h : p.cacheWrite5m) ?? p.cacheWrite ?? p.input; // no cache price: bill as input
  const usd =
    (t.input * p.input +
      t.output * p.output +
      (t.cacheRead ?? 0) * (p.cacheRead ?? p.input) +
      (t.cacheWrite ?? 0) * cacheWriteRate) /
    PER_MILLION;
  return micros(usd);
};

export interface RealtimeTokens {
  audioIn?: number;
  audioCached?: number;
  audioOut?: number;
  textIn?: number;
  textCached?: number;
  textOut?: number;
}

export const realtimeCostMicros = (prices: PricesConfig, model: string, t: RealtimeTokens): number => {
  const p = prices.realtime[model];
  if (!p) throw new Error(`no realtime price for ${model}`);
  const r = (k: keyof RealtimeTokens) => {
    const unit = p[k];
    if (unit === undefined && (t[k] ?? 0) > 0) throw new Error(`no ${k} price for ${model}`);
    return (t[k] ?? 0) * (unit ?? 0);
  };
  const usd =
    (r("audioIn") + r("audioCached") + r("audioOut") + r("textIn") + r("textCached") + r("textOut")) / PER_MILLION;
  return micros(usd);
};

/** Realtime audio tokens per second (OpenAI: user audio 1 token / 100 ms, assistant 1 token / 50 ms). */
export const AUDIO_TOKENS_PER_SECOND = { user: 10, assistant: 20 } as const;

/**
 * Voice seconds when only wall-clock time is known (desktop heartbeats, SIP calls): priced as if
 * both sides spoke the whole time, an upper bound (≈ $0.03/min for gpt-realtime-2.1-mini).
 */
export const voiceSecondsCostMicros = (prices: PricesConfig, model: string, seconds: number): number =>
  realtimeCostMicros(prices, model, {
    audioIn: seconds * AUDIO_TOKENS_PER_SECOND.user,
    audioOut: seconds * AUDIO_TOKENS_PER_SECOND.assistant,
  });

/** Twilio bills voice per started minute; SIP to OpenAI adds the SIP interface rate. */
export const callCostMicros = (
  prices: PricesConfig,
  c: { seconds: number; destination: string; sip?: boolean; gathersWithSpeech?: number; ttsChars?: number },
): number => {
  const minutes = Math.ceil(Math.max(0, c.seconds) / 60);
  const t = prices.twilio;
  const usd =
    minutes * (t.perMinute[c.destination] ?? Math.max(...Object.values(t.perMinute))) +
    (c.sip ? minutes * (t.perMinute.sipInterface ?? 0) : 0) +
    (c.gathersWithSpeech ?? 0) * t.gatherSpeech +
    Math.ceil((c.ttsChars ?? 0) / 100) * (t.tts.neuralPer100Chars ?? 0);
  return micros(usd);
};

/** Unknown markets are priced at the most expensive known rate (conservative, never zero). */
const rate = (table: Record<string, number>, key: string) => table[key] ?? Math.max(...Object.values(table));

export const smsCostMicros = (prices: PricesConfig, country: string, segments: number): number =>
  micros(segments * rate(prices.twilio.smsSegment, country.toUpperCase()));

const LATAM = new Set([
  "AR",
  "BO",
  "BR",
  "CL",
  "CO",
  "CR",
  "CU",
  "DO",
  "EC",
  "GT",
  "HN",
  "NI",
  "PA",
  "PE",
  "PR",
  "PY",
  "SV",
  "UY",
  "VE",
]);
export const whatsappMarket = (country: string) => {
  const c = country.toUpperCase();
  if (c === "MX") return "MX";
  if (c === "US" || c === "CA") return "NorthAmerica";
  if (c === "ES") return "ES";
  if (LATAM.has(c)) return "LatamOther";
  return "unknown";
};

export const whatsappCostMicros = (prices: PricesConfig, country: string, messages = 1): number =>
  micros(messages * rate(prices.whatsapp.utility, whatsappMarket(country)));

export const computeCostMicros = (
  prices: PricesConfig,
  seconds: number,
  lane: "standard" | "boost" = "standard",
): number => Math.ceil(seconds * prices.compute.cloudRunMicrosPerSecond[lane]);
