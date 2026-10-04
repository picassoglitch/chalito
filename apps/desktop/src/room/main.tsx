import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { TextProviders, detectLocale } from "../lib/i18n.js";
import { roomWindowDeps, tauriRoomWindowIo, type RoomWindowDeps } from "../lib/room-window.js";
import { readEnv } from "../lib/session.js";
import { shell } from "../lib/shell.js";
import { RoomWindow } from "./RoomWindow.js";

/** The room window borrows the panel's device session; it retries while the panel signs in. */
const App = () => {
  const sh = useMemo(shell, []);
  const [deps, setDeps] = useState<RoomWindowDeps | null>(null);
  useEffect(() => {
    const env = readEnv();
    if (!env) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async () => {
      const d = await roomWindowDeps(await tauriRoomWindowIo(env)).catch(() => null);
      if (!alive) return;
      if (d) setDeps(d);
      else timer = setTimeout(() => void attempt(), 5_000);
    };
    void attempt();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  return <RoomWindow deps={deps} shell={sh} />;
};

const locale = detectLocale();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TextProviders locale={locale}>
      <App />
    </TextProviders>
  </StrictMode>,
);
