// Decision B: where the reasoning runs. Direct in the main cached session, an isolated worker, or
// the engineering workflow. Forks were dropped: a mod cannot spawn one (spike S2), and S6 never ran. Every estimate lists its parts and the
// assumptions behind them, and carries its basis: until calibrated, a parameter is an estimate.
import type { Basis, CacheState, Family, Risk, Strategy } from './types.ts'
import type { PriceRow } from './prices.ts'
import { cacheWriteX, rateAt } from './prices.ts'

export interface StrategyParams {
  remainingRequests: number   // R
  retryRate: number           // p: share of worker runs that come back partial
  workerSetupTokens: Record<Family, number> // H: system prompt and tools a fresh agent writes
  reportTokens: number        // r: a worker report's size in the parent
  isolationMargin: number     // worker p75 must be below this share of direct p50
  minConfidence: number       // below it, choose direct
  calibrated: boolean
}

export const DEFAULT_STRATEGY: StrategyParams = {
  remainingRequests: 10, retryRate: 0.2, workerSetupTokens: { haiku: 18_000, sonnet: 18_000, opus: 18_000 },
  reportTokens: 2_500, isolationMargin: 0.8, minConfidence: 0.6, calibrated: false,
}

export interface Work { p50: number; p75: number; source: string } // tokens the work reads, with how they were estimated
export interface StrategyEstimate {
  strategy: Strategy
  usd: { p50: number; p75: number }
  parts: Record<'mainRead' | 'mainWrite' | 'workerSetup' | 'workerWork' | 'handoff' | 'downstreamReuse' | 'retry', number>
  assumptions: string[]
}
export interface StrategyChoice { chosen: Strategy; estimates: StrategyEstimate[]; reason: string; confidence: number; basis: Basis }

export interface StrategyInput {
  hint: Strategy | null          // the judge's or the user's strategy
  workflowPurpose?: string | null // why the workflow pays here; without one a workflow hint runs direct
  risk: Risk
  designDecision: boolean        // the task is a design or architecture decision
  main: Family
  worker: Family
  cache: CacheState
  work: Work
  outputTokens: number
  prices: PriceRow
  params?: StrategyParams
}

const M = 1e6

function direct(i: StrategyInput, w: number, p: StrategyParams): StrategyEstimate {
  const r = rateAt(i.prices.rates[i.main], i.cache.prefixTokens + w)
  const mainRead = (w * r.input) / M
  const reuse = (w * r.input * r.cacheReadX * p.remainingRequests) / M
  const out = (i.outputTokens * r.output) / M
  const total = mainRead + reuse + out
  return { strategy: 'direct', usd: { p50: total, p75: total }, parts: { mainRead, mainWrite: 0, workerSetup: 0, workerWork: out, handoff: 0, downstreamReuse: reuse, retry: 0 }, assumptions: [] }
}

function worker(i: StrategyInput, w: number, p: StrategyParams): StrategyEstimate {
  const wr = rateAt(i.prices.rates[i.worker], p.workerSetupTokens[i.worker] + w)
  const mr = rateAt(i.prices.rates[i.main], i.cache.prefixTokens)
  const setup = (p.workerSetupTokens[i.worker] * wr.input * 1.25) / M // subagents get the 5-minute cache
  const work = (w * wr.input + i.outputTokens * wr.output) / M
  const handoff = (p.reportTokens * mr.input * cacheWriteX(i.cache.ttlMs)) / M
  const reuse = (p.reportTokens * mr.input * mr.cacheReadX * p.remainingRequests) / M
  const once = setup + work + handoff + reuse
  const retry = p.retryRate * once
  return { strategy: 'isolated-worker', usd: { p50: once + retry, p75: once + retry }, parts: { mainRead: 0, mainWrite: handoff, workerSetup: setup, workerWork: work, handoff, downstreamReuse: reuse, retry }, assumptions: [] }
}

export function estimate(i: StrategyInput): StrategyEstimate[] {
  const p = i.params ?? DEFAULT_STRATEGY
  const at = (f: typeof direct, w: number) => f(i, w, p)
  const both = (f: typeof direct): StrategyEstimate => {
    const lo = at(f, i.work.p50)
    const hi = at(f, i.work.p75)
    return { ...lo, usd: { p50: lo.usd.p50, p75: hi.usd.p75 }, assumptions: [`work ${i.work.p50}-${i.work.p75} tokens (${i.work.source})`, `R=${p.remainingRequests}`, `retry=${p.retryRate}`, `setup=${p.workerSetupTokens[i.worker]}`, `report=${p.reportTokens}`] }
  }
  return [both(direct), both(worker)]
}

