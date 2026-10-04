import type { MesaDoc } from "./mesa.js";

/**
 * Runaway-loop guard (brief §5 M9): per-Mesa and per-participant managed token caps. A call is
 * allowed only if its estimate still fits; otherwise the Mesa stops gracefully.
 */
export type BudgetCheck = { ok: true } | { ok: false; scope: "mesa" | "participant" };

export const checkBudget = (doc: MesaDoc, pid: string, estimate: number): BudgetCheck => {
  if (doc.budget.mesaTokens !== null && doc.used.total + estimate > doc.budget.mesaTokens)
    return { ok: false, scope: "mesa" };
  const used = doc.used.byParticipant[pid] ?? 0;
  if (doc.budget.perParticipant !== null && used + estimate > doc.budget.perParticipant)
    return { ok: false, scope: "participant" };
  return { ok: true };
};
