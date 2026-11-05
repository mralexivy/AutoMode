// Task budget: what one task has spent and whether it may spend more. Pure: no `$` and no I/O.
//
// The spend is every paid request of the task: the main session, its subagents, forks and consults (one `request`
// record each), and the judges (`model-call` records). A turn's `outcome` record repeats its requests' cost, so it is
// never counted. A budget of 0 is off. A spent budget ends the task as `budget_exhausted`, never as done: the work
// may be unfinished, and the person has to know.

export type BudgetState = 'off' | 'ok' | 'low' | 'exhausted'

// recordUsd: the list-price cost one record carries, or 0.
export function recordUsd(r: unknown): number {
  const x = r as { kind?: string; usd?: unknown } | null
  if (!x || (x.kind !== 'request' && x.kind !== 'model-call')) return 0
  const u = x.usd as { value?: unknown } | number | null | undefined
  return typeof u === 'number' ? u : typeof u?.value === 'number' ? u.value : 0
}

// budgetState: `low` from 80% of the budget, so the note can come before the last request, not after it.
export function budgetState(spentUsd: number, budgetUsd: number): BudgetState {
  if (!(budgetUsd > 0)) return 'off'
  if (spentUsd >= budgetUsd) return 'exhausted'
  return spentUsd >= budgetUsd * 0.8 ? 'low' : 'ok'
}

export const budgetNote = (spentUsd: number, budgetUsd: number) =>
  `[AutoMode: this task has spent $${spentUsd.toFixed(2)} of its $${budgetUsd.toFixed(2)} budget. Stop here. Report what is done, what is not, and the last check's result. Do not start new work on this task.]`
