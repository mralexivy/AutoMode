// Switch check: the cache policy as a constraint on a candidate, never a source of one. It answers
// switch or hold for moving from the current route to the candidate. A mandatory floor always
// switches; its cost is recorded, never a reason to wait. Payback math and context fit adapted from
// claude-router (Alexei Ledenev, MIT) and jev-router (MIT).
import type { Basis, CacheState, Candidate, Economics, Floor, Route, SwitchCheck, Tier } from './types.ts'
import { REMAINING, remainingWork, type Remaining } from './optimizer.ts'
import { tierRank } from './types.ts'
import type { PriceRow } from './prices.ts'
import { cacheWriteX, rateAt } from './prices.ts'

export interface PolicyParams {
  upgradeVotes: number          // consecutive votes for a non-mandatory upgrade
  downgradeConfidence: number   // judge confidence a downgrade needs
  minDwellRequests: number      // requests since the last switch before a downgrade on the same task
  paybackFactor: number         // the conservative (p25) saving must exceed this many times the switch cost
  remainingRequests: number     // legacy single R; the check reads the remaining-work quantiles instead
  maxSwitches: number           // discretionary model switches per task before the route holds
  contextReserve: number        // share of the window kept free
  haikuMaxContext: number       // Haiku only below this many tokens
  smallContext: number          // below this, a switch costs little (jev-router's 20k guard)
  calibrated: boolean           // true once the parameters passed calibration
  paybackQuantile?: 'p25' | 'median' | 'p75' // the remaining-work quantile the payback is priced on (default p25)
}

export const DEFAULT_PARAMS: PolicyParams = {
  upgradeVotes: 2, downgradeConfidence: 0.85, minDwellRequests: 8, paybackFactor: 1.5, remainingRequests: 6, maxSwitches: 3,
  contextReserve: 0.2, haikuMaxContext: 80_000, smallContext: 20_000, calibrated: false,
}

export const WINDOW: Record<string, number> = { haiku: 1_000_000, sonnet: 1_000_000, opus: 1_000_000 }

export interface SwitchInput {
  current: Route | null
  candidate: Candidate
  target: Route
  floor: Floor
  mandatory: boolean
  cache: CacheState
  now: number
  votes: number                  // consecutive candidate votes for this target, this one included
  requestsSinceSwitch: number
  verifiedSinceSwitch: boolean
  sameTask: boolean
  risk: 'none' | 'elevated' | 'critical'
  expectedOutputTokens: number
  // Policy auto (from v4.1): the target's own output per request and its step count relative to the running configuration, from the
  // effort of each. Without them the saving compares model prices alone (the legacy check).
  targetOutputTokens?: number
  targetStepRatio?: number
  prices: PriceRow
  params?: PolicyParams
  requestsInPrompt?: number      // k: main requests already made for this prompt
  newTaskSteps?: number          // a new task's own expected length, when the switch is at a task boundary
  remainingTable?: Remaining[]   // a person's calibrated residual table
  switchesThisTask?: number      // discretionary model switches already made in this task
  targetWarm?: boolean           // the target model's own cache is still warm (per-model warm state)
  targetWarmPrefix?: number      // what that cache holds: the turns added since then are not in it
  resetPrefixTokens?: number     // after compaction: the system-and-tools prefix that stays cached (measured live: 48,836 of 72,742)
  reworkUsd?: number             // expected rework difference (target minus current), when known
}

// lowPenaltyPoint: no warm cache to lose. Session start (no prefix yet), after /clear or compaction
// (the prefix was reset), or a cold cache (idle past its lifetime).
export function lowPenaltyPoint(cache: CacheState, now: number, resetSinceLastRequest: boolean): boolean {
  if (resetSinceLastRequest || cache.lastRequestAt === null || cache.prefixTokens === 0) return true
  return now - cache.lastRequestAt > cache.ttlMs
}

// switchCostUsd is what moving the warm prefix to the target costs over staying for one request:
// the target writes the prefix, while staying would read it from cache.
export function switchCostUsd(cache: CacheState, from: Route | null, to: Route, prices: PriceRow, warm: boolean): number {
  if (!warm || cache.prefixTokens === 0) return 0
  const tokens = cache.prefixTokens
  const t = rateAt(prices.rates[to.family], tokens)
  const write = tokens * t.input * cacheWriteX(cache.ttlMs)
  if (!from) return write / 1e6
  const f = rateAt(prices.rates[from.family], tokens)
  return Math.max(0, write - tokens * f.input * f.cacheReadX) / 1e6
}

