// The rescue ladder's bookkeeping and prices, policy auto. Pure: no $ and no I/O.
//
// An episode is one failure the ladder works on. It opens on the first escalation for its base and closes when its
// evidence clears: a check episode when that check passes, a reviewer episode when the reviewer approves. A failure that
// comes back after a close opens a new episode, so one raise or one consult is spent per episode, not per cause.
//
// priceConsult compares the two ways to get Opus reasoning on a repeated failure. Every input it cannot measure is a
// prior, and each prior below says so. Cost decides only between paths of equal quality: the quality rules run first.
//
// consultOutcome and influence turn what happened after a consult into one outcome. A missing repeat is not a fix:
// only an independent check makes an outcome `verified_resolved`.
import type { Escalation } from './failures.ts'
import type { PriceRow } from './prices.ts'
import { cacheWriteX, rateAt } from './prices.ts'
import type { CacheState, Episode, Family, LadderState } from './types.ts'

const M = 1e6

// ---------------------------------------------------------------- episodes

export type { Episode }
export type Episodes = Record<string, Episode>

// episodeBase: a check names its failure, a revert its count, the rest their cause.
export function episodeBase(esc: Escalation, l: LadderState): string {
  if (esc.fingerprint) return `check:${esc.fingerprint}`
  if (esc.cause === 'revert') return `revert:${l.reverts}`
  return esc.cause
}

// openEpisode returns the open episode for this base, or opens the next one.
export function openEpisode(eps: Episodes, base: string, at: number): { id: string; episodes: Episodes } {
  const own = Object.entries(eps).filter(([, e]) => e.base === base)
  const open = own.find(([, e]) => e.closedAt === undefined)
  if (open) return { id: open[0], episodes: eps }
  const id = `${base}#${own.length}`
  return { id, episodes: { ...eps, [id]: { base, raised: 0, consulted: false, switched: false, openedAt: at } } }
}

// closeEpisodes closes the open episodes the predicate picks and returns their ids.
export function closeEpisodes(eps: Episodes, pick: (e: Episode) => boolean, at: number): { closed: string[]; episodes: Episodes } {
  const closed = Object.entries(eps).filter(([, e]) => e.closedAt === undefined && pick(e)).map(([id]) => id)
  if (!closed.length) return { closed, episodes: eps }
  return { closed, episodes: { ...eps, ...Object.fromEntries(closed.map((id) => [id, { ...eps[id], closedAt: at }])) } }
}

export const patchEpisode = (eps: Episodes, id: string, patch: Partial<Episode>): Episodes => ({ ...eps, [id]: { ...eps[id], ...patch } })

// effortFirst: strong evidence takes the effort rung once per episode, unless a deterministic floor says the model must
// move. Critical consequence work never trades a model step for effort.
export function effortFirst(x: { enabled: boolean; level: string; episode: Episode; critical: boolean; floorBand?: number; modelBand?: number }): { use: boolean; why: string } {
  if (!x.enabled || x.level !== 'strong') return { use: false, why: '' }
  if (x.critical) return { use: false, why: 'critical consequence: the model moves' }
  if (x.floorBand !== undefined && x.modelBand !== undefined && x.floorBand >= x.modelBand) return { use: false, why: 'a floor already asks for the stronger model' }
  if (x.episode.raised >= 1) return { use: false, why: 'effort was already raised in this episode' }
  return { use: true, why: 'strong evidence: effort first, the cache stays' }
}

// ---------------------------------------------------------------- cache state for records

export interface CacheNote { prefixTokens: number; sinceRefreshMs: number | null; ttlMs: number; warm: boolean; remainingMs: number }
export function cacheNote(c: CacheState, at: number): CacheNote {
  const since = c.lastRequestAt === null ? null : Math.max(0, at - c.lastRequestAt)
  const warm = since !== null && c.prefixTokens > 0 && since <= c.ttlMs
  return { prefixTokens: c.prefixTokens, sinceRefreshMs: since, ttlMs: c.ttlMs, warm, remainingMs: warm ? c.ttlMs - since! : 0 }
}

