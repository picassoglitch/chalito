import { useMemo } from "react";
import { useT } from "../../lib/i18n.js";
import { foundIpc, type FoundIpc } from "../../lib/connections-found-ipc.js";
import type { AgentIpc } from "../../lib/ipc.js";
import { FoundSection } from "./FoundSection.js";
import { SearchSection } from "./SearchSection.js";
import { TeamSection } from "./TeamSection.js";

/** Conexiones: what's on this PC, the AI team's trust, then what can be added. Each section owns its own file. */
export const ConnectionsScreen = ({ found, ipc: agent }: { found?: FoundIpc; ipc?: AgentIpc }) => {
  const t = useT();
  const ipc = useMemo(() => found ?? foundIpc(), [found]);
  return (
    <>
      <p className="muted">{t("connections.intro")}</p>
      <FoundSection ipc={ipc} />
      {agent && <TeamSection ipc={agent} />}
      <SearchSection />
    </>
  );
};