// returnCostUsd prices going back to a model whose cache is warm: it reads what it holds and writes the turns added
// since. Like switchCostUsd, it is the extra cost over reading the prefix on the current route.
export function returnCostUsd(cache: CacheState, held: number, from: Route | null, to: Route, prices: PriceRow, warm: boolean): number {
  if (!warm || cache.prefixTokens === 0) return 0
  const tokens = cache.prefixTokens
  const kept = Math.min(held, tokens)
  const t = rateAt(prices.rates[to.family], tokens)
  const cost = kept * t.input * t.cacheReadX + (tokens - kept) * t.input * cacheWriteX(cache.ttlMs)
  if (!from) return cost / 1e6
  const f = rateAt(prices.rates[from.family], tokens)
  return Math.max(0, cost - tokens * f.input * f.cacheReadX) / 1e6
}

// perRequestSavingUsd is what one later request saves on the target versus the current route.
export function perRequestSavingUsd(prefix: number, out: number, from: Route, to: Route, prices: PriceRow): number {
  const f = rateAt(prices.rates[from.family], prefix)
  const t = rateAt(prices.rates[to.family], prefix)
  return (prefix * (f.input * f.cacheReadX - t.input * t.cacheReadX) + out * (f.output - t.output)) / 1e6
}

// perRequestCostUsd is what one request costs on a route: the cached prefix read plus the output.
export function perRequestCostUsd(prefix: number, out: number, route: Route, prices: PriceRow): number {
  const r = rateAt(prices.rates[route.family], prefix)
  return (prefix * r.input * r.cacheReadX + out * r.output) / 1e6
}

export function fits(route: Route, tokens: number, params: PolicyParams): boolean {
  if (route.family === 'haiku' && tokens > params.haikuMaxContext) return false
  return tokens <= (WINDOW[route.family] ?? 200_000) * (1 - params.contextReserve)
}

// remainingFor reads the work left: a new task's own length at a boundary, else the residual table at k.
export function remainingFor(i: Pick<SwitchInput, 'requestsInPrompt' | 'newTaskSteps' | 'remainingTable'>): Remaining {
  if (i.newTaskSteps !== undefined) {
    const s = i.newTaskSteps
    return { k: 0, n: REMAINING[0].n, p25: Math.max(1, Math.round(s / 3)), median: s, p75: s * 3 }
  }
  return remainingWork(i.requestsInPrompt ?? 0, i.remainingTable)
}

