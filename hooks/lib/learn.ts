// Route learning: AutoMode remembers, per project, where a cheaper model needed rescue. Pure: no `$`, no I/O.
//
// Contract: learning only ever raises a route. A bucket is a judged tier and the model the need named. A task counts as
// bad when it moved up to Opus after an escalation, or when the person corrected or retried it. A task counts as ok
// when a check passed with neither. Old evidence ages out, so a bucket gets another try on the cheaper model. The file
// holds labels, counts and times, and no prompt text.
import type { Family } from './types.ts'

// arm says how the memory treated the task: `memory` followed it, `control` ignored it. `flipped` says the task's bucket was already
// one the memory starts on Opus. `pinned` marks a model the person chose, which no memory decided. `usd` is what the task cost.
export interface LearnedTask { id: string; bucket: string; family: Family; outcome: 'ok' | 'bad' | 'open'; at: number; arm?: 'memory' | 'control'; flipped?: boolean; pinned?: boolean; usd?: number; esc?: boolean; exp?: { k: 'haiku' | 'effort'; a: 'hold' | 'probe'; b: string }; cause?: Cause; kind?: Kind }
// Why a task's checks failed, from the envelope's failure records: a defect in the work, the environment (a missing tool, a broken setup), or a
// flaky test. Only a defect, or a correction by the person, says anything about whether a cheaper model was enough.
export type Cause = 'defect' | 'environment' | 'flaky' | 'unknown'
// What the task changed, from the paths it edited: documentation, tests, configuration, other code, or nothing.
export type Kind = 'docs' | 'tests' | 'config' | 'code' | 'none'
export const CAUSES: Cause[] = ['defect', 'environment', 'flaky', 'unknown']
export const KINDS: Kind[] = ['docs', 'tests', 'config', 'code', 'none']

export function causeOf(failures: { class: string }[]): Cause | undefined {
  if (!failures.length) return undefined
  if (failures.some((f) => f.class === 'defect')) return 'defect'
  if (failures.some((f) => f.class === 'flaky')) return 'flaky'
  if (failures.some((f) => f.class === 'environment')) return 'environment'
  return 'unknown'
}
export function kindOf(paths: string[]): Kind {
  if (!paths.length) return 'none'
  const is = (re: RegExp) => paths.every((p) => re.test(p))
  if (is(/\.(md|mdx|rst|txt)$/i)) return 'docs'
  if (is(/(^|[\\/])(tests?|__tests__|spec)[\\/]|[._-](test|spec)\.[a-z]+$|^test_/i)) return 'tests'
  if (is(/\.(json|ya?ml|toml|ini|cfg|env|lock)$/i)) return 'config'
  return 'code'
}
export interface Learned { v: 1; tasks: LearnedTask[] }

export const EMPTY_LEARNED: Learned = { v: 1, tasks: [] }
const KEEP = 400
const WINDOW_MS = 30 * 86_400_000
const MIN_BAD = 2
const BAD_SHARE = 0.4

export const bucketOf = (tier: string, need: string | null | undefined) => `${tier}/${need ?? 'none'}`

export function parseLearned(text: string): Learned {
  try {
    const j = JSON.parse(text) as Partial<Learned>
    if (j.v !== 1 || !Array.isArray(j.tasks)) return EMPTY_LEARNED
    return { v: 1, tasks: j.tasks.filter((t) => typeof t?.id === 'string' && typeof t?.bucket === 'string' && typeof t?.at === 'number' && ['ok', 'bad', 'open'].includes(t?.outcome) && ['haiku', 'sonnet', 'opus'].includes(t?.family)).map((t) => ({ id: t.id, bucket: t.bucket, family: t.family, outcome: t.outcome, at: t.at, ...(t.arm === 'memory' || t.arm === 'control' ? { arm: t.arm } : {}), ...(t.flipped === true ? { flipped: true } : {}), ...(t.pinned === true ? { pinned: true } : {}), ...(typeof t.usd === 'number' && t.usd >= 0 ? { usd: t.usd } : {}), ...(t.esc === true ? { esc: true } : {}), ...(CAUSES.includes(t.cause as Cause) ? { cause: t.cause } : {}), ...(KINDS.includes(t.kind as Kind) ? { kind: t.kind } : {}), ...(t.exp && (t.exp.k === 'haiku' || t.exp.k === 'effort') && (t.exp.a === 'hold' || t.exp.a === 'probe') && typeof t.exp.b === 'string' ? { exp: { k: t.exp.k, a: t.exp.a, b: t.exp.b } } : {}) })).slice(-KEEP) }
  } catch {
    return EMPTY_LEARNED
  }
}

