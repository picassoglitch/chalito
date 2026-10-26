"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { ApprovalCard } from "./Approvals";
import { useLive, useNow } from "./ChalitoProvider";

/** Where the approvals already show (internal pathnames): no pop-up on top of them. */
const SHOWS_APPROVALS = /^\/(bandeja|a)(\/|$)/;

// ADR 0032 — a waiting approval pops up pinned on top of any screen, without locking the page.
// "Más tarde" only hides it for this page load; it stays in the inbox.
export const ApprovalPopup = () => {
  const { approvals } = useLive();
  const path = usePathname();
  // No per-second timer on every page unless something is actually waiting.
  if (SHOWS_APPROVALS.test(path) || !approvals.some((a) => a.status === "pending")) return null;
  return <Pending approvals={approvals} />;
};

const Pending = ({ approvals }: { approvals: ReturnType<typeof useLive>["approvals"] }) => {
  const t = useTranslations("live.popup");
  const now = useNow(1000);
  const [later, setLater] = useState<ReadonlySet<string>>(new Set());
  const waiting = approvals.filter((a) => a.status === "pending" && a.expiresAt > now && !later.has(a.aid));
  const a = waiting[0];
  if (!a) return null;
  return (
    <section
      role="region"
      aria-labelledby="approval-popup-title"
      data-testid="approval-popup"
      data-aid={a.aid}
      className="sticky top-0 z-30 mx-auto max-w-3xl px-4 pt-3"
    >
      <div className="grid max-h-[70vh] gap-3 overflow-y-auto rounded-xl border-2 border-amber-500 bg-neutral-50 p-4 shadow-xl">
        <h2 id="approval-popup-title" className="text-lg font-semibold">
          {t("title", { count: waiting.length })}
        </h2>
        {/* Keyed: one approval's note or expanded input must never carry over to the next. */}
        <ApprovalCard key={a.aid} a={a} />
        <div className="flex justify-end gap-2">
          {waiting.length > 1 ? (
            <Link href="/bandeja" className="rounded-lg border px-4 py-2">
              {t("all")}
            </Link>
          ) : null}
          <button
            data-testid="approval-popup-later"
            className="rounded-lg border px-4 py-2"
            onClick={() => setLater((s) => new Set(s).add(a.aid))}
          >
            {t("later")}
          </button>
        </div>
      </div>
    </section>
  );
};
