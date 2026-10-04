import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TextProviders, detectLocale, useT } from "../lib/i18n.js";

/** Placeholder for the M11 room scene. */
const Room = () => {
  const t = useT();
  return <p className="muted room-soon">{t("room.soon")}</p>;
};

const locale = detectLocale();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TextProviders locale={locale}>
      <Room />
    </TextProviders>
  </StrictMode>,
);
