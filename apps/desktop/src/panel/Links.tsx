import { useCallback, useEffect, useState } from "react";
import {
  LINK_MAX_DAILY_TOKENS,
  LINK_MAX_RATE_PER_HOUR,
  type LinkMode,
  type RemotePermissionMode,
} from "@chalito/protocol";
import { useT } from "../lib/i18n.js";
import {
  IpcUnavailableError,
  type AgentIpc,
  type LinkChallenge,
  type LinkIdentity,
  type LinkSpec,
  type LinksView,
} from "../lib/ipc.js";
import { deviceCode, linkCode, newLinkId, parseDeviceCode, parseLinkCode } from "../lib/link-codes.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CEILINGS: RemotePermissionMode[] = ["plan", "default", "acceptEdits"];

type Load =
  | { state: "loading" }
  | { state: "ok"; value: LinksView }
  | { state: "unavailable" }
  | { state: "error"; error: string };

const short = (deviceId: string) => deviceId.slice(0, 8);

interface Draft {
  mode: LinkMode;
  other: "here" | "other";
  direction: "send" | "receive";
  otherCode: string;
  workspaceLabel: string;
  goal: string;
  days: number;
  dailyTokenBudget: number;
  ratePerHour: number;
  confirm: boolean;
  permissionCeiling: RemotePermissionMode;
}

const EMPTY: Draft = {
  mode: "handoff",
  other: "here",
  direction: "send",
  otherCode: "",
  workspaceLabel: "",
  goal: "",
  days: 7,
  dailyTokenBudget: 200_000,
  ratePerHour: 10,
  confirm: true,
  permissionCeiling: "default",
};

/** The draft as the agent's link spec, or the key of what's missing. */
const toSpec = (d: Draft, self: LinkIdentity, now: number): LinkSpec | { problem: string } => {
  const mine = { deviceId: self.deviceId, pubSign: self.pubSign, pubBox: self.pubBox };
  let sender: LinkSpec["sender"] = { deviceId: self.deviceId };
  let receiver: LinkSpec["receiver"] = { deviceId: self.deviceId };
  if (d.other === "other") {
    const peer = parseDeviceCode(d.otherCode);
    if (!peer) return { problem: "badDeviceCode" };
    if (peer.deviceId === self.deviceId) return { problem: "sameComputer" };
    [sender, receiver] = d.direction === "send" ? [mine, peer] : [peer, mine];
  }
  if (!d.workspaceLabel.trim()) return { problem: "noWorkspace" };
  if (!d.goal.trim()) return { problem: "noGoal" };
  return {
    id: newLinkId(),
    mode: d.mode,
    sender,
    receiver,
    workspaceLabel: d.workspaceLabel.trim(),
    goal: d.goal.trim(),
    expiresAt: now + Math.min(30, Math.max(1, Math.round(d.days))) * DAY_MS,
    dailyTokenBudget: Math.min(LINK_MAX_DAILY_TOKENS, Math.max(1, Math.round(d.dailyTokenBudget))),
    ratePerHour: Math.min(LINK_MAX_RATE_PER_HOUR, Math.max(1, Math.round(d.ratePerHour))),
    confirm: d.confirm,
    permissionCeiling: d.mode === "handoff" ? d.permissionCeiling : "default",
  };
};

/** What a link allows, as one line per fact (list rows and the pasted link's review). */
const LinkFacts = ({ link, self }: { link: LinkSpec; self: string | null }) => {
  const t = useT();
  const end = (deviceId: string) => (deviceId === self ? t("security.links.thisComputer") : short(deviceId));
  return (
    <>
      <span>
        {t(`security.links.mode.${link.mode}`)}: {end(link.sender.deviceId)} → {end(link.receiver.deviceId)}
      </span>
      <span className="muted">
        {t("security.links.facts", {
          workspace: link.workspaceLabel,
          expires: new Date(link.expiresAt).toLocaleDateString(),
          confirm: t(link.confirm ? "security.links.askEachTime" : "security.links.automatic"),
          ceiling: link.permissionCeiling,
        })}
      </span>
      <span className="muted">{link.goal}</span>
    </>
  );
};

