// Budget admission and quota pauses. Pure: the caller passes the numbers and the clock.
//
// A run is admitted only when the money already spent, plus what the runs in flight are expected to cost, plus this
// run's own expected cost, stays under the budget. The old check counted spent money only, so four parallel runs
// could start with $1 left. Expected cost comes from earlier rows of the same task and arm, then the arm, then the
// run cap. These are list-price estimates. They are not a billing hard stop, and they say nothing about the plan's
// 5-hour usage window, which `pausedFor` handles.

export interface CostHistory { task_id: string; arm: string; cost_usd_api_equiv?: number | null }

// expectedUsd: the mean of earlier rows for this task and arm, else this task on any arm, else the arm, else every
// row, else the run cap. The history is every saved results file, so a new experiment is not priced at its cap.
export function expectedUsd(history: CostHistory[], taskId: string, arm: string, runCap: number | null): number {
  const costs = (rows: CostHistory[]) => rows.map((r) => r.cost_usd_api_equiv).filter((x): x is number => typeof x === 'number' && x > 0)
  const tiers = [history.filter((r) => r.task_id === taskId && r.arm === arm), history.filter((r) => r.task_id === taskId), history.filter((r) => r.arm === arm), history]
  for (const t of tiers) { const c = costs(t); if (c.length) return Math.min(runCap ?? Infinity, c.reduce((a, b) => a + b, 0) / c.length) }
  return runCap ?? 1
}

// savedHistory reads every results file in a folder: the rows the estimate learns from.
export function savedHistory(dir: string, read: (f: string) => CostHistory[]): CostHistory[] {
  const fs = process.getBuiltinModule('node:fs') as typeof import('node:fs')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !/\.(grades|events)/.test(f) && f !== 'ledger.jsonl').flatMap((f) => read(`${dir}/${f}`))
}

export interface Admission { admit: boolean; warn: boolean; reason: string }

export function admit(x: { budget: number | null; spent: number; inFlight: number; next: number; warnAt?: number }): Admission {
  if (!x.budget) return { admit: true, warn: false, reason: 'no budget set' }
  const committed = x.spent + x.inFlight + x.next
  const warn = committed >= (x.warnAt ?? 0.8) * x.budget
  if (committed > x.budget) return { admit: false, warn: true, reason: `$${x.spent.toFixed(2)} spent + $${x.inFlight.toFixed(2)} in flight + $${x.next.toFixed(2)} next is over the $${x.budget} budget` }
  return { admit: true, warn, reason: `$${committed.toFixed(2)} of $${x.budget} committed` }
}

// resetAt reads a reset time the CLI stated in its limit message, as an ISO string. It returns null when there is none:
// the runner then stays paused and asks for a manual resume. It never guesses a time.
export function resetAt(message: string, now: Date): string | null {
  const iso = message.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z)\b/)
  if (iso) return new Date(iso[1]).toISOString()
  const epoch = message.match(/resets?(?:At| at)?[":\s]+(\d{10})\b/)
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString()
  const clock = message.match(/resets? (?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
  if (clock) {
    let h = Number(clock[1]) % 12
    if (/pm/i.test(clock[3])) h += 12
    const t = new Date(now)
    t.setHours(h, Number(clock[2] ?? 0), 0, 0)
    if (t <= now) t.setDate(t.getDate() + 1)
    return t.toISOString()
  }
  return null
}
