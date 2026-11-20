// Adaptive routing: rules the mod learns from one person's own tasks, in place of fixed ones. Pure: no `$`, no I/O.
//
// The shipped rules are a starting belief, not a verdict. For each kind of task (tier and complexity) the mod asks, on this person's work,
// whether a cheaper start would have done as well: a Haiku start where the shipped rules start higher, or Sonnet at one effort lower. It
// finds out the only honest way, by trying. A fraction of the eligible tasks, picked by a fixed hash of the task id, start the cheaper
// way (the probe); the rest follow the shipped rules (the hold). Because the hash does not look at the task, the two groups are alike
// except for the start, and their realized cost (every attempt, judge and rescue included) and their failures can be compared fairly.
//
//   collecting  a probe runs on a share of eligible tasks, the rest hold
//   adopted     the probe is cheaper with confidence and no worse on failures: it becomes the start, and a tenth still hold so the
//               comparison goes on
//   reverted    the probe turned out worse: the shipped start returns for REVERT_MS, then the experiment starts over
//
// The arm is the assignment, whether or not the router could follow it (the cache policy can still hold a running model), so what the
// comparison measures is what the router really does when it is told to start cheaper.
//
// Every state is computed from the recorded tasks, in time order, so it needs no stored flag and it corrects itself as tasks arrive.
// A probe never runs on critical or elevated risk, a pinned or commanded model, a task whose failures nobody would see (no checks run in
// this kind of task), or before the kind of task has WARMUP checked tasks. A failed probe is caught by the escalation ladder, and its
// whole cost counts against the probe.
import type { Learned, LearnedTask } from './learn.ts'

export type ExpKey = 'haiku' | 'effort'
export type ExpArm = 'hold' | 'probe'
export type ExpState = 'warming' | 'blind' | 'collecting' | 'adopted' | 'reverted'

export const PROBE_SHARE = 0.15 // while collecting
export const PROMISING_SHARE = 0.4 // while collecting, once the probe looks cheaper and no worse: resolve it sooner
export const FOCUS_SHARE = 0.3 // while collecting, for a kind of task the learning pass put in focus
export const HOLD_SHARE = 0.1 // after adopting: tasks that still follow the shipped rules
export const WARMUP = 8 // checked tasks of this kind before any probe
export const CHECK_RATE = 0.5 // below this share with a check, a failure would go unseen
export const MIN_ARM_N = 12 // tasks in each arm before a decision
export const REVERT_MS = 14 * 86_400_000
const WINDOW_MS = 60 * 86_400_000
const SLACK_FAIL = 0.05 // a probe may fail this much more often and still count as no worse
const BAD_FAIL = 0.1 // and this much more means it is worse
export const MIN_SAVING = 0.15 // a probe must be at least this much cheaper per task to be worth a change: equal means are noise

export const bucketOf = (tier: string, complexity: string | undefined) => `${tier}/${complexity ?? 'standard'}`

// A string as a share between 0 and 1: fnv1a, then a final mix so that ids that differ in their last characters spread evenly.
export function share(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16
  return (h >>> 0) / 2 ** 32
}

const Phi = (z: number) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989423 * Math.exp((-z * z) / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return z > 0 ? 1 - p : p
}

export interface ArmStats { n: number; checked: number; failed: number; usd: number; usd2: number }
const empty = (): ArmStats => ({ n: 0, checked: 0, failed: 0, usd: 0, usd2: 0 })
export const failed = (t: LearnedTask) => t.outcome === 'bad' || t.esc === true

function add(a: ArmStats, t: LearnedTask): ArmStats {
  const u = t.usd ?? 0
  return { n: a.n + 1, checked: a.checked + (t.outcome === 'open' && !t.esc ? 0 : 1), failed: a.failed + (failed(t) ? 1 : 0), usd: a.usd + u, usd2: a.usd2 + u * u }
}
export const meanUsd = (a: ArmStats) => (a.n ? a.usd / a.n : 0)
const sdUsd = (a: ArmStats) => (a.n > 1 ? Math.sqrt(Math.max(0, (a.usd2 - (a.usd * a.usd) / a.n) / (a.n - 1))) : 0)