// ---------------------------------------------------------------- the consult price

// PRIOR: how long an architect consult runs, in ms. An assumption until 10 measured consults exist.
export const CONSULT_MS_PRIOR = { p25: 60_000, p50: 120_000, p90: 300_000, basis: 'prior' as const }
// PRIOR: the chance a consulted failure comes back. No outcome data exists yet; consult outcomes calibrate it.
export const RECUR_PRIOR = 0.5
// PRIOR: the chance the task returns to the main model after a switch, as in transitionUsd at a new task.
export const RETURN_PRIOR = 0.5
// Above this recurrence chance a consult is not a quality-equivalent path, so the session switches.
export const RECUR_CEILING = 0.7

export interface Durations { p25: number; p50: number; p90: number; basis: 'prior' | 'measured' }

// durationsFrom: measured quantiles once there are enough samples, else the prior.
export function durationsFrom(samples: number[], min = 10): Durations {
  if (samples.length < min) return CONSULT_MS_PRIOR
  const s = [...samples].sort((a, b) => a - b)
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]
  return { p25: q(0.25), p50: q(0.5), p90: q(0.9), basis: 'measured' }
}

// expireChance: the share of consult durations longer than what is left of the cache. The CDF runs linearly through
// the quantiles and reaches 1 at twice p90.
export function expireChance(remainingMs: number, d: Durations): number {
  if (remainingMs <= 0) return 1
  const pts: [number, number][] = [[0, 0], [d.p25, 0.25], [d.p50, 0.5], [d.p90, 0.9], [d.p90 * 2, 1]]
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]
    const [x1, y1] = pts[i]
    if (remainingMs <= x1) return 1 - (x1 === x0 ? y1 : y0 + ((remainingMs - x0) / (x1 - x0)) * (y1 - y0))
  }
  return 0
}

export interface ConsultPriceInput {
  cache: CacheNote
  remainingRequests: number
  outPerRequest: number
  packetTokens: number
  planTokens: number
  setupTokens: number
  main: Family
  prices: PriceRow
  durations: Durations
  pRecur?: number
  pReturn?: number
}
export interface ConsultPrice {
  choice: 'consult' | 'switch'
  why: string
  consultUsd: number
  switchUsd: number
  parts: { stay: number; advisor: number; planBack: number; expire: number; ret: number; verify: number; retry: number; rebuild: number; onOpus: number; back: number }
  pExpire: number
  pRecur: number
  basis: { durations: string; recur: string }
}

