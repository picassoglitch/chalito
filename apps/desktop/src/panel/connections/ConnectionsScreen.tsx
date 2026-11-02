import { useMemo } from "react";
import { useT } from "../../lib/i18n.js";
import { foundIpc, type FoundIpc } from "../../lib/connections-found-ipc.js";
import { FoundSection } from "./FoundSection.js";
import { SearchSection } from "./SearchSection.js";

/** Conexiones: what's on this PC, then what can be added. Each section owns its own file. */
export const ConnectionsScreen = ({ found }: { found?: FoundIpc }) => {
  const t = useT();
  const ipc = useMemo(() => found ?? foundIpc(), [found]);
  return (
    <>
      <p className="muted">{t("connections.intro")}</p>
      <FoundSection ipc={ipc} />
      <SearchSection />
    </>
  );
};
