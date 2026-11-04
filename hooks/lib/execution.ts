// Execution strategy (v6.1, bench/experiments/V6.md): how a task starts and how it recovers. Pure: no `$` and no I/O.
//
// The proof runs showed that the model choice is mostly right and the recovery is what costs. A mid-task model switch
// moves the whole conversation into a pricier model's cache: in v5 six such switches cost $8.18 more than Sonnet high.
//
// Three separate switches, each off by default (`legacy` / `prospective`):
//   start     legacy | v6a | v6b      the start route
//   recovery  legacy | hold | rescue  what replaces the ladder's model switch
//   review    prospective | observed  whether a judge's rating alone buys a review
// `strategy` is a preset of the three: v6a = v6a/hold/observed, v6b = v6b/hold/observed, v6c = v6b/rescue/observed.
// An explicit start, recovery or review setting overrides the preset.
import { cacheWriteX, rateAt, type Rate } from './prices.ts'
import type { Effort, Family, Risk } from './types.ts'

export type Strategy = 'legacy' | 'v6a' | 'v6b' | 'v6c'
export type StartRule = 'legacy' | 'v6a' | 'v6b'
export type RecoveryRule = 'legacy' | 'hold' | 'rescue'
export type ReviewRule = 'prospective' | 'observed'
export interface Execution { start: StartRule; recovery: RecoveryRule; review: ReviewRule }

const PRESETS: Record<Strategy, Execution> = {
  legacy: { start: 'legacy', recovery: 'legacy', review: 'prospective' },
  v6a: { start: 'v6a', recovery: 'hold', review: 'observed' },
  v6b: { start: 'v6b', recovery: 'hold', review: 'observed' },
  v6c: { start: 'v6b', recovery: 'rescue', review: 'observed' },
}

// resolveExecution: the preset, then each explicit switch. `default` or a missing value keeps the preset's.
export function resolveExecution(c: { strategy?: string; start?: string; recovery?: string; review?: string }): Execution {
  const p = PRESETS[(c.strategy ?? 'legacy') as Strategy] ?? PRESETS.legacy
  const pick = <T extends string>(v: string | undefined, ok: readonly T[], d: T): T => (v && (ok as readonly string[]).includes(v) ? (v as T) : d)
  return {
    start: pick(c.start, ['legacy', 'v6a', 'v6b'] as const, p.start),
    recovery: pick(c.recovery, ['legacy', 'hold', 'rescue'] as const, p.recovery),
    review: pick(c.review, ['prospective', 'observed'] as const, p.review),
  }
}

// v6HaikuStart: the work a Haiku miss costs little on, and that a check can verify on its own. A tier label alone is
// not enough: T1 must also carry no risk and no complex work.
export function v6HaikuStart(tier: string | undefined, complexity: string | undefined, consequence: Risk | undefined): boolean {
  if (tier === 'T0') return consequence !== 'critical'
  return tier === 'T1' && (consequence ?? 'none') === 'none' && complexity !== 'complex'
}

// v6SonnetFloor: the lowest effort Sonnet starts at. v6a always high, the effort fixed Sonnet high passed 30 of 30 at.
// v6b takes the judged effort down to medium on well-specified work, and high on complex, T3+ or critical work.
export function v6SonnetFloor(start: 'v6a' | 'v6b', tier: string | undefined, complexity: string | undefined, consequence: Risk | undefined): Effort {
  if (start === 'v6a') return 'high'
  return complexity === 'complex' || tier === 'T3' || tier === 'T4' || consequence === 'critical' ? 'high' : 'medium'
}

// ---------- prices ----------

// A fresh run's cost on each model, from the proof runs' fixed arms: Sonnet high $7.20 and Opus medium $14.54 over
// 30 tasks, Haiku-only tasks $2.32 over 19 (bench/results/automode-proof-v2.jsonl, -v5.jsonl). An assumption until
// v6 rows replace it.
export const FRESH_PRIOR_USD: Record<Family, number> = { haiku: 0.12, sonnet: 0.24, opus: 0.48 }

// requestUsd: one request at a prompt of `prompt` tokens, all of it read from cache, and `out` tokens out.
export function requestUsd(rate: Rate, prompt: number, out: number): number {
  const r = rateAt(rate, prompt)
  return (prompt * r.input * r.cacheReadX + out * r.output) / 1e6
}

