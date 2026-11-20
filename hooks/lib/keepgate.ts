// Should this chat be kept warm right now? Pure: no `$`, no I/O.
// A ping costs a little and pays only if the person comes back before the cache would have expired anyway, and only if
// a cold start would not have been the better moment to change model. Four questions, asked in this order:
//   1. Is a cold start expensive enough to matter?       (a rewrite under a few cents is not worth a ping)
//   2. Does the work look unfinished, or finished?       (finished work and a model above need: let it go cold)
//   3. Do this person's habits say they come back?       (habits.ts, with the unfinished signal as a boost)
//   4. Is there budget, and have pings paid for them?    (a per-session cap, and the person's own ledger)
// Every refusal carries a reason, so a record or the bar can say why nothing was sent.
import type { Family, Tier } from './types.ts'
import { pingValue, type Habits } from './habits.ts'
import type { Rate } from './prices.ts'

export interface TaskRaw {
  completionState: string; editedSinceCheck: boolean; lastCheckPassed: boolean | null
  planMode: boolean; workStage: string | null; openObligations: number; consultOpen: boolean; workersRunning: number
  tier: Tier | null; family: Family | null; reachHaiku: boolean
}
export interface TaskState { unfinished: boolean; finished: boolean; aboveNeed: boolean }

const RANK: Record<Family, number> = { haiku: 0, sonnet: 1, opus: 2 }
// weakestFor: the cheapest model the router would call eligible for work of this tier (policy auto, reachHaiku).
export const weakestFor = (tier: Tier, reachHaiku: boolean): Family => (tier === 'T4' ? 'opus' : tier === 'T3' ? 'sonnet' : reachHaiku ? 'haiku' : 'sonnet')

export function stateOf(r: TaskRaw): TaskState {
  const unfinished = ['failed', 'unverified', 'partially_verified'].includes(r.completionState) || r.editedSinceCheck || r.lastCheckPassed === false
    || r.planMode || r.workStage === 'plan' || r.workStage === 'plan-approved' || r.openObligations > 0 || r.consultOpen || r.workersRunning > 0
  const finished = !unfinished && r.completionState === 'verified'
  const aboveNeed = !!r.tier && !!r.family && RANK[r.family] > RANK[weakestFor(r.tier, r.reachHaiku)]
  return { unfinished, finished, aboveNeed }
}

export interface GateInput {
  habits: Habits; state: TaskState; prefixTokens: number; family: Family; ttlMs: number; idleMin: number; rate: Rate
  minRewriteUsd: number; sessionPingUsd: number; budgetUsd: number; capMin: number
}
export interface Gate { allow: boolean; why: string; net: number | null }

export function gate(i: GateInput): Gate {
  const no = (why: string, net: number | null = null): Gate => ({ allow: false, why, net })
  if (i.idleMin > i.capMin) return no('idle past the horizon')
  if (i.sessionPingUsd >= i.budgetUsd) return no('this session spent its keep-warm budget')
  const led = i.habits.kw
  if (led.pingUsd >= 1 && led.savedUsd < 0.5 * led.pingUsd) return no('pings have not paid for you so far')
  if (i.state.finished) return no('the work looks finished: a cold start is a free chance to change model')
  if (i.state.aboveNeed && !i.state.unfinished) return no('the model is above what the next task likely needs')
  const v = pingValue({ habits: i.habits, prefixTokens: i.prefixTokens, family: i.family, acted: null, idleMin: i.idleMin, ttlMs: i.ttlMs, rate: i.rate })
  // A cold start must matter: the saving if the person returns, not weighted by how likely that is.
  const rewrite = v.saveUsd / Math.max(v.pReturn, 1e-9)
  if (rewrite < i.minRewriteUsd) return no('a cold start would cost too little to matter', v.net)
  // Unfinished work halves the chance that the person does not come back. This is a prior, until the ledger says otherwise.
  const p = i.state.unfinished ? 1 - (1 - v.pReturn) * 0.5 : v.pReturn
  const net = (p / Math.max(v.pReturn, 1e-9)) * v.saveUsd - v.costUsd
  return net > 0 ? { allow: true, why: i.state.unfinished ? 'unfinished work, and a return is likely' : 'a return is likely', net } : no('a return is too unlikely to pay for the pings', net)
}
