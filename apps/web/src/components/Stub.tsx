import { getTranslations } from "next-intl/server";

/** Placeholder for deep-link screens that later milestones fill in. */
export const Stub = async ({ title }: { title: string }) => {
  const t = await getTranslations("deeplinks");
  return (
    <div className="grid gap-2">
      <h1 className="text-2xl font-bold">{title}</h1>
      <p>{t("stub")}</p>
    </div>
  );
};