export interface RecoveryPrices { switchUsd: number; freshSameUsd: number; freshUpUsd: number; basis: 'estimate' }

// priceRecovery: the ways forward, priced alike. A switch writes the whole prefix to the target's cache, then reads it
// on every remaining request. A fresh builder pays the packet and a fresh run's prior.
export function priceRecovery(i: { current: Family; to: Family; prefixTokens: number; remainingRequests: number; outPerRequest: number; packetTokens: number; ttlMs: number; rates: Record<Family, Rate> }): RecoveryPrices {
  const write = (f: Family, tokens: number) => (tokens * rateAt(i.rates[f], tokens).input * cacheWriteX(i.ttlMs)) / 1e6
  const switchUsd = write(i.to, i.prefixTokens) + i.remainingRequests * requestUsd(i.rates[i.to], i.prefixTokens, i.outPerRequest)
  const fresh = (f: Family) => FRESH_PRIOR_USD[f] + write(f, i.packetTokens)
  const round = (x: number) => Math.round(x * 1e6) / 1e6
  return { switchUsd: round(switchUsd), freshSameUsd: round(fresh(i.current)), freshUpUsd: round(fresh(i.to)), basis: 'estimate' }
}

// ---------- recovery ----------

export type RecoveryAction = 'switch' | 'rescue-same' | 'rescue-up' | 'hold'

export interface RecoveryInput {
  rule: 'hold' | 'rescue'
  current: Family
  to: Family                  // the stronger model the ladder's step names
  pinned: boolean             // the person chose the model
  warm: boolean               // the running prefix is still cached
  prefixTokens: number
  smallContext: number        // below this a switch costs little (rescueSwitchTokens)
  effortCapped: boolean       // the running model is at its top effort: its capability is in doubt
  observedCritical: boolean   // the diff itself showed critical risk
  rescued: Partial<Record<Family, number>>
  prices: RecoveryPrices
}

// recovery: what replaces the ladder's model switch, in this order.
//   A pin keeps the person's model: only a fresh builder on that same model, else the route holds.
//   A small or cold context switches: there is little or no cache to lose, and the conversation keeps its corrections.
//   rule hold: Opus on observed critical evidence switches (quality first); everything else holds.
//   rule rescue, once per model:
//     a fresh builder on the same model, when the model is not at its top effort: the attempt, not the model, is the
//     likely fault, and a fresh context at the same price tier costs least;
//     then a fresh builder one model up, unless switching is priced lower;
//     then the route holds.
export function recovery(i: RecoveryInput): { action: RecoveryAction; why: string } {
  if (i.pinned) return i.rule === 'rescue' && !i.rescued[i.current] ? { action: 'rescue-same', why: 'the person chose this model: a fresh attempt on it, without the failed context' } : { action: 'hold', why: 'the person chose this model' }
  if (!i.warm) return { action: 'switch', why: 'the cache is cold, so a switch loses nothing' }
  if (i.prefixTokens < i.smallContext) return { action: 'switch', why: `the context (${i.prefixTokens} tokens) is small, so a switch costs little` }
  if (i.rule === 'hold') return i.to === 'opus' && i.observedCritical ? { action: 'switch', why: 'observed critical risk: quality first' } : { action: 'hold', why: 'moving a large context costs more than it saves' }
  if (!i.effortCapped && !i.rescued[i.current]) return { action: 'rescue-same', why: 'a fresh attempt on the same model, without the failed context' }
  if (!i.rescued[i.to]) {
    return i.prices.switchUsd < i.prices.freshUpUsd
      ? { action: 'switch', why: `a switch ($${i.prices.switchUsd.toFixed(3)}) is priced under a fresh ${i.to} builder ($${i.prices.freshUpUsd.toFixed(3)})` }
      : { action: 'rescue-up', why: `a fresh ${i.to} builder ($${i.prices.freshUpUsd.toFixed(3)}) is priced under a switch ($${i.prices.switchUsd.toFixed(3)})` }
  }
  return { action: 'hold', why: 'every rescue level for this task already ran' }
}

// ---------- watchdog ----------

export interface ProgressInput { failuresSinceFirstEdit: number; passesSinceFirstEdit: number; growthSinceFirstEdit: number; prefixTokens: number }