// pCheaper: the chance the probe's mean cost per task is below the hold's, by a normal approximation on the two means.
export function pCheaper(p: ArmStats, h: ArmStats): number {
  if (p.n < 2 || h.n < 2) return 0.5
  const se = Math.sqrt(sdUsd(p) ** 2 / p.n + sdUsd(h) ** 2 / h.n) || 1e-9
  return Phi((meanUsd(h) - meanUsd(p)) / se)
}
// What the committed benchmarks say before this person's tasks do, as a Beta(failures + 1, passes + 1) prior for the probe: Haiku missed
// about 8% of T2 and T3 tasks (66 of 72 passed on T3), and Sonnet at medium missed none of 36 that Sonnet at high also passed. The prior is
// worth about a dozen tasks, so a person's own tasks overtake it within a few weeks, and it is what lets a clearly good probe be adopted
// after eight tasks instead of fifty. The hold's prior is the shipped rules' own record, about 10%.
export const PROBE_PRIOR: Record<ExpKey, [number, number]> = { haiku: [1, 11], effort: [1, 19] }
const HOLD_PRIOR: [number, number] = [1, 9]
// pFailMore: the chance the probe's failure rate exceeds the hold's by more than `slack`, from the two Beta posteriors.
export function pFailMore(p: ArmStats, h: ArmStats, slack: number, pp: [number, number] = [1, 1], hp: [number, number] = [1, 1]): number {
  const post = (a: ArmStats, pr: [number, number]) => { const x = pr[0] + a.failed, y = pr[1] + (a.checked - a.failed); return { m: x / (x + y), v: (x * y) / ((x + y) ** 2 * (x + y + 1)) } }
  const a = post(p, pp), b = post(h, hp)
  return 1 - Phi((slack - (a.m - b.m)) / Math.sqrt(a.v + b.v))
}

export interface Status { key: ExpKey; bucket: string; state: ExpState; probe: ArmStats; hold: ArmStats; why: string; since: number }

// Tasks of this kind, oldest first, that ran in the experiment.
const tasksOf = (l: Learned, key: ExpKey, bucket: string, now: number) => l.tasks.filter((t) => t.exp && t.exp.k === key && t.exp.b === bucket && now - t.at <= WINDOW_MS).sort((a, b) => a.at - b.at)

// statusOf runs the state machine over the tasks in time order.
export function statusOf(l: Learned, key: ExpKey, bucket: string, now: number): Status {
  const all = tasksOf(l, key, bucket, now)
  let probe = empty(), hold = empty(), state: ExpState = 'collecting', since = 0, why = 'collecting'
  for (const t of all) {
    if (state === 'reverted' && t.at - since < REVERT_MS) continue // the shipped start holds for a while
    if (state === 'reverted') { probe = empty(); hold = empty(); state = 'collecting' }
    if (t.exp!.a === 'probe') probe = add(probe, t); else hold = add(hold, t)
    const worse = pFailMore(probe, hold, BAD_FAIL, PROBE_PRIOR[key], HOLD_PRIOR)
    if (probe.n >= 6 && hold.n >= 3 && (worse >= 0.7 || (probe.n >= MIN_ARM_N && hold.n >= MIN_ARM_N && pCheaper(probe, hold) < 0.3))) {
      state = 'reverted'; since = t.at; why = worse >= 0.7 ? 'the cheaper start failed clearly more often' : 'the cheaper start cost more'
    } else if (state === 'collecting' && probe.n >= MIN_ARM_N && hold.n >= MIN_ARM_N && meanUsd(probe) <= (1 - MIN_SAVING) * meanUsd(hold) && pCheaper(probe, hold) >= 0.95 && pFailMore(probe, hold, SLACK_FAIL, PROBE_PRIOR[key], HOLD_PRIOR) < 0.25) {
      state = 'adopted'; since = t.at; why = 'cheaper with confidence and no worse on failures'
    }
  }
  if (state === 'reverted' && now - since >= REVERT_MS) { state = 'collecting'; probe = empty(); hold = empty(); why = 'trying again' }
  return { key, bucket, state, probe, hold, why, since }
}