// priceConsult:
//   consult = stay on main + packet and advisor + the plan back in main + P(expire)·rebuild of main + one verify
//             request + p_recur·switch (a consult that does not fix it still ends in the switch)
//   switch  = rebuild the prefix on Opus + the remaining requests on Opus + p_return·rebuild on main
// The quality rules run before the prices.
export function priceConsult(i: ConsultPriceInput, rules: { recurredBefore: boolean; floorRequiresSwitch: boolean } = { recurredBefore: false, floorRequiresSwitch: false }): ConsultPrice {
  const P = i.cache.prefixTokens
  const R = Math.max(0, i.remainingRequests)
  const x = cacheWriteX(i.cache.ttlMs)
  const o = rateAt(i.prices.rates.opus, P)
  const m = rateAt(i.prices.rates[i.main], P)
  const pRecur = i.pRecur ?? RECUR_PRIOR
  const pReturn = i.pReturn ?? RETURN_PRIOR
  const pExpire = i.cache.warm ? expireChance(i.cache.remainingMs, i.durations) : 1
  const rebuild = (P * o.input * x) / M
  const onOpus = (R * (P * o.input * o.cacheReadX + i.outPerRequest * o.output)) / M
  const back = (pReturn * P * m.input * x) / M
  const switchUsd = rebuild + onOpus + back
  const stay = (R * (P * m.input * m.cacheReadX + i.outPerRequest * m.output)) / M
  const oc = rateAt(i.prices.rates.opus, i.setupTokens + i.packetTokens)
  const advisor = ((i.setupTokens + i.packetTokens) * oc.input * 1.25 + i.planTokens * oc.output) / M
  const planBack = (i.planTokens * m.input * x) / M
  const ret = (P * m.input * Math.max(0, x - m.cacheReadX)) / M
  const expire = pExpire * ret
  const verify = (P * m.input * m.cacheReadX + i.outPerRequest * m.output) / M
  const retry = pRecur * switchUsd
  const consultUsd = stay + advisor + planBack + expire + verify + retry
  const r6 = (v: number) => Math.round(v * 1e6) / 1e6
  const parts = { stay: r6(stay), advisor: r6(advisor), planBack: r6(planBack), expire: r6(expire), ret: r6(ret), verify: r6(verify), retry: r6(retry), rebuild: r6(rebuild), onOpus: r6(onOpus), back: r6(back) }
  const basis = { durations: i.durations.basis, recur: i.pRecur === undefined ? 'prior' : 'measured' }
  const out = (choice: 'consult' | 'switch', why: string): ConsultPrice => ({ choice, why, consultUsd: r6(consultUsd), switchUsd: r6(switchUsd), parts, pExpire: r6(pExpire), pRecur, basis })
  if (rules.recurredBefore) return out('switch', 'quality: a consult in this episode did not fix it')
  if (rules.floorRequiresSwitch) return out('switch', 'quality: a floor requires the stronger model')
  if (pRecur > RECUR_CEILING) return out('switch', `quality: a consult recurs too often (${pRecur.toFixed(2)})`)
  return consultUsd < switchUsd
    ? out('consult', `consult $${consultUsd.toFixed(3)} under switch $${switchUsd.toFixed(3)} (estimate, R=${R})`)
    : out('switch', `switch $${switchUsd.toFixed(3)} at or under consult $${consultUsd.toFixed(3)} (estimate, R=${R})`)
}

// ---------------------------------------------------------------- consult outcomes

export type ConsultOutcome = 'verified_resolved' | 'recurred' | 'escalated' | 'unverified' | 'abandoned'
export interface OutcomeEvidence { switched: boolean; recurred: boolean; checkPassed: boolean; independentlyVerified: boolean; taskEnded: boolean }

// consultOutcome: null while the episode is still open. A check that passes without an independent check is not yet
// resolved; at the task's end it is `unverified`.
export function consultOutcome(e: OutcomeEvidence): ConsultOutcome | null {
  if (e.switched) return 'escalated'
  if (e.recurred) return 'recurred'
  if (e.checkPassed && e.independentlyVerified) return 'verified_resolved'
  if (!e.taskEnded) return null
  return e.checkPassed ? 'unverified' : 'abandoned'
}

export type Influence = 'followed' | 'partial' | 'ignored' | 'unknown'
const PATH = /(?:^|[\s`'"(\[])((?:[\w.-]+\/)*[\w.-]+\.[a-z][a-z0-9]{0,5})(?=$|[\s`'"):,;\]]|:\d|\.(?:\s|$))/gim

// planFiles: the file paths an architect's answer names.
export function planFiles(answer: string): string[] {
  const out = new Set<string>()
  for (const m of answer.matchAll(PATH)) if (!/^\d+(\.\d+)+$/.test(m[1]) && !/^https?:/.test(m[1])) out.add(m[1].replace(/^\.\//, ''))
  return [...out].slice(0, 40)
}

// influence: how far the edits after the consult followed its plan. A path matches on its tail, since the plan and
// the edit log may name it from different roots.
export function influence(plan: string[], editsAfter: string[]): Influence {
  if (!plan.length) return 'unknown'
  if (!editsAfter.length) return 'ignored'
  const hit = (p: string) => editsAfter.some((e) => e === p || e.endsWith(`/${p}`) || p.endsWith(`/${e}`))
  const share = plan.filter(hit).length / plan.length
  return share >= 0.5 ? 'followed' : share > 0 ? 'partial' : 'ignored'
}