// unproductive: the attempt burns context without a pass: at least two failing checks since the first edit, no
// passing check, and either 40k tokens of growth since that edit or a context past 100k. One failure is ordinary
// work, however large the repository. It fires long before a 150k limit: sqlglot (v5) failed its checks from about
// 60k on, and the switch came at 159k.
export function unproductive(p: ProgressInput): boolean {
  if (p.passesSinceFirstEdit > 0 || p.failuresSinceFirstEdit < 2) return false
  return p.growthSinceFirstEdit >= 40_000 || p.prefixTokens >= 100_000
}

// ---------- Haiku's price step ----------

// haikuPriceStep: Haiku's next request crosses its long-context price step (above 100k tokens, fivefold). It prices
// that request against the same request on Sonnet. At the list prices it stays about half Sonnet's, so the verdict
// is usually `stay`; the record lets a run check that.
export function haikuPriceStep(rates: Record<Family, Rate>, nextPrompt: number, out: number): { crossed: boolean; haikuUsd: number; sonnetUsd: number; verdict: 'stay' | 'leave' } {
  const step = rates.haiku.longContext?.above ?? Infinity
  const haikuUsd = requestUsd(rates.haiku, nextPrompt, out)
  const sonnetUsd = requestUsd(rates.sonnet, nextPrompt, out)
  return { crossed: nextPrompt > step, haikuUsd: Math.round(haikuUsd * 1e6) / 1e6, sonnetUsd: Math.round(sonnetUsd * 1e6) / 1e6, verdict: nextPrompt > step && haikuUsd >= sonnetUsd ? 'leave' : 'stay' }
}

// ---------- the rescue brief ----------

export type RescueMode = 'repair' | 'restart'

// rescueMode: repair keeps the work when a check passed after the first edit, the evidence that part of it holds.
// With no such pass the edits are not progress: the builder starts again from the original code.
// v6RaiseAllowed: under v6 an effort step stops at high. In S1, five raises to Sonnet xhigh cost $0.84. Plain Sonnet
// high passed each of those tasks with no raise, and the one that still failed failed after the raise too.
export const v6RaiseAllowed = (to: Effort): boolean => EFFORT_ORDER.indexOf(to) <= EFFORT_ORDER.indexOf('high')
const EFFORT_ORDER: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function rescueMode(firstEditAt: number | null, passedAt: number[]): RescueMode {
  return firstEditAt !== null && passedAt.some((t) => t > firstEditAt) ? 'repair' : 'restart'
}

export interface RescueBrief {
  family: Family
  mode: RescueMode
  because: string
  packet: string             // lib/handoff.ts: goal, the person's corrections, acceptance, failures, the diff
  passedChecks: string[]     // checks that passed after the first edit
  failedApproaches: string[] // what this task already tried and what came of it
  remainingUsd: number | null
}

// rescueNote: the instruction to the main session. It never moves this conversation to the builder.
export function rescueNote(b: RescueBrief): string {
  const failed = b.failedApproaches.length ? `Already tried, do not repeat: ${b.failedApproaches.slice(0, 6).join('; ')}.` : ''
  const budget = b.remainingUsd === null ? '' : `The task has $${b.remainingUsd.toFixed(2)} of its budget left.`
  // One neutral wording for both modes. It names its source and claims nothing about the work. On sqlglot, a note that
  // said the edits "are not progress" read as false to Haiku ("the baseline script ran fine"), which then declined it
  // as an injected instruction, twice. The plain repair note was followed on qs and dnspython.
  const state = b.mode === 'repair'
    ? `These checks pass after the first edit: ${b.passedChecks.slice(0, 5).join('; ')}. Keep that work and fix what still fails.`
    : 'No check has passed since the first edit yet. Read the current changes first, keep what holds up, and finish the task.'
  return [
    `[AutoMode (the routing plugin in this session): ${b.because}. To keep the task's cost down, AutoMode hands the rest of it to a fresh builder. Call the Agent tool with subagent_type "automode:builder" and model "${b.family}", wait for it, and give it this brief. The builder works on the files as they are now.`,
    `Mode: ${b.mode}. ${state}`,
    failed,
    b.packet,
    `When it returns, run the failing check once and report the result. ${budget}]`,
  ].filter(Boolean).join('\n\n')
}

// builderNote (builder: on): non-trivial work goes to one builder subagent at the routed model from the start.
export const builderNote = (family: Family) =>
  `Hand the implementation to one builder: call the Agent tool with subagent_type "automode:builder" and model "${family}", give it the whole request, the acceptance criteria and any correction the person made, and wait for it. Then run the checks yourself and report.`
