"use client";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { ActionError } from "@chalito/client";
import type { AdapterKind, RemotePermissionMode } from "@chalito/protocol";
import { Link, useRouter } from "@/i18n/navigation";
import { useChalito, useLive } from "./ChalitoProvider";
import { REMOTE_MODES } from "./Sessions";

/** The adapters a remote surface starts (the computer's policy still decides which are on), and
 * where their names live (integrations.*, the only place provider names may appear). */
export const START_ADAPTERS: readonly { kind: AdapterKind; name: string }[] = [
  { kind: "claude-code", name: "anthropic.agent" },
  { kind: "codex", name: "openai.agent" },
];
/** The computer may refuse silently (unknown workspace, adapter off): stop waiting after this. */
export const START_WAIT_MS = 30_000;

type Phase =
  { kind: "idle" } | { kind: "waiting"; since: number } | { kind: "timeout" } | { kind: "error"; msg: string };

/**
 * "Nueva sesión": a signed session.start to a paired computer (ClientActions.startSession), the
 * prompt sealed to that computer. The workspace is a label the computer allowed locally; Chalito
 * never sees its paths, so the labels offered are the ones its sessions have used. The computer
 * answers by creating the session, which then shows up live; a refusal is only in its own log.
 */
export const NewSession = () => {
  const t = useTranslations("live.newSession");
  const tm = useTranslations("live.session.modes");
  const ti = useTranslations("integrations");
  const { client } = useChalito();
  const live = useLive();
  const router = useRouter();
  const computers = live.devices.filter((d) => d.role === "agent" && !d.revoked);
  const [agent, setAgent] = useState("");
  const [adapter, setAdapter] = useState<AdapterKind>("claude-code");
  const [workspace, setWorkspace] = useState("");
  const [mode, setMode] = useState<RemotePermissionMode>("default");
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  /** Sessions that existed when the command went out; the new one is whatever appears next. */
  const before = useRef<Set<string>>(new Set());

  const target = agent || computers[0]?.deviceId || "";
  const labels = useMemo(
    () =>
      [
        ...new Set(
          live.sessions
            .filter((s) => s.agentDeviceId === target)
            .map((s) => s.card?.workspaceLabel ?? s.label)
            .filter((l): l is string => !!l),
        ),
      ].sort(),
    [live.sessions, target],
  );

  useEffect(() => {
    if (phase.kind !== "waiting") return;
    const started = live.sessions.find((s) => s.agentDeviceId === target && !before.current.has(s.sid));
    if (started) {
      router.push({ pathname: "/sesiones/[sid]", params: { sid: started.sid } });
      return;
    }
    const left = START_WAIT_MS - (Date.now() - phase.since);
    const timer = setTimeout(() => setPhase({ kind: "timeout" }), Math.max(0, left));
    return () => clearTimeout(timer);
  }, [phase, live.sessions, target, router]);

  if (computers.length === 0)
    return (
      <div className="grid gap-3">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p data-testid="no-computers">{t("noComputers")}</p>
        <Link href="/descargar" className="w-fit text-emerald-700 underline">
          {t("download")}
        </Link>
      </div>
    );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = prompt.trim();
    const label = workspace.trim();
    if (!client || !target || !text || !label) return;
    before.current = new Set(live.sessions.map((s) => s.sid));
    setPhase({ kind: "waiting", since: Date.now() });
    try {
      await client.actions.startSession({
        agentDeviceId: target,
        adapter,
        workspaceLabel: label,
        prompt: text,
        permissionMode: mode,
      });
    } catch (err) {
      setPhase({
        kind: "error",
        msg: err instanceof ActionError && err.code === "untrusted_agent" ? t("untrusted") : t("failed"),
      });
    }
  };

  const selected = computers.find((c) => c.deviceId === target);
  const waiting = phase.kind === "waiting";
  return (
    <form onSubmit={(e) => void submit(e)} className="grid max-w-xl gap-4" data-testid="new-session">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      <label className="grid gap-1">
        <span className="font-medium">{t("computer")}</span>
        <select
          className="rounded-lg border px-3 py-2"
          value={target}
          onChange={(e) => setAgent(e.target.value)}
          disabled={waiting}
        >
          {computers.map((c) => (
            <option key={c.deviceId} value={c.deviceId}>
              {c.name} · {c.online ? t("online") : t("offline")}
            </option>
          ))}
        </select>
      </label>
      {selected && !selected.online ? (
        <p role="note" className="text-sm text-amber-900">
          {t("offlineNote")}
        </p>
      ) : null}
      <fieldset className="grid gap-1">
        <legend className="font-medium">{t("adapter")}</legend>
        <div className="flex gap-4">
          {START_ADAPTERS.map((a) => (
            <label key={a.kind} className="flex items-center gap-2">
              <input
                type="radio"
                name="adapter"
                checked={adapter === a.kind}
                onChange={() => setAdapter(a.kind)}
                disabled={waiting}
              />
              {ti(a.name)}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="grid gap-1">
        <span className="font-medium">{t("workspace")}</span>
        <input
          className="rounded-lg border px-3 py-2"
          list="workspace-labels"
          maxLength={80}
          required
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
          disabled={waiting}
        />
        <datalist id="workspace-labels">
          {labels.map((l) => (
            <option key={l} value={l} />
          ))}
        </datalist>
        <span className="text-sm text-neutral-600">{t("workspaceHint")}</span>
      </label>
      {labels.length ? (
        <div className="flex flex-wrap gap-2" aria-label={t("recent")}>
          {labels.map((l) => (
            <button
              key={l}
              type="button"
              className="rounded-full border px-3 py-1 text-sm"
              onClick={() => setWorkspace(l)}
              disabled={waiting}
            >
              {l}
            </button>
          ))}
        </div>
      ) : null}
      <label className="grid gap-1">
        <span className="font-medium">{t("mode")}</span>
        <select
          className="rounded-lg border px-3 py-2"
          value={mode}
          onChange={(e) => setMode(e.target.value as RemotePermissionMode)}
          disabled={waiting}
        >
          {REMOTE_MODES.map((m) => (
            <option key={m} value={m}>
              {tm(m)}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1">
        <span className="font-medium">{t("prompt")}</span>
        <textarea
          className="min-h-28 rounded-lg border px-3 py-2"
          required
          placeholder={t("promptPlaceholder")}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={waiting}
        />
      </label>
      <button
        className="w-fit rounded-lg bg-emerald-700 px-4 py-2 text-white disabled:opacity-50"
        disabled={waiting || !prompt.trim() || !workspace.trim()}
      >
        {t("start")}
      </button>
      {waiting ? (
        <p role="status" aria-live="polite">
          {t("waiting")}
        </p>
      ) : null}
      {phase.kind === "timeout" ? (
        <p role="alert" data-testid="start-timeout">
          {t("timeout")}
        </p>
      ) : null}
      {phase.kind === "error" ? <p role="alert">{phase.msg}</p> : null}
    </form>
  );
};