// readiness: whether this kind of task has enough checked history for a probe, and whether its failures would be seen.
export function readiness(l: Learned, bucket: string, now: number): { ok: boolean; why: ExpState | null; checked: number; total: number } {
  const ts = l.tasks.filter((t) => t.bucket.startsWith(bucket.split('/')[0] + '/') && !t.pinned && now - t.at <= WINDOW_MS)
  const checked = ts.filter((t) => t.outcome !== 'open' || t.esc).length
  if (ts.length < WARMUP) return { ok: false, why: 'warming', checked, total: ts.length }
  if (checked / ts.length < CHECK_RATE) return { ok: false, why: 'blind', checked, total: ts.length }
  return { ok: true, why: null, checked, total: ts.length }
}

export interface Guard { allowed: boolean } // everything the router knows that rules a probe out, decided by the caller
export interface Assignment { arm: ExpArm; adopted: boolean; state: ExpState }

// assign picks the arm for one task. `eligible` is the caller's safety check (risk, pins, commands, tier). It returns null when the
// task is outside the experiment, which is the shipped rule and not recorded as a hold.
export function assign(l: Learned, key: ExpKey, bucket: string, taskId: string, now: number, eligible: boolean, focus = false): Assignment | null {
  if (!eligible) return null
  const r = readiness(l, bucket, now)
  if (!r.ok) return null
  const st = statusOf(l, key, bucket, now)
  if (st.state === 'reverted') return null
  const u = share(`${key}|${taskId}`)
  if (st.state === 'adopted') return { arm: u < HOLD_SHARE ? 'hold' : 'probe', adopted: true, state: 'adopted' }
  // A probe that already looks cheaper, with failures not worse so far, gets more of the tasks, so it is settled sooner. A failed probe is
  // caught by the ladder and its cost counts against it, so this cannot run far ahead of the evidence.
  const promising = st.probe.n >= 3 && st.hold.n >= 3 && pCheaper(st.probe, st.hold) >= 0.9 && pFailMore(st.probe, st.hold, BAD_FAIL, PROBE_PRIOR[key], HOLD_PRIOR) < 0.5
  // A kind of task the learning pass put in focus is tried sooner: a larger probe share, never a safety rule changed.
  const probeShare = promising ? (focus ? 0.5 : PROMISING_SHARE) : focus ? FOCUS_SHARE : PROBE_SHARE
  return { arm: u < probeShare ? 'probe' : 'hold', adopted: false, state: 'collecting' }
}

// report: one row per experiment and kind of task that has any tasks.
export function reportOf(l: Learned, now: number): Status[] {
  const seen = new Set<string>()
  for (const t of l.tasks) if (t.exp) seen.add(`${t.exp.k}|${t.exp.b}`)
  return [...seen].map((k) => { const [key, bucket] = k.split('|'); return statusOf(l, key as ExpKey, bucket, now) }).sort((a, b) => a.bucket.localeCompare(b.bucket) || a.key.localeCompare(b.key))
}

// pickKey chooses which experiment a task joins when two fit it. An adopted one takes every such task (so a found saving is not split in
// half with a trial); otherwise the task id decides, evenly.
export function pickKey(l: Learned, bucket: string, fits: ExpKey[], taskId: string, now: number): ExpKey | null {
  if (!fits.length) return null
  const adopted = fits.find((k) => statusOf(l, k, bucket, now).state === 'adopted')
  if (adopted) return adopted
  return fits[Math.floor(share(`k|${taskId}`) * fits.length)]
}
