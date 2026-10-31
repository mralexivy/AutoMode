// Joint model x effort optimizer. Every configuration (Haiku, Sonnet, Opus) x (low, medium, high,
// xhigh, max) is checked for adequacy against the task's demand and priced to an accepted result,
// counting the expected retry. The cheapest adequate configuration wins. Pure: no `$`.
//
// What is known and what is assumed, kept apart:
//   - Prices, cache rules and token usage are measured (prices.ts, calibration from transcripts).
//   - Capability is an ASSUMPTION: an interval per configuration, ordered by the Anthropic effort docs
//     (all five levels on all three 5.5 models; Opus 5.5 medium matches Opus 5 high), the effortless
//     anchor ("Opus at medium does about what Sonnet does at high"), and claude-router's reading that
//     Haiku at high effort sits above Sonnet at low. No outcome data per configuration exists, so the
//     intervals are wide and the decision uses coarse adequacy bands, never a precise probability.
//   - Retry rates per band are assumptions too, labeled as such in every record.
// Six dimensions stay separate: task difficulty, reasoning depth and consequence (Demand); model
// capability and effort (Candidate); required verification (Demand.verification, set by consequence
// and never by the implementer choice).
import type { Basis, CacheState, Complexity, Effort, Family, Risk, Tier } from './types.ts'
import { EFFORTS } from './types.ts'
import type { PriceRow } from './prices.ts'
import { cacheWriteX, rateAt } from './prices.ts'
import { UNSURE_BELOW, demandBand } from './bands.ts'

export interface Band { lo: number; hi: number }
const b = (lo: number, hi: number): Band => ({ lo, hi })

// Capability intervals (assumption). Wider at the top of each model: Sonnet xhigh and max are not
// assumed equal to Opus; their intervals overlap Opus medium and high but sit below Opus high.
export const CAPABILITY: Record<Family, Record<Effort, Band>> = {
  haiku: { low: b(1.0, 1.4), medium: b(1.6, 2.0), high: b(1.9, 2.4), xhigh: b(2.1, 2.6), max: b(2.2, 2.7) },
  sonnet: { low: b(2.0, 2.4), medium: b(2.7, 3.1), high: b(3.1, 3.5), xhigh: b(3.3, 3.8), max: b(3.4, 4.0) },
  opus: { low: b(2.7, 3.1), medium: b(3.2, 3.6), high: b(3.8, 4.2), xhigh: b(4.0, 4.5), max: b(4.2, 4.7) },
}
export const CAPABILITY_SOURCE = 'assumption: Anthropic effort docs ordering, effortless Opus-medium≈Sonnet-high anchor, claude-router Haiku reading; no per-configuration outcome data'
export const mid = (x: Band) => (x.lo + x.hi) / 2

// Adequacy of a configuration for a required capability.
export type Adequacy = 'sufficient' | 'likely' | 'uncertain' | 'insufficient'
export function adequacy(cap: Band, req: number): Adequacy {
  if (cap.lo >= req) return 'sufficient'
  if (mid(cap) >= req) return 'likely'
  if (cap.hi >= req) return 'uncertain'
  return 'insufficient'
}
// Retry rate per band (assumption): the share of attempts that need a stronger retry.
export const RETRY: Record<Adequacy, Band> = { sufficient: b(0.05, 0.15), likely: b(0.15, 0.35), uncertain: b(0.35, 0.65), insufficient: b(0.65, 0.95) }

// Remaining main requests in a prompt after k were made: measured on the author's transcripts
// (bench/calibrate.mts, 1,369 prompts, 2026-10-21). The distribution is heavy-tailed: the longer a
// prompt has run, the more it has left. Cost decisions read quantiles from here, never one mean.
export interface Remaining { k: number; n: number; p25: number; median: number; p75: number }
export const REMAINING: Remaining[] = [
  { k: 0, n: 1369, p25: 2, median: 6, p75: 19 },
  { k: 1, n: 1060, p25: 3, median: 8, p75: 26 },
  { k: 2, n: 935, p25: 4, median: 9, p75: 30 },
  { k: 4, n: 784, p25: 4, median: 11, p75: 39 },
  { k: 8, n: 553, p25: 6, median: 18, p75: 54 },
  { k: 16, n: 377, p25: 9, median: 29, p75: 79 },
  { k: 32, n: 231, p25: 18, median: 45, p75: 88 },
]
export function remainingWork(k: number, table: Remaining[] = REMAINING): Remaining {
  let row = table[0]
  for (const r of table) if (r.k <= k) row = r
  return row
}
// A new task's own length, before any request: anchored on the k=0 quantiles by complexity (assumption).
export const TASK_STEPS: Record<Complexity, number> = { trivial: REMAINING[0].p25, standard: REMAINING[0].median, complex: REMAINING[0].p75 }

