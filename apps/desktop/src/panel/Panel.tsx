import { useState } from "react";
import type { ChalitoClient } from "@chalito/client";
import type { PhoneVerifier, SettingsValues } from "@chalito/ui";
import { useT } from "../lib/i18n.js";
import type { AgentIpc } from "../lib/ipc.js";
import type { PushToTalk } from "../lib/voice.js";
import { Inbox } from "./Inbox.js";
import { Security } from "./Security.js";
import { Settings } from "./Settings.js";
import { Voice } from "./Voice.js";

const TABS = ["inbox", "settings", "security", "voice"] as const;
export type Tab = (typeof TABS)[number];

export interface PanelProps {
  client: Pick<ChalitoClient, "live" | "actions"> | null;
  ipc: AgentIpc;
  ptt: PushToTalk;
  settings: SettingsValues;
  onSettings: (v: SettingsValues) => void;
  dnd: boolean;
  onDnd: (on: boolean) => void;
  hubPlansUrl: string;
  phoneVerifier: PhoneVerifier;
  initialTab?: Tab;
}

export const Panel = (p: PanelProps) => {
  const t = useT();
  const [tab, setTab] = useState<Tab>(p.initialTab ?? "inbox");
  return (
    <div className="panel-shell">
      <header className="row">
        <nav role="tablist">
          {TABS.map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {t(`tabs.${k}`)}
            </button>
          ))}
        </nav>
        <label className="dnd">
          <input type="checkbox" checked={p.dnd} onChange={(e) => p.onDnd(e.target.checked)} /> {t("dnd")}
        </label>
      </header>
      <main role="tabpanel">
        {tab === "inbox" && (p.client ? <Inbox client={p.client} /> : <p className="muted">{t("offline")}</p>)}
        {tab === "settings" && (
          <Settings
            values={p.settings}
            onChange={p.onSettings}
            hubPlansUrl={p.hubPlansUrl}
            phoneVerifier={p.phoneVerifier}
          />
        )}
        {tab === "security" && <Security ipc={p.ipc} />}
        {tab === "voice" && <Voice ptt={p.ptt} />}
      </main>
    </div>
  );
};