// choose applies quality first, then cost: critical risk and design decisions stay in the session or
// go to the workflow; isolation needs a clear margin; uncertainty means direct.
export function choose(i: StrategyInput, confidence: number): StrategyChoice {
  const p = i.params ?? DEFAULT_STRATEGY
  const basis: Basis = p.calibrated ? 'calibrated' : 'estimate'
  const estimates = estimate(i)
  const pick = (chosen: Strategy, reason: string): StrategyChoice => ({ chosen, estimates, reason, confidence, basis })
  // The workflow costs a plan, workers and a review: it needs a stated purpose, not just "complex".
  if (i.hint === 'engineering-workflow' && i.workflowPurpose) return pick('engineering-workflow', i.workflowPurpose)
  if (i.hint === 'direct') return pick('direct', 'hint: direct')
  if (i.risk === 'critical' || i.designDecision) return pick('direct', 'critical risk or design decision: keep reasoning in the session')
  if (confidence < p.minConfidence) return pick('direct', `low confidence ${confidence}`)
  const d = estimates.find((e) => e.strategy === 'direct')!
  const best = estimates.filter((e) => e.strategy !== 'direct').sort((a, b) => a.usd.p75 - b.usd.p75)[0]
  if (best && best.usd.p75 < p.isolationMargin * d.usd.p50) return pick(best.strategy, `${best.strategy} p75 $${best.usd.p75.toFixed(4)} < ${p.isolationMargin} x direct p50 $${d.usd.p50.toFixed(4)}`)
  return pick('direct', 'isolation does not clear the margin')
}

// workFromFiles estimates the tokens a task reads from file sizes: a heuristic, labeled as such.
export function workFromFiles(sizesBytes: number[], promptChars: number): Work {
  const bytes = sizesBytes.reduce((a, b) => a + b, 0)
  const p50 = Math.ceil((bytes + promptChars) / 3.5)
  return { p50, p75: Math.ceil(p50 * 1.5), source: `heuristic: ${sizesBytes.length} files, ${bytes} bytes / 3.5` }
}

// consultOrSwitch compares two answers to a repeated failure that needs Opus reasoning:
//   switch  the main session moves to Opus: it writes the warm prefix on Opus once, then runs the
//           remaining requests there (reads at Opus prices, output at Opus prices).
//   consult the main session stays; a read-only Opus architect gets the evidence packet, writes a plan
//           (its own setup and packet, plus its output), and the plan comes back as a report.
// The consult wins only by a clear margin, so a borderline case keeps the stronger main model.
export interface ConsultInput { prefixTokens: number; remainingRequests: number; outPerRequest: number; packetTokens: number; planTokens: number; main: Family; ttlMs: number; prices: PriceRow; setupTokens?: number }
export function consultOrSwitch(i: ConsultInput, margin = 0.7): { choice: 'consult' | 'switch'; consultUsd: number; switchUsd: number; why: string } {
  const o = rateAt(i.prices.rates.opus, i.prefixTokens)
  const m = rateAt(i.prices.rates[i.main], i.prefixTokens)
  const R = i.remainingRequests
  const switchUsd = (i.prefixTokens * o.input * cacheWriteX(i.ttlMs) + R * (i.prefixTokens * o.input * o.cacheReadX + i.outPerRequest * o.output)) / M
  const stayUsd = (R * (i.prefixTokens * m.input * m.cacheReadX + i.outPerRequest * m.output)) / M
  const setup = i.setupTokens ?? DEFAULT_STRATEGY.workerSetupTokens.opus
  const oc = rateAt(i.prices.rates.opus, setup + i.packetTokens)
  const consultUsd = stayUsd + ((setup + i.packetTokens) * oc.input * 1.25 + i.planTokens * oc.output) / M + (i.planTokens * m.input * cacheWriteX(i.ttlMs)) / M
  const choice = consultUsd < margin * switchUsd ? 'consult' : 'switch'
  return { choice, consultUsd, switchUsd, why: `consult $${consultUsd.toFixed(3)} vs switch $${switchUsd.toFixed(3)} (estimate, R=${R})` }
}