export interface Priors {
  outputPerStep: Record<Family, number>   // output tokens per request at medium effort (thinking included)
  effortOutput: Record<Effort, number>    // output multiple relative to medium
  effortSteps: Record<Effort, number>     // tool-step multiple relative to medium
  newInputPerStep: number                 // tokens a step adds to the prompt
  remainingRequests: number               // kept for consultOrSwitch; the switch policy uses REMAINING
  remaining?: Remaining[]                 // a person's own residual table, from calibration.json
  remainingByStage?: Record<string, Remaining[]> // the same, per task stage (policy v4.1); a stage without a table reads `remaining`
  basis: Basis
  source: string
}

// Token priors measured on the author's transcripts (means, 28,949 requests). effortOutput high 1.36 is
// an uncontrolled comparison (task mix differs per level), so it is labeled estimate, not causal; low,
// xhigh and max have no usable samples. Each person's calibration.json replaces these.
export const DEFAULT_PRIORS: Priors = {
  outputPerStep: { haiku: 344, sonnet: 616, opus: 688 },
  effortOutput: { low: 0.6, medium: 1, high: 1.36, xhigh: 1.5, max: 1.8 },
  effortSteps: { low: 0.85, medium: 1, high: 1.1, xhigh: 1.2, max: 1.25 },
  newInputPerStep: 983,
  remainingRequests: REMAINING[0].median,
  basis: 'estimate',
  source: 'bench/calibrate.mts on the author transcripts, 2026-10-21; effort ratios uncontrolled',
}

// The demand on the implementer, and the controls the consequence requires.
export type Verification = 'none' | 'checks' | 'review'
export interface Demand {
  difficulty: number    // 1-5: engineering difficulty
  reasoning: number     // 1-5: depth of reasoning
  steps: number         // expected main requests for this task
  consequence: Risk     // what a wrong change costs
  verification: Verification // set by consequence and complexity; never lowered by the implementer choice
  confidence: number    // the classifier's confidence, read as ordinal
  planning?: boolean    // plan mode
  failures?: number     // repeated substantive failures in this task so far
  // Policy v4.1: the ordinal demand band and why it rose. Set by demandOf from the tier, the unsure flag, plan mode and failures.
  tier?: Tier
  complexity?: Complexity
  band?: number
  unsure?: boolean
  bandWhy?: string[]
}

export interface Candidate { family: Family; effort: Effort; cap: Band }
export interface Scored extends Candidate {
  adequacy: Adequacy
  retry: Band
  attemptUsd: number
  expectedUsd: number
  expectedUsdRange: Band   // from the retry interval and the step quantiles
  switchUsd: number
  feasible: boolean
  why: string
}

export interface Constraints {
  family?: Family
  effort?: Effort
  minCap?: number          // a floor's capability (escalation, critical non-trivial work, redo)
  allowed?: Family[]
  haikuMaxContext?: number
  minBand?: number         // policy v4.1: the quality floor as a band; it always wins
  prefixUnknown?: boolean  // policy v4.1: the prompt size is not known yet (first request): Haiku is not chosen
}

export function candidates(): Candidate[] {
  const out: Candidate[] = []
  for (const family of ['haiku', 'sonnet', 'opus'] as Family[]) for (const effort of EFFORTS) out.push({ family, effort, cap: CAPABILITY[family][effort] })
  return out
}

export function required(d: Demand): number {
  return Math.min(5, 0.6 * d.difficulty + 0.4 * d.reasoning + (d.planning ? 0.4 : 0))
}