// noteTask keeps the family the task started on, and a bad outcome stands. The same task can be noted on every turn.
export function noteTask(l: Learned, t: LearnedTask): Learned {
  const old = l.tasks.find((x) => x.id === t.id)
  const merged: LearnedTask = old ? { ...t, arm: old.arm ?? t.arm, flipped: old.flipped ?? t.flipped, exp: old.exp ?? t.exp, esc: old.esc || t.esc, cause: old.cause ?? t.cause, kind: t.kind ?? old.kind, family: old.family, outcome: old.outcome === 'bad' ? 'bad' : t.outcome === 'open' ? old.outcome : t.outcome } : t
  return { v: 1, tasks: [...l.tasks.filter((x) => x.id !== t.id), merged].slice(-KEEP) }
}

export function opusFirst(l: Learned, bucket: string, now: number): boolean {
  const seen = l.tasks.filter((t) => t.bucket === bucket && t.family !== 'opus' && t.outcome !== 'open' && now - t.at <= WINDOW_MS)
  const bad = seen.filter((t) => t.outcome === 'bad').length
  return bad >= MIN_BAD && bad / seen.length >= BAD_SHARE
}

export const opusBuckets = (l: Learned, now: number) => [...new Set(l.tasks.map((t) => t.bucket))].filter((b) => opusFirst(l, b, now))

// A control group keeps the memory honest. One task in ten ignores what was learned and routes as the shipped rules would, so the
// memory's effect can be read off real tasks instead of assumed. The choice is a fixed function of the task id, so a reload keeps it.
export const CONTROL_SHARE = 10
export function inControl(taskId: string): boolean {
  let h = 2166136261
  for (let i = 0; i < taskId.length; i++) { h ^= taskId.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h % CONTROL_SHARE === 0
}

// Lift: for each bucket the memory now starts on Opus, the tasks that followed the memory against the control tasks that ignored it.
// Only tasks whose bucket was already flipped when they were routed count, and a model the person pinned counts for neither arm,
// so the two arms differ in the memory alone. Both are counts of bad outcomes; `usd` adds what each arm cost.
export interface Arm { n: number; bad: number; usd: number }
export interface Lift { bucket: string; memory: Arm; control: Arm }
export const MIN_ARM = 20 // below this many tasks in each arm no comparison is shown
export function liftOf(l: Learned, now: number): Lift[] {
  return opusBuckets(l, now).map((bucket) => {
    const done = l.tasks.filter((t) => t.bucket === bucket && t.flipped && !t.pinned && t.outcome !== 'open' && now - t.at <= WINDOW_MS)
    const arm = (xs: LearnedTask[]): Arm => ({ n: xs.length, bad: xs.filter((t) => t.outcome === 'bad').length, usd: xs.reduce((a, t) => a + (t.usd ?? 0), 0) })
    return { bucket, memory: arm(done.filter((t) => t.arm === 'memory')), control: arm(done.filter((t) => t.arm === 'control')) }
  })
}

// wilson: a 95% interval for a share, which stays honest at small n.
export function wilson(bad: number, n: number): [number, number] {
  if (n === 0) return [0, 1]
  const z = 1.96, p = bad / n, d = 1 + (z * z) / n
  const c = (p + (z * z) / (2 * n)) / d, m = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return [Math.max(0, c - m), Math.min(1, c + m)]
}

// startReport: what the person's own tasks say about the model each task started on, by tier. It is a report and not a test: the
// router chose each start from the task, so a cheaper start may have met easier tasks. Only the control group and a randomized probe
// (not built yet) could separate the model from the task. `open` tasks ran no check, so their quality is unknown.
export interface StartRow { tier: string; family: Family; n: number; ok: number; bad: number; open: number; usd: number }
export function startReport(l: Learned, now: number): StartRow[] {
  const g = new Map<string, StartRow>()
  for (const t of l.tasks) {
    if (now - t.at > WINDOW_MS || t.pinned) continue
    const tier = t.bucket.split('/')[0]
    const k = `${tier}|${t.family}`
    const r = g.get(k) ?? { tier, family: t.family, n: 0, ok: 0, bad: 0, open: 0, usd: 0 }
    r.n += 1; r[t.outcome] += 1; r.usd += t.usd ?? 0
    g.set(k, r)
  }
  return [...g.values()].sort((a, b) => a.tier.localeCompare(b.tier) || a.family.localeCompare(b.family))
}
