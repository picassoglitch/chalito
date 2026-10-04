/** A function the voice model may call. Tools only ever return short text; none approves anything. */
export interface RealtimeTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface RealtimeSessionConfig {
  model: string;
  instructions: string;
  /** OpenAI voice name (e.g. "marin"). */
  voice: string;
  tools: RealtimeTool[];
}

/**
 * ADR 0005's VoiceProvider for OpenAI Realtime: ephemeral client secrets for the desktop
 * (WebRTC straight to OpenAI) and SIP call control for calls bridged from Twilio.
 */
export interface VoiceProvider {
  mintClientSecret(p: {
    session: RealtimeSessionConfig;
    ttlSec: number;
    safetyIdentifier: string;
  }): Promise<{ value: string; expiresAt: number }>;
  acceptCall(callId: string, session: RealtimeSessionConfig): Promise<void>;
  rejectCall(callId: string, statusCode?: number): Promise<void>;
  hangupCall(callId: string): Promise<void>;
  /** The server-side WebSocket for a SIP call's events and tool calls. */
  callSocket(callId: string): { url: string; headers: Record<string, string> };
}

const sessionBody = (s: RealtimeSessionConfig) => ({
  type: "realtime",
  model: s.model,
  instructions: s.instructions,
  audio: { output: { voice: s.voice } },
  tools: s.tools,
  tool_choice: "auto",
});

export const openaiRealtime = (opts: { apiKey: string; fetch?: typeof fetch; baseUrl?: string }): VoiceProvider => {
  const base = opts.baseUrl ?? "https://api.openai.com";
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await (opts.fetch ?? fetch)(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`openai ${path} failed: ${res.status}`);
    return res;
  };
  return {
    async mintClientSecret({ session, ttlSec, safetyIdentifier }) {
      const res = await post(
        "/v1/realtime/client_secrets",
        { expires_after: { anchor: "created_at", seconds: ttlSec }, session: sessionBody(session) },
        { "openai-safety-identifier": safetyIdentifier },
      );
      const json = (await res.json()) as { value?: string; expires_at?: number };
      if (!json.value || !json.expires_at) throw new Error("openai client secret: malformed response");
      return { value: json.value, expiresAt: json.expires_at * 1000 };
    },
    async acceptCall(callId, session) {
      await post(`/v1/realtime/calls/${encodeURIComponent(callId)}/accept`, sessionBody(session));
    },
    async rejectCall(callId, statusCode = 603) {
      await post(`/v1/realtime/calls/${encodeURIComponent(callId)}/reject`, { status_code: statusCode });
    },
    async hangupCall(callId) {
      await post(`/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, {});
    },
    callSocket(callId) {
      return {
        url: `${base.replace(/^http/, "ws")}/v1/realtime?call_id=${encodeURIComponent(callId)}`,
        headers: { authorization: `Bearer ${opts.apiKey}` },
      };
    },
  };
};
