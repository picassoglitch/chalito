"use client";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { BrainKeysPanel, type BrainProvider } from "@chalito/ui";
import { clientBoxKeys, readBrainKeys, sealBrainKey, type BrainKeyRow } from "@chalito/client";
import { useChalito } from "./ChalitoProvider";

/**
 * Ajustes → "Tus claves": BYO provider keys for Mesa brains. The key is sealed to the person's
 * client devices (AAD brainkey:<owner>:<provider>); only with the cloud opt-in is it also sent
 * once in plaintext, for the orchestrator to wrap with KMS. Paired devices only.
 */
export const BrainKeys = () => {
  const t = useTranslations("settings.mesa.keys");
  const ti = useTranslations("integrations");
  const { mesa } = useChalito();
  const [rows, setRows] = useState<BrainKeyRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!mesa) return;
    setRows(await readBrainKeys(mesa.db).catch(() => []));
  }, [mesa]);
  useEffect(() => void load(), [load]);

  if (!mesa) return null;

  const save = async (provider: BrainProvider, key: string, cloud: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      const recipients = await clientBoxKeys(mesa.db, mesa.owner);
      if (!Object.keys(recipients).length) {
        setNote(t("noDevices"));
        return false;
      }
      const sealedCt = await sealBrainKey(mesa.keys, recipients, mesa.owner, provider, key);
      const r = await mesa.api.putBrainKey(
        provider,
        cloud ? { sealedCt, cloud, key } : { sealedCt, cloud, hint: key.slice(-4) },
      );
      setNote(r === "ok" ? t("saved") : t("error"));
      if (r === "ok") await load();
      return r === "ok";
    } catch {
      setNote(t("error"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const remove = async (provider: BrainProvider) => {
    setBusy(true);
    const r = await mesa.api.deleteBrainKey(provider);
    setNote(r === "error" ? t("error") : t("removed"));
    await load();
    setBusy(false);
  };

  return (
    <BrainKeysPanel
      rows={rows}
      providerLabel={(p) => ti(`${p}.name`)}
      busy={busy}
      note={note}
      onSave={save}
      onDelete={(p) => void remove(p)}
    />
  );
};