// Which adequacy bands may implement. Low classifier confidence, or a critical consequence, keeps only
// `sufficient`: the configuration's lower bound must meet the need. This is uncertainty handling, not a
// model rule: critical bounded work stays on Sonnet high when Sonnet high's lower bound suffices.
export function acceptable(d: Demand): Adequacy[] {
  return d.confidence < 0.7 || d.consequence === 'critical' ? ['sufficient'] : ['sufficient', 'likely']
}

export interface CostInput {
  cache: CacheState
  warm: Partial<Record<Family, { effort: Effort | null; until: number; prefixTokens: number }>>
  now: number
  prices: PriceRow
  priors?: Priors
  // neutral: price every configuration as if its cache were warm. The router chooses cache-neutral, so
  // the choice says which configuration fits the task; the switch check then decides whether moving
  // there is worth the cache rewrite. Without it, a warm model wins every comparison by its cache alone.
  neutral?: boolean
}

// attemptCost prices one attempt over `steps` requests: the first writes the prefix on a cold model
// (or reads it on a warm one), each later request reads the growing prefix, adds new input, and writes
// output scaled by effort. Thinking is part of output; it is never added a second time.
export function attemptCost(c: Candidate, d: Pick<Demand, 'steps'>, x: CostInput, stepsOverride?: number): { usd: number; switchUsd: number } {
  const p = x.priors ?? DEFAULT_PRIORS
  const steps = Math.max(1, Math.round((stepsOverride ?? d.steps) * p.effortSteps[c.effort]))
  const out = p.outputPerStep[c.family] * p.effortOutput[c.effort]
  const w = x.warm[c.family]
  const warmHere = !!x.neutral || (!!w && w.until > x.now && (x.cache.effortSharesCache || w.effort === c.effort))
  let usd = 0
  let switchUsd = 0
  let prefix = Math.max(x.cache.prefixTokens, 0)
  for (let i = 0; i < steps; i++) {
    const r = rateAt(x.prices.rates[c.family], prefix + p.newInputPerStep)
    const cold = i === 0 && !warmHere
    const write = cold ? prefix : 0
    const read = cold ? 0 : prefix
    usd += (read * r.input * r.cacheReadX + write * r.input * cacheWriteX(x.cache.ttlMs) + p.newInputPerStep * r.input * cacheWriteX(x.cache.ttlMs) + out * r.output) / 1e6
    if (cold) switchUsd = (write * r.input * cacheWriteX(x.cache.ttlMs)) / 1e6
    prefix += p.newInputPerStep + out
  }
  return { usd, switchUsd }
}

export interface Choice {
  best: Scored; ranked: Scored[]; required: number; acceptable: Adequacy[]; basis: Basis; capabilitySource: string
  // Policy v4.1: no available configuration meets the demand. `best` is then the strongest available, and the
  // caller must say so. `shortfall` is how many bands short it is.
  inadequate?: boolean
  shortfall?: number
}