export function switchCheck(i: SwitchInput, resetSinceLastRequest = false): SwitchCheck {
  const p = i.params ?? DEFAULT_PARAMS
  const basis: Basis = p.calibrated ? 'calibrated' : 'estimate'
  // Compaction is a partial reset: the conversation is rewritten, but the system prompt and tools stay
  // cached on the current model while the cache lives. A switch then still rewrites that prefix, so it is
  // priced and gated like any warm switch on the smaller prefix, not treated as free.
  const warmByTime = i.cache.lastRequestAt !== null && i.now - i.cache.lastRequestAt <= i.cache.ttlMs
  const partialReset = resetSinceLastRequest && warmByTime && (i.resetPrefixTokens ?? 0) > 0
  if (partialReset) i = { ...i, cache: { ...i.cache, prefixTokens: i.resetPrefixTokens! } }
  const low = partialReset ? false : lowPenaltyPoint(i.cache, i.now, resetSinceLastRequest)
  const warm = !low
  const sameRoute = i.current && i.current.model === i.target.model
  const effortOnly = sameRoute && i.current!.effort !== i.target.effort
  // A target whose own cache is still warm reads what it holds and writes only the turns added since.
  const cost = sameRoute ? 0 : i.targetWarm ? returnCostUsd(i.cache, i.targetWarmPrefix ?? i.cache.prefixTokens, i.current, i.target, i.prices, warm) : switchCostUsd(i.cache, i.current, i.target, i.prices, warm)
  const rem = remainingFor(i)
  // What one later request saves on the target. With the effort of both configurations known, each is priced as it will
  // run (its own output per step) and the target's step count is scaled by the effort ratio.
  const per = !i.current || sameRoute ? 0
    : i.targetOutputTokens !== undefined
      ? perRequestCostUsd(i.cache.prefixTokens, i.expectedOutputTokens, i.current, i.prices) - (i.targetStepRatio ?? 1) * perRequestCostUsd(i.cache.prefixTokens, i.targetOutputTokens, i.target, i.prices)
      : perRequestSavingUsd(i.cache.prefixTokens, i.expectedOutputTokens, i.current, i.target, i.prices)
  const economics: Economics = {
    current: i.current ? `${i.current.model}/${i.current.effort}` : null, candidate: `${i.target.model}/${i.target.effort}`,
    prefixTokens: i.cache.prefixTokens, writePenaltyUsd: round(cost), ttlMs: i.cache.ttlMs, effortSharesCache: i.cache.effortSharesCache,
    remaining: { k: rem.k, p25: rem.p25, median: rem.median, p75: rem.p75, n: rem.n },
    savingUsd: { p25: round(per * rem.p25), median: round(per * rem.median), p75: round(per * rem.p75) },
    ...(i.reworkUsd !== undefined ? { reworkUsd: round(i.reworkUsd) } : {}), basis,
  }
  const out = (verdict: 'switch' | 'hold', reason: string, gate?: SwitchCheck['gate']): SwitchCheck => ({ verdict, ...(gate ? { gate } : {}), estUsd: cost, basis, lowPenaltyPoint: low, reason, economics })

  // The reserve keeps a new route away from the window's edge. A target with at least the running model's window
  // (never Haiku, which has its own limit) holds whatever the running model already holds, so the reserve does not
  // block it: without this, an escalation to Opus past 800k tokens stayed on Sonnet (retrospective replay, 2026-10-26).
  const sameWindow = !!i.current && i.target.family !== 'haiku' && (WINDOW[i.target.family] ?? 0) >= (WINDOW[i.current.family] ?? Infinity)
  if (!fits(i.target, i.cache.prefixTokens, p) && !sameWindow) return out('hold', 'the target cannot hold this context', 'context')
  if (!i.current) return out('switch', 'first route')
  if (sameRoute && !effortOnly) return out('switch', 'same route')
  // An effort change rewrites the cache where effort splits it (Vertex, Bedrock, gateways). There it
  // waits for a low-penalty point unless the floor demands it.
  if (effortOnly) return !i.cache.effortSharesCache && warm && !i.mandatory ? out('hold', 'provider splits the cache by effort', 'provider-effort') : out('switch', 'effort change on the same model')
  // Quality first: a mandatory floor switches at once, whatever it costs and however often it happened.
  if (i.mandatory) return out('switch', 'mandatory quality floor')
  // Anti-oscillation applies to discretionary changes only.
  if ((i.switchesThisTask ?? 0) >= p.maxSwitches) return out('hold', `${p.maxSwitches} discretionary switches already in this task`, 'oscillation')
  if (low) return out('switch', 'low-switch-penalty point')

  const up = tierRank(i.target.tier) > tierRank(i.current.tier)
  if (up) return i.votes >= p.upgradeVotes || i.cache.prefixTokens < p.smallContext ? out('switch', 'upgrade confirmed') : out('hold', `upgrade needs ${p.upgradeVotes} votes`, 'votes')

  // Downgrade in a warm session: every gate must pass, and the conservative saving must pay back.
  if (i.risk !== 'none' || i.candidate.confidence < p.downgradeConfidence) return out('hold', 'risk or confidence too high for a downgrade', 'quality')
  if (i.sameTask && (i.requestsSinceSwitch < p.minDwellRequests || !i.verifiedSinceSwitch)) return out('hold', 'dwell: too soon after the last switch, or no passed check yet', 'dwell')
  if (i.cache.prefixTokens >= p.smallContext) {
    const q = p.paybackQuantile ?? 'p25'
    const saving = per * rem[q] - Math.max(0, i.reworkUsd ?? 0)
    if (saving <= p.paybackFactor * cost) return out('hold', `${q} saving $${saving.toFixed(4)} does not pay back ${p.paybackFactor}x the $${cost.toFixed(4)} rewrite`, 'payback')
  }
  return out('switch', 'downgrade pays back')
}

const round = (n: number) => Math.round(n * 1e6) / 1e6

// tierAtLeast lifts a tier to the floor.
export const tierAtLeast = (t: Tier, floor: Floor): Tier => (tierRank(t) >= tierRank(floor.tier) ? t : floor.tier)
