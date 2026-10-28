import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../lib/i18n.js";
import { IpcUnavailableError, type AgentIpc, type PendingPairing } from "../lib/ipc.js";
import type { AgentStatus } from "../lib/local-agent.js";
import { approvedByThisPanel, type ClaimOutcome } from "../lib/auto-pair.js";
import { GlyphView } from "./GlyphView.js";

/**
 * Owner decision 2026-10-19 ("sign-in alone"): the signed-in panel connects this computer by
 * itself. Null while signed out.
 */
export interface AutoPair {
  /** Claims the code this computer shows, as this panel (lib/auto-pair.ts). */
  claim(p: PendingPairing): Promise<ClaimOutcome>;
  /** This panel's own key fingerprint: the reverse check says yes to it by itself. */
  ownFingerprint: string;
  /**
   * Sign-in alone: another active client of this account (a browser or phone the person signed in
   * on) approved it, as the devices directory lists it. Also confirmed by itself.
   */
  isAccountClient?: (fingerprint: string) => Promise<boolean>;
}

/** How often the panel re-reads the pairing while it's open. */
export const PAIRING_POLL_MS = 1500;

const LIVE = new Set(["starting", "waiting", "claimed", "replace"]);

/**
 * "Conectar esta computadora" (ADR 0028 §3): pairing with no terminal. Signed in (`auto`), the
 * panel starts it, claims the code itself and answers the reverse check for its own key: nothing
 * to tap. Signed out, or if that fails, the manual flow: the panel opens the approval page in the
 * system browser (code id in the fragment, never the short code), shows this computer's
 * verification code and the short code for another network, then asks the local reverse check:
 * only "Sí, fui yo" makes this computer trust the approver.
 */
export const ConnectComputer = ({
  ipc,
  openUrl,
  agentStatus,
  auto = null,
  signedIn = auto !== null,
  pollMs = PAIRING_POLL_MS,
}: {
  ipc: AgentIpc;
  openUrl: (url: string) => Promise<void>;
  /** The supervisor's state (src-tauri/src/agent.rs); `not_paired` shows this card. */
  agentStatus: () => Promise<AgentStatus>;
  auto?: AutoPair | null;
  /** The panel is signed in (shown when it isn't: signing in is what connects this computer). */
  signedIn?: boolean;
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
  /** Auto pairing: started once per signed-in panel; each code claimed and confirmed once. */
  const autoStarted = useRef(false);
  const claimed = useRef<string | null>(null);
  const confirmed = useRef<string | null>(null);
  const [autoError, setAutoError] = useState<string | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  /** Auto mode: the pairing whose approver isn't ours to vouch for, so the person answers. */
  const [askReverse, setAskReverse] = useState<string | null>(null);

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

  // Signed in and not connected: start once by itself. A failed try leaves the button.
  useEffect(() => {
    if (!auto || !notPaired || unavailable || autoStarted.current) return;
    if (p && LIVE.has(p.state)) return;
    autoStarted.current = true;
    setAutoBusy(true);
    void ipc.startPairing().then(
      (v) => setP(v),
      (e: unknown) => (setAutoBusy(false), setAutoError(e instanceof Error ? e.message : String(e))),
    );
  }, [auto, notPaired, unavailable, p, ipc]);

  useEffect(() => {
    if (!p) return;
    // Signed in: claim the code as this panel instead of sending the person to the browser.
    if (auto && p.state === "waiting" && p.computer && claimed.current !== p.pairingId) {
      claimed.current = p.pairingId;
      opened.current = p.pairingId;
      setAutoBusy(true);
      void auto.claim(p).then((r) => {
        if (r.ok) return;
        setAutoBusy(false);
        setAutoError(r.reason);
        // Fall back to the approval page, as if signed out.
        void openUrl(p.computer!.approveUrl).catch(() => undefined);
      });
      return;
    }
    // The approver is this panel itself, or another device the person signed in on: say
    // "Sí, fui yo" for the person. Anyone else waits for their answer.
    if (auto && p.state === "claimed" && p.claimer && confirmed.current !== p.pairingId) {
      confirmed.current = p.pairingId;
      const fp = p.claimer.fingerprint;
      const yes = () =>
        void ipc.confirmPairing(p.pairingId, true).then(
          (v) => v && setP(v),
          (e: unknown) => (setAutoBusy(false), setAutoError(e instanceof Error ? e.message : String(e))),
        );
      if (approvedByThisPanel(p, auto.ownFingerprint)) {
        yes();
        return;
      }
      setAutoBusy(true);
      void (auto.isAccountClient?.(fp) ?? Promise.resolve(false)).then(
        (mine) => {
          if (mine) return yes();
          setAutoBusy(false);
          setAskReverse(p.pairingId);
        },
        () => (setAutoBusy(false), setAskReverse(p.pairingId)),
      );
      return;
    }
    if (!LIVE.has(p.state)) setAutoBusy(false);
    // Open the approval page once per pairing, as soon as the code exists.
    if (!auto && p.state === "waiting" && p.computer && opened.current !== p.pairingId) {
      opened.current = p.pairingId;
      void openUrl(p.computer.approveUrl).catch(() => undefined);
    }
  }, [p, openUrl, auto, ipc]);

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

  const start = () => (setAutoError(null), act(() => ipc.startPairing()));
  const answer = (match: boolean, phrase?: string) => p && act(() => ipc.confirmPairing(p.pairingId, match, phrase));
  const live = p && LIVE.has(p.state);

  return (
    <section aria-labelledby="connect-title" data-section="connect" data-pairing={p?.state ?? "idle"} className="card">
      <h2 id="connect-title">{t("connect.title")}</h2>
      {unavailable && <p className="muted">{t("connect.starting")}</p>}
      {error && <p role="alert">{t("connect.error", { code: error })}</p>}
      {autoError && !error && <p role="alert">{t("connect.autoFailed", { code: autoError })}</p>}
      {!signedIn && !live && (
        <p className="muted" data-needs-sign-in>
          {t("connect.needsSignIn")}
        </p>
      )}
      {autoBusy && !autoError && (
        <p role="status" data-auto>
          {t("connect.auto")}
        </p>
      )}

      {!live && p?.state === "paired" && <p data-done>{t("connect.paired")}</p>}
      {!live && p && p.state !== "paired" && (
        <p role="status">
          {/* A failure that isn't the password prompt shows its code, not "the prompt was cancelled". */}
          {p.state === "failed" && p.error && p.error !== "os_auth_failed"
            ? t("connect.error", { code: p.error })
            : t(`connect.ended.${p.state}`)}
        </p>
      )}
      {!live && !unavailable && !autoBusy && p?.state !== "paired" && (
        <>
          <p>{t("connect.intro")}</p>
          <button className="primary" disabled={busy} onClick={() => void start()}>
            {t("connect.start")}
          </button>
        </>
      )}

      {p?.state === "starting" && <p className="muted">{t("connect.preparing")}</p>}

      {p?.state === "waiting" && p.computer && !(auto && autoBusy) && (
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

      {p?.state === "claimed" && p.claimer && (!auto || askReverse === p.pairingId) && (
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