export function optimize(d: Demand, x: CostInput, k: Constraints = {}): Choice {
  const req = required(d)
  const ok = acceptable(d)
  const all = candidates().filter((c) => (!k.family || c.family === k.family) && (!k.effort || c.effort === k.effort) && (!k.allowed || k.allowed.includes(c.family)))
  const rows = all.map((c) => {
    const a = adequacy(c.cap, req)
    // Repeated failures in this task raise the retry rate of the configurations near the need: this is
    // where a stronger model starts to pay for itself.
    const extra = (d.failures ?? 0) > 0 && mid(c.cap) <= req + 0.3 ? Math.min(0.3, 0.15 * (d.failures ?? 0)) : 0
    const retry = { lo: Math.min(0.95, RETRY[a].lo + extra), hi: Math.min(0.95, RETRY[a].hi + extra) }
    const cost = attemptCost(c, d, x)
    const short = attemptCost(c, d, x, Math.max(1, Math.round(d.steps / 3)))
    const long = attemptCost(c, d, x, d.steps * 3)
    return { c, a, retry, cost, short, long }
  })
  const scored: Scored[] = rows.map(({ c, a, retry, cost, short, long }) => {
    // A failed attempt is redone on the cheapest stronger configuration that is at least likely, plus rework.
    const stronger = rows.filter((o) => mid(o.c.cap) >= mid(c.cap) + 0.4 && (o.a === 'sufficient' || o.a === 'likely')).sort((p, q) => p.cost.usd - q.cost.usd)[0]
    const redo = (u: number, s?: { usd: number }) => (s ? s.usd : u * 2) + 0.5 * u
    const expectedUsd = cost.usd + mid(retry) * redo(cost.usd, stronger?.cost)
    const lo = short.usd + retry.lo * redo(short.usd, stronger?.short)
    const hi = long.usd + retry.hi * redo(long.usd, stronger?.long)
    const tooLong = c.family === 'haiku' && x.cache.prefixTokens > (k.haikuMaxContext ?? 80_000)
    const floorOk = mid(c.cap) >= (k.minCap ?? 0)
    const feasible = ok.includes(a) && floorOk && !tooLong
    const why = feasible ? `${a} for need ${req.toFixed(2)}` : tooLong ? 'context too long for Haiku' : !floorOk ? `below the floor ${k.minCap}` : `${a} for need ${req.toFixed(2)}; acceptable: ${ok.join(', ')}`
    return { ...c, adequacy: a, retry, attemptUsd: cost.usd, expectedUsd, expectedUsdRange: { lo, hi }, switchUsd: cost.switchUsd, feasible, why }
  })
  const ranked = [...scored].sort((p, q) => Number(q.feasible) - Number(p.feasible) || p.expectedUsd - q.expectedUsd)
  // Nothing is adequate: the strongest allowed configuration (quality first).
  const best = ranked[0].feasible ? ranked[0] : [...scored].filter((s) => s.family !== 'haiku' || scored.every((r) => r.family === 'haiku')).sort((p, q) => mid(q.cap) - mid(p.cap) || p.expectedUsd - q.expectedUsd)[0]
  return { best, ranked, required: req, acceptable: ok, basis: 'estimate', capabilitySource: CAPABILITY_SOURCE }
}

// demandOf maps a verdict (judge v2 or v3 contract) to the demand. The tier anchors difficulty and
// complexity adds reasoning depth. The judge's effort is its own pick of effort within a model, which
// the optimizer now owns: it is kept as a hint in records, never added to difficulty (that counted the
// same signal twice and pushed "T3, high" verdicts to Opus max). Consequence sets verification.
export const TIER_DIFFICULTY: Record<Tier, number> = { T0: 1.3, T1: 2.7, T2: 3.1, T3: 3.7, T4: 4.2 }
export function verificationFor(consequence: Risk, complexity: Complexity): Verification {
  if (consequence === 'critical') return 'review'
  return consequence === 'elevated' || complexity !== 'trivial' ? 'checks' : 'none'
}
export function demandOf(v: { tier: Tier; complexity: Complexity; effort?: Effort; risk: Risk; confidence?: number; consequence?: Risk; unsure?: boolean }, planning = false, failures = 0): Demand {
  const difficulty = TIER_DIFFICULTY[v.tier]
  const reasoning = difficulty + (v.complexity === 'complex' ? 0.3 : v.complexity === 'trivial' ? -0.1 : 0)
  const consequence = v.consequence ?? v.risk
  const confidence = v.confidence ?? 0.9
  const b = demandBand({ tier: v.tier, unsure: v.unsure ?? confidence < UNSURE_BELOW, planning, failures, complexity: v.complexity })
  return { difficulty, reasoning, steps: TASK_STEPS[v.complexity], consequence, verification: verificationFor(consequence, v.complexity), confidence, planning, failures, tier: v.tier, complexity: v.complexity, band: b.band, unsure: b.unsure, bandWhy: b.why }
}

// tierOf names a configuration's tier for records and the switch check (T0 Haiku, T1-T2 Sonnet, T3-T4 Opus).
export function tierOf(family: Family, effort: Effort): Tier {
  if (family === 'haiku') return 'T0'
  if (family === 'sonnet') return effort === 'low' || effort === 'medium' ? 'T1' : 'T2'
  return effort === 'max' ? 'T4' : 'T3'
}

// The capability a tier floor demands: the midpoint of that tier's ladder route.
export const FLOOR_CAPABILITY: Record<Tier, number> = { T0: 0, T1: mid(CAPABILITY.sonnet.medium), T2: mid(CAPABILITY.sonnet.high), T3: mid(CAPABILITY.opus.high), T4: mid(CAPABILITY.opus.max) }
