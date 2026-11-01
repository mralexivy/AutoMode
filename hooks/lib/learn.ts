// Route learning: AutoMode remembers, per project, where a cheaper model needed rescue. Pure: no `$`, no I/O.
//
// Contract: learning only ever raises a route. A bucket is a judged tier and the model the need named. A task counts as
// bad when it moved up to Opus after an escalation, or when the person corrected or retried it. A task counts as ok
// when a check passed with neither. Old evidence ages out, so a bucket gets another try on the cheaper model. The file
// holds labels, counts and times, and no prompt text.
import type { Family } from './types.ts'

export interface LearnedTask { id: string; bucket: string; family: Family; outcome: 'ok' | 'bad' | 'open'; at: number }
export interface Learned { v: 1; tasks: LearnedTask[] }

export const EMPTY_LEARNED: Learned = { v: 1, tasks: [] }
const KEEP = 200
const WINDOW_MS = 30 * 86_400_000
const MIN_BAD = 2
const BAD_SHARE = 0.4

export const bucketOf = (tier: string, need: string | null | undefined) => `${tier}/${need ?? 'none'}`

export function parseLearned(text: string): Learned {
  try {
    const j = JSON.parse(text) as Partial<Learned>
    if (j.v !== 1 || !Array.isArray(j.tasks)) return EMPTY_LEARNED
    return { v: 1, tasks: j.tasks.filter((t) => typeof t?.id === 'string' && typeof t?.bucket === 'string' && typeof t?.at === 'number' && ['ok', 'bad', 'open'].includes(t?.outcome) && ['haiku', 'sonnet', 'opus'].includes(t?.family)).slice(-KEEP) }
  } catch {
    return EMPTY_LEARNED
  }
}

// noteTask keeps the family the task started on, and a bad outcome stands. The same task can be noted on every turn.
export function noteTask(l: Learned, t: LearnedTask): Learned {
  const old = l.tasks.find((x) => x.id === t.id)
  const merged: LearnedTask = old ? { ...t, family: old.family, outcome: old.outcome === 'bad' ? 'bad' : t.outcome === 'open' ? old.outcome : t.outcome } : t
  return { v: 1, tasks: [...l.tasks.filter((x) => x.id !== t.id), merged].slice(-KEEP) }
}

export function opusFirst(l: Learned, bucket: string, now: number): boolean {
  const seen = l.tasks.filter((t) => t.bucket === bucket && t.family !== 'opus' && t.outcome !== 'open' && now - t.at <= WINDOW_MS)
  const bad = seen.filter((t) => t.outcome === 'bad').length
  return bad >= MIN_BAD && bad / seen.length >= BAD_SHARE
}

export const opusBuckets = (l: Learned, now: number) => [...new Set(l.tasks.map((t) => t.bucket))].filter((b) => opusFirst(l, b, now))
