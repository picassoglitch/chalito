import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n.js";
import { IpcUnavailableError, type AgentIpc, type PendingPairing } from "../lib/ipc.js";
import type { AgentStatus } from "../lib/local-agent.js";
import { GlyphView } from "./GlyphView.js";

/** How often the panel re-reads the pairing while it's open. */
export const PAIRING_POLL_MS = 1500;

const LIVE = new Set(["starting", "waiting", "claimed", "replace"]);

/**
 * "Conectar esta computadora" (ADR 0028 §3): pairing with no terminal. The agent creates the code;
 * the panel opens the approval page in the system browser (code id in the fragment, never the
 * short code), shows this computer's verification code and the short code for another network,
 * then asks the local reverse check: only "Sí, fui yo" makes this computer trust the approver.
 */
export const ConnectComputer = ({
  ipc,
  openUrl,
  agentStatus,
  pollMs = PAIRING_POLL_MS,
}: {
  ipc: AgentIpc;
  openUrl: (url: string) => Promise<void>;
  /** The supervisor's state (src-tauri/src/agent.rs); `not_paired` shows this card. */
  agentStatus: () => Promise<AgentStatus>;
  pollMs?: number;
}) => {
  const t = useT();
  const [notPaired, setNotPaired] = useState(false);
  const [p, setP] = useState<PendingPairing | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const opened = useRef<string | null>(null);

  const read = useCallback(async () => {
    await agentStatus().then(
      (s) => setNotPaired(s.state === "not_paired"),
      () => undefined,
    );
    await ipc.pendingPairing().then(
      (v) => (setP(v), setUnavailable(false)),
      (e: unknown) => e instanceof IpcUnavailableError && setUnavailable(true),
    );
  }, [ipc, agentStatus]);
  useEffect(() => {
    void read();
    const timer = setInterval(() => void read(), pollMs);
    return () => clearInterval(timer);
  }, [read, pollMs]);

  // Open the approval page once per pairing, as soon as the code exists.
  useEffect(() => {
    if (p?.state === "waiting" && p.computer && opened.current !== p.pairingId) {
      opened.current = p.pairingId;
      void openUrl(p.computer.approveUrl).catch(() => undefined);
    }
  }, [p, openUrl]);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const v = await run();
      if (v && typeof v === "object" && "pairingId" in v) setP(v as PendingPairing);
      await read();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!notPaired && (!p || p.state === "paired")) return null;

  const start = () => act(() => ipc.startPairing());
  const answer = (match: boolean, phrase?: string) => p && act(() => ipc.confirmPairing(p.pairingId, match, phrase));
  const live = p && LIVE.has(p.state);

  return (
    <section aria-labelledby="connect-title" data-section="connect" data-pairing={p?.state ?? "idle"} className="card">
      <h2 id="connect-title">{t("connect.title")}</h2>
      {unavailable && <p className="muted">{t("connect.starting")}</p>}
      {error && <p role="alert">{t("connect.error", { code: error })}</p>}

      {!live && p?.state === "paired" && <p data-done>{t("connect.paired")}</p>}
      {!live && p && p.state !== "paired" && <p role="status">{t(`connect.ended.${p.state}`)}</p>}
      {!live && !unavailable && p?.state !== "paired" && (
        <>
          <p>{t("connect.intro")}</p>
          <button className="primary" disabled={busy} onClick={() => void start()}>
            {t("connect.start")}
          </button>
        </>
      )}

      {p?.state === "starting" && <p className="muted">{t("connect.preparing")}</p>}

      {p?.state === "waiting" && p.computer && (
        <div data-step="waiting">
          <p>{t("connect.waiting", { label: p.computer.label })}</p>
          <p className="muted">{t("connect.verification")}</p>
          <code className="fingerprint" data-fingerprint>
            {p.computer.fingerprint}
          </code>
          <p className="muted">{t("connect.otherNetwork")}</p>
          <code className="short-code" data-short-code>
            {p.computer.shortCode}
          </code>
          <details>
            <summary>{t("connect.phone")}</summary>
            <GlyphView glyph={p.computer.glyph} label={t("connect.glyphLabel")} />
          </details>
          <div className="row">
            <button onClick={() => void openUrl(p.computer!.approveUrl).catch(() => undefined)}>
              {t("connect.reopen")}
            </button>
            <button disabled={busy} onClick={() => void answer(false)}>
              {t("connect.cancel")}
            </button>
          </div>
        </div>
      )}

      {p?.state === "claimed" && p.claimer && (
        <div data-step="reverse">
          <p>{t("connect.reverse.question")}</p>
          <p className="muted">{t("connect.reverse.compare")}</p>
          <code className="fingerprint" data-claimer>
            {p.claimer.fingerprint}
          </code>
          {p.claimer.passkeyId ? (
            <p className="muted">{t("connect.reverse.passkey", { id: p.claimer.passkeyId })}</p>
          ) : (
            <p className="muted">{t("connect.reverse.noPasskey")}</p>
          )}
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void answer(true)}>
              {t("connect.reverse.yes")}
            </button>
            <button disabled={busy} onClick={() => void answer(false)}>
              {t("connect.reverse.no")}
            </button>
          </div>
        </div>
      )}

      {p?.state === "replace" && p.replacePhrase && (
        <div data-step="replace">
          <p role="alert">{t("connect.replace.warning")}</p>
          <label>
            {t("connect.replace.prompt", { phrase: p.replacePhrase })}
            <input value={typed} onChange={(e) => setTyped(e.target.value)} />
          </label>
          <div className="row">
            <button disabled={busy || typed.trim() !== p.replacePhrase} onClick={() => void answer(true, typed.trim())}>
              {t("connect.replace.go")}
            </button>
            <button disabled={busy} onClick={() => void answer(false)}>
              {t("connect.cancel")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
};
