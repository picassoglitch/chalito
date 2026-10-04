"use client";
import { useCallback, useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import type { Connector } from "@/lib/mcp";
import { useChalito } from "./ChalitoProvider";

/** "Apps conectadas": the person's MCP grants, each revocable at once (the gateway checks every call). */
export const Connectors = () => {
  const t = useTranslations("mcp.connectors");
  const format = useFormatter();
  const { mcp, status } = useChalito();
  const [list, setList] = useState<Connector[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    if (!mcp) return;
    const r = await mcp.listConnectors();
    if (typeof r === "string") setFailed(true);
    else setList(r);
  }, [mcp]);
  useEffect(() => void load(), [load]);

  if (status === "signed_out") return <p>{t("signedOut")}</p>;
  if (failed)
    return (
      <p role="alert" className="text-red-900">
        {t("failed")}
      </p>
    );
  if (!list) return <p aria-live="polite">{t("loading")}</p>;
  const active = list.filter((c) => !c.revokedAt);
  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      {active.length === 0 ? <p>{t("empty")}</p> : null}
      <ul className="grid gap-3">
        {active.map((c) => (
          <li
            key={c.cid}
            data-testid="connector"
            data-cid={c.cid}
            className="grid gap-2 rounded-xl border bg-white p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{c.clientName}</span>
              <span className="text-sm text-neutral-600">{c.scopes.join(" · ")}</span>
            </div>
            <p className="text-sm text-neutral-600">
              {c.lastUsedAt ? t("lastUsed", { when: format.relativeTime(c.lastUsedAt) }) : t("neverUsed")}
            </p>
            {confirming === c.cid ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>{t("revokeConfirm", { name: c.clientName })}</span>
                <button
                  className="rounded bg-red-700 px-2 py-1 text-white"
                  onClick={() => void mcp?.revoke(c.cid).then(() => (setConfirming(null), load()))}
                >
                  {t("revokeYes")}
                </button>
                <button className="rounded border px-2 py-1" onClick={() => setConfirming(null)}>
                  {t("cancel")}
                </button>
              </div>
            ) : (
              <button className="w-fit rounded border px-2 py-1 text-sm" onClick={() => setConfirming(c.cid)}>
                {t("revoke")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};
