// Per-step accounting for a multi-prompt session. A session's transcript only grows, so one step is the difference
// between two readings of it. Pure: no I/O and no model calls.
import { mean } from './stats.mts'

export interface Reading { requests: Record<string, number>; usd: number; cacheRead: number; cacheWrite: number; output: number; peak: number }
export interface Step { models: string[]; requests: number; usd: number; cache_read: number; cache_write: number; output: number; rewrite_share: number | null }

export function stepBetween(before: Reading, after: Reading): Step {
  const added = Object.entries(after.requests).map(([m, n]) => [m, n - (before.requests[m] ?? 0)] as const).filter(([, n]) => n > 0)
  const cacheWrite = after.cacheWrite - before.cacheWrite
  return {
    models: added.map(([m]) => m).sort(), requests: added.reduce((a, [, n]) => a + n, 0), usd: after.usd - before.usd, cache_read: after.cacheRead - before.cacheRead,
    cache_write: cacheWrite, output: after.output - before.output,
    // How much of the context the session already held went back through a cache write. Near 1: the cache was lost.
    rewrite_share: before.peak > 0 ? Math.min(1, cacheWrite / before.peak) : null,
  }
}

export interface SessionRow { arm: string; accepted: boolean | null; steps: Step[] }

// followUpSummary covers what happens after the first prompt, which is the only part the arms do differently.
export function followUpSummary(rows: SessionRow[], arm: string) {
  const mine = rows.filter((r) => r.arm === arm && r.steps.length > 1)
  const after = (r: SessionRow) => r.steps.slice(1)
  const sum = (r: SessionRow, f: (s: Step) => number) => after(r).reduce((a, s) => a + f(s), 0)
  return {
    arm, sessions: mine.length, accepted: mine.filter((r) => r.accepted).length, total_usd: mean(mine.map((r) => r.steps.reduce((a, s) => a + s.usd, 0))),
    follow_up_usd: mean(mine.map((r) => sum(r, (s) => s.usd))), follow_up_cache_write: mean(mine.map((r) => sum(r, (s) => s.cache_write))),
    first_follow_up_rewrite: mean(mine.map((r) => r.steps[1].rewrite_share ?? 0)), models: [...new Set(mine.flatMap((r) => after(r).flatMap((s) => s.models)))].sort(),
  }
}
