// Live savings: what this session would have cost on the model it started with, against what it cost. Pure: no `$`,
// no I/O. v4.ts feeds it each main-session request's measured usage and the app's model, and the bar reads the result.
//
// The baseline is the app's model on that request: the person's /model, or Claude Code's default. Routing never
// rewrites the app's value, so it is the model the person would have run without AutoMode. Each request's real tokens
// are priced twice:
//   actual    on the model that answered, exactly as measured, cache writes included.
//   baseline  on the baseline model, with that model's own cache simulated: it stays warm while requests keep coming
//             within the cache lifetime, so the baseline reads what it already cached and writes only what is new.
// The saving is baseline minus actual, minus AutoMode's own model calls (judges, extracts, compaction). So a switch
// shows its true price first: the new model writes the whole chat into its cache while the baseline only reads its
// warm cache, the saving dips, and it climbs back as cheaper requests pay the rewrite off.
//
// What it does not count, on purpose: thinking tokens an effort change saved on the same model (the baseline would
// have produced different output, which nobody measured), and subagent requests (counted as equal on both sides).
// What it cannot know: how many requests and tokens the baseline model would really have used. So it is an estimate
// of the same tokens at other prices, and the bar marks it with "~". bench/savings-replay.mts checks it against the
// benchmark: on the five mixed sessions it estimated 56% against a measured 52%, within $0.18 per session.
import type { Family, TokenUsage } from './types.ts'
import { familyOf, rateAt, usageUsd, type PriceRow } from './prices.ts'

export interface Savings {
  baseline: Family | null      // the model the session would have run on; null before the first priced request
  actualUsd: number            // main-session requests as measured
  baselineUsd: number          // the same requests on the baseline model, with its own cache
  overheadUsd: number          // AutoMode's own model calls
  requests: number             // main-session requests priced
  rerouted: number             // of those, requests that ran on another model than the baseline
  rewriteUsd: number           // extra cache writes the reroutes caused, the part a switch pays first
  cache: { prompt: number; at: number; family: Family } | null // the baseline's simulated warm cache
}

export const NO_SAVINGS: Savings = { baseline: null, actualUsd: 0, baselineUsd: 0, overheadUsd: 0, requests: 0, rerouted: 0, rewriteUsd: 0, cache: null }

const round6 = (x: number) => Math.round(x * 1e6) / 1e6
const promptOf = (u: TokenUsage) => u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h

// baselineUsage: the request's tokens as the baseline model would have billed them. Its cache holds the prompt of the
// last request while that is still warm; anything beyond is written, at the same lifetime split as the real request.
export function baselineUsage(u: TokenUsage, warm: number): TokenUsage {
  const prompt = promptOf(u)
  const cacheRead = Math.min(warm, Math.max(0, prompt - u.input))
  const write = Math.max(0, prompt - u.input - cacheRead)
  const realWrite = u.cacheWrite5m + u.cacheWrite1h
  const share1h = realWrite > 0 ? u.cacheWrite1h / realWrite : 0
  return { input: u.input, output: u.output, cacheRead, cacheWrite5m: write * (1 - share1h), cacheWrite1h: write * share1h }
}

// addRequest folds one main-session request into the running savings.
export function addRequest(s: Savings, req: { appModel: string; answeredModel: string; usage: TokenUsage; at: number; ttlMs: number }, row: PriceRow): Savings {
  const base = familyOf(req.appModel)
  const ran = familyOf(req.answeredModel)
  if (!base || !ran) return s
  const actual = usageUsd(req.usage, row.rates[ran])
  const warm = s.cache && s.cache.family === base && req.at - s.cache.at <= req.ttlMs ? s.cache.prompt : 0
  const bu = baselineUsage(req.usage, warm)
  const baseline = ran === base ? actual : usageUsd(bu, row.rates[base])
  const rerouted = ran !== base
  // The rewrite is the cache written beyond what the baseline would have written, priced on the model that ran.
  const extraWrite = rerouted ? Math.max(0, req.usage.cacheWrite5m + req.usage.cacheWrite1h - (bu.cacheWrite5m + bu.cacheWrite1h)) : 0
  const rate = rateAt(row.rates[ran], promptOf(req.usage))
  const rewrite = extraWrite > 0 ? (extraWrite * rate.input * (req.usage.cacheWrite1h > 0 ? 2 : 1.25)) / 1e6 : 0
  return {
    baseline: base,
    actualUsd: round6(s.actualUsd + actual),
    baselineUsd: round6(s.baselineUsd + baseline),
    overheadUsd: s.overheadUsd,
    requests: s.requests + 1,
    rerouted: s.rerouted + (rerouted ? 1 : 0),
    rewriteUsd: round6(s.rewriteUsd + rewrite),
    cache: { prompt: promptOf(req.usage), at: req.at, family: base },
  }
}

// addOverhead counts one of AutoMode's own model calls against the saving.
export const addOverhead = (s: Savings, usd: number): Savings => ({ ...s, overheadUsd: round6(s.overheadUsd + Math.max(0, usd)) })

export type SavingsPhase = 'none' | 'paying-back' | 'saving'

// netOf is the estimated saving so far. It is negative while a switch's cache rewrite is not yet paid off.
export const netOf = (s: Savings) => round6(s.baselineUsd - s.actualUsd - s.overheadUsd)

// phaseOf names the state the bar shows: nothing rerouted yet, a reroute still paying back, or a real saving.
export function phaseOf(s: Savings): SavingsPhase {
  if (!s.baseline || s.rerouted === 0) return 'none'
  return netOf(s) < 0 ? 'paying-back' : 'saving'
}

// shareOf is the saving as a share of the baseline cost, or null when there is nothing to compare.
export const shareOf = (s: Savings) => (s.baselineUsd > 0 && s.rerouted > 0 ? netOf(s) / s.baselineUsd : null)