/** The agent's confirmation, then its typed phrase; the agent asks the OS and re-checks both. */
const LinkFlow = ({
  ipc,
  spec,
  challenge,
  onDone,
}: {
  ipc: AgentIpc;
  spec: LinkSpec;
  challenge: LinkChallenge;
  onDone: (ok: boolean, failure?: string) => void;
}) => {
  const t = useT();
  const [step, setStep] = useState<1 | 2>(1);
  const [typed, setTyped] = useState("");
  const cancel = <button onClick={() => onDone(false)}>{t("security.devmode.cancel")}</button>;
  if (step === 1)
    return (
      <div className="card" data-step="1">
        <p>{t(`security.links.step1.${spec.mode}`)}</p>
        <ul>
          {challenge.summary.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
        <div className="row">
          <button onClick={() => setStep(2)}>{t("security.devmode.continue")}</button>
          {cancel}
        </div>
      </div>
    );
  return (
    <div className="card" data-step="2">
      <p>{t("security.links.step2", { phrase: challenge.phrase })}</p>
      <input aria-label={challenge.phrase} value={typed} onChange={(e) => setTyped(e.target.value)} />
      <div className="row">
        <button
          disabled={typed.trim() !== challenge.phrase}
          onClick={() =>
            void ipc.addLink(spec, { confirm: true, typed }).then(
              (r) => onDone(r.ok, r.ok ? undefined : r.reason),
              (e: unknown) => onDone(false, e instanceof Error ? e.message : String(e)),
            )
          }
        >
          {t("security.links.confirm")}
        </button>
        {cancel}
      </div>
    </div>
  );
};

/** D-070: links are made here only (hand-off loosens policy); a cross-device link on both computers. */
export const Links = ({ ipc }: { ipc: AgentIpc }) => {
  const t = useT();
  const [v, setV] = useState<Load>({ state: "loading" });
  const reload = useCallback(() => {
    ipc.links().then(
      (value) => setV({ state: "ok", value }),
      (e: unknown) =>
        setV(e instanceof IpcUnavailableError ? { state: "unavailable" } : { state: "error", error: String(e) }),
    );
  }, [ipc]);
  useEffect(reload, [reload]);
  const [labels, setLabels] = useState<string[]>([]);
  useEffect(() => {
    ipc.workspaces().then(
      (w) => setLabels(w.workspaces.map((x) => x.label)),
      () => setLabels([]),
    );
  }, [ipc]);
  const [form, setForm] = useState<"new" | "paste" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [pasted, setPasted] = useState("");
  const [review, setReview] = useState<LinkSpec | null>(null);
  const [flow, setFlow] = useState<{ spec: LinkSpec; challenge: LinkChallenge; fromPaste: boolean } | null>(null);
  const [made, setMade] = useState<{ code: string | null } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, value: Draft[K]) => setDraft((d) => ({ ...d, [k]: value }));

  const start = (spec: LinkSpec, fromPaste: boolean) => {
    setFailure(null);
    void ipc.linkChallenge(spec.mode).then(
      (challenge) => setFlow({ spec, challenge, fromPaste }),
      (e: unknown) => setFailure(e instanceof Error ? e.message : String(e)),
    );
  };

  const self = v.state === "ok" ? v.value.self : null;
  const receiverHere = draft.other === "here" || draft.direction === "receive";

  return (
    <section aria-labelledby="sec-links" data-section="links">
      <h2 id="sec-links">{t("security.links.title")}</h2>
      <p className="muted">{t("security.links.intro")}</p>
      {v.state === "unavailable" && <p className="muted">{t("security.unavailable")}</p>}
      {v.state === "error" && <p role="alert">{v.error}</p>}
      {failure && <p role="alert">{t("security.links.failed", { reason: failure })}</p>}
      {v.state === "ok" && (
        <>
          {v.value.links.length === 0 ? (
            <p className="muted">{t("security.links.none")}</p>
          ) : (
            <ul className="list">
              {v.value.links.map((l) => (
                <li key={l.id} data-link={l.id} className="row">
                  <LinkFacts link={l} self={self?.deviceId ?? null} />
                  {v.value.pendingPublish.includes(l.id) && (
                    <em className="muted">{t("security.links.pendingPublish")}</em>
                  )}
                  <button onClick={() => void ipc.revokeLink(l.id).finally(reload)}>
                    {t("security.links.revoke")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {v.value.links.length > 0 && (
            <button onClick={() => void ipc.revokeAllLinks().finally(reload)}>{t("security.links.revokeAll")}</button>
          )}

          {made && (
            <div className="card" data-made="link">
              <p>{t("security.links.made")}</p>
              {made.code && (
                <>
                  <p>{t("security.links.madeOther")}</p>
                  <textarea readOnly aria-label={t("security.links.linkCode")} value={made.code} />
                </>
              )}
              <button onClick={() => setMade(null)}>{t("security.links.done")}</button>
            </div>
          )}

          {flow ? (
            <LinkFlow
              ipc={ipc}
              spec={flow.spec}
              challenge={flow.challenge}
              onDone={(ok, why) => {
                const crossDevice = flow.spec.sender.deviceId !== flow.spec.receiver.deviceId;
                setFlow(null);
                setFailure(why ?? null);
                if (ok) {
                  setForm(null);
                  setDraft(EMPTY);
                  setPasted("");
                  setReview(null);
                  setMade({ code: crossDevice && !flow.fromPaste ? linkCode(flow.spec) : null });
                }
                reload();
              }}
            />
          ) : form === "new" && self ? (
            <div className="card" data-form="new">
              <fieldset>
                <legend>{t("security.links.kind")}</legend>
                {(["handoff", "share"] as const).map((m) => (
                  <label key={m}>
                    <input type="radio" name="link-mode" checked={draft.mode === m} onChange={() => set("mode", m)} />{" "}
                    {t(`security.links.mode.${m}`)}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend>{t("security.links.where")}</legend>
                <label>
                  <input
                    type="radio"
                    name="link-other"
                    checked={draft.other === "here"}
                    onChange={() => set("other", "here")}
                  />{" "}
                  {t("security.links.here")}
                </label>
                <label>
                  <input
                    type="radio"
                    name="link-other"
                    checked={draft.other === "other"}
                    onChange={() => set("other", "other")}
                  />{" "}
                  {t("security.links.otherComputer")}
                </label>
              </fieldset>
              {draft.other === "other" && (
                <>
                  <label>
                    {t("security.links.otherCode")}
                    <textarea value={draft.otherCode} onChange={(e) => set("otherCode", e.target.value)} />
                  </label>
                  <fieldset>
                    <legend>{t("security.links.direction")}</legend>
                    {(["send", "receive"] as const).map((dir) => (
                      <label key={dir}>
                        <input
                          type="radio"
                          name="link-direction"
                          checked={draft.direction === dir}
                          onChange={() => set("direction", dir)}
                        />{" "}
                        {t(`security.links.${dir}`)}
                      </label>
                    ))}
                  </fieldset>
                </>
              )}
              <label>
                {t("security.links.workspace")}
                {receiverHere ? (
                  <select value={draft.workspaceLabel} onChange={(e) => set("workspaceLabel", e.target.value)}>
                    <option value="">—</option>
                    {labels.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input value={draft.workspaceLabel} onChange={(e) => set("workspaceLabel", e.target.value)} />
                )}
              </label>
              {receiverHere && labels.length === 0 && <p className="muted">{t("security.links.noWorkspaces")}</p>}
              <label>
                {t("security.links.goal")}
                <input maxLength={500} value={draft.goal} onChange={(e) => set("goal", e.target.value)} />
              </label>
              <label>
                {t("security.links.days")}
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={draft.days}
                  onChange={(e) => set("days", Number(e.target.value))}
                />
              </label>
              <label>
                {t("security.links.budget")}
                <input
                  type="number"
                  min={1}
                  max={LINK_MAX_DAILY_TOKENS}
                  value={draft.dailyTokenBudget}
                  onChange={(e) => set("dailyTokenBudget", Number(e.target.value))}
                />
              </label>
              <label>
                {t("security.links.rate")}
                <input
                  type="number"
                  min={1}
                  max={LINK_MAX_RATE_PER_HOUR}
                  value={draft.ratePerHour}
                  onChange={(e) => set("ratePerHour", Number(e.target.value))}
                />
              </label>
              {draft.mode === "handoff" && (
                <label>
                  {t("security.links.ceiling")}
                  <select
                    value={draft.permissionCeiling}
                    onChange={(e) => set("permissionCeiling", e.target.value as RemotePermissionMode)}
                  >
                    {CEILINGS.map((c) => (
                      <option key={c} value={c}>
                        {t(`security.links.ceilings.${c}`)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label>
                <input type="checkbox" checked={draft.confirm} onChange={(e) => set("confirm", e.target.checked)} />{" "}
                {t("security.links.askEachTime")}
              </label>
              <div className="row">
                <button
                  onClick={() => {
                    const r = toSpec(draft, self, Date.now());
                    if ("problem" in r) setFailure(t(`security.links.problems.${r.problem}`));
                    else start(r, false);
                  }}
                >
                  {t("security.devmode.continue")}
                </button>
                <button onClick={() => setForm(null)}>{t("security.devmode.cancel")}</button>
              </div>
            </div>
          ) : form === "paste" && self ? (
            <div className="card" data-form="paste">
              {review ? (
                <>
                  <p>{t("security.links.reviewPasted")}</p>
                  <LinkFacts link={review} self={self.deviceId} />
                  <div className="row">
                    <button onClick={() => start(review, true)}>{t("security.devmode.continue")}</button>
                    <button onClick={() => setReview(null)}>{t("security.devmode.cancel")}</button>
                  </div>
                </>
              ) : (
                <>
                  <label>
                    {t("security.links.linkCode")}
                    <textarea value={pasted} onChange={(e) => setPasted(e.target.value)} />
                  </label>
                  <div className="row">
                    <button
                      onClick={() => {
                        const spec = parseLinkCode(pasted, Date.now());
                        const ends = spec ? [spec.sender, spec.receiver] : [];
                        // This computer's end must carry its own keys, or the other computer's relays won't verify.
                        const mine = ends.find((e) => e.deviceId === self.deviceId);
                        if (!spec) setFailure(t("security.links.problems.badLinkCode"));
                        else if (!mine || mine.pubSign !== self.pubSign || mine.pubBox !== self.pubBox)
                          setFailure(t("security.links.problems.notForHere"));
                        else {
                          setFailure(null);
                          setReview(spec);
                        }
                      }}
                    >
                      {t("security.links.check")}
                    </button>
                    <button onClick={() => setForm(null)}>{t("security.devmode.cancel")}</button>
                  </div>
                </>
              )}
            </div>
          ) : (
            self && (
              <div className="row">
                <button onClick={() => setForm("new")}>{t("security.links.new")}</button>
                <button onClick={() => setForm("paste")}>{t("security.links.paste")}</button>
              </div>
            )
          )}

          {self && (
            <label className="muted">
              {t("security.links.thisCode")}
              <textarea readOnly aria-label={t("security.links.thisCode")} value={deviceCode(self)} />
            </label>
          )}
        </>
      )}
    </section>
  );
};
