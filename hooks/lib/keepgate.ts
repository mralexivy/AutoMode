// Should this chat be kept warm right now? Pure: no `$`, no I/O.
// Two rules decide, and a race on the person's own gaps picks which one acts.
//   The champion is the simple rule: keep a chat warm when a cold start is dear, until the horizon, inside the budget.
//   The challenger adds the person's habits: keep it warm only when the odds of a return pay for the pings.
// Both answer to the same refusals, which protect money and the router first:
//   stale        the cache belongs to another model or came before a compaction: a ping would write a new one;
//   horizon      the chat has been idle longer than the horizon;
//   budget       this session spent its keep-warm budget;
//   ledger       pings have not paid for this person so far;
//   finished     the work looks done, so a cold start is a free chance to change model;
//   above need   the model is above what the next task likely needs, unless work is unfinished or the person pinned it;
//   small        a cold start would cost too little to matter.
// An audit on real data found the first habits rule no better than the simple one on net dollars, only gentler (fewer pings), and the
// "unfinished work" signals carried no measurable information about a return (a model that asked a question did). So the challenger is
// the return model (lib/model.ts), and it acts only after it wins the race (lib/habits.ts, decideActive). Every refusal carries a reason for the records.
import type { Family, Tier } from './types.ts'
import { pingValue, type Habits } from './habits.ts'
import type { Feat } from './model.ts'
import { pingCostUsd, rewriteUsd } from './keepwarm.ts'
import type { Rate } from './prices.ts'

export interface TaskRaw {
  completionState: string; editedSinceCheck: boolean; lastCheckPassed: boolean | null
  planMode: boolean; workStage: string | null; openObligations: number; consultOpen: boolean; workersRunning: number
  tier: Tier | null; family: Family | null; reachHaiku: boolean
  pinned: boolean // the person chose this model (am:, /model): it is what they want, so it is never "above need"
}
export interface TaskState { unfinished: boolean; finished: boolean; aboveNeed: boolean }

const RANK: Record<Family, number> = { haiku: 0, sonnet: 1, opus: 2 }
// weakestFor: the cheapest model the router would call eligible for work of this tier (policy auto, reachHaiku).
export const weakestFor = (tier: Tier, reachHaiku: boolean): Family => (tier === 'T4' ? 'opus' : tier === 'T3' ? 'sonnet' : reachHaiku ? 'haiku' : 'sonnet')

export function stateOf(r: TaskRaw): TaskState {
  const unfinished = ['failed', 'unverified', 'partially_verified'].includes(r.completionState) || r.editedSinceCheck || r.lastCheckPassed === false
    || r.planMode || r.workStage === 'plan' || r.workStage === 'plan-approved' || r.openObligations > 0 || r.consultOpen || r.workersRunning > 0
  const finished = !unfinished && r.completionState === 'verified'
  const aboveNeed = !r.pinned && !!r.tier && !!r.family && RANK[r.family] > RANK[weakestFor(r.tier, r.reachHaiku)]
  return { unfinished, finished, aboveNeed }
}

export interface GateInput {
  habits: Habits; state: TaskState; feat: Feat; ttlMs: number; rate: Rate
  minRewriteUsd: number; sessionPingUsd: number; budgetUsd: number; capMin: number; stale: boolean
}
export interface Verdict { allow: boolean; why: string; net: number | null }
export interface Gate { champion: Verdict; challenger: Verdict; use: Verdict; active: 'champion' | 'challenger' }

function refusal(i: GateInput): Verdict | null {
  const no = (why: string): Verdict => ({ allow: false, why, net: null })
  if (i.stale) return no('the cache is for another model or came before a compaction')
  if (i.feat.idleMin > i.capMin) return no('idle past the horizon')
  if (i.sessionPingUsd >= i.budgetUsd) return no('this session spent its keep-warm budget')
  const led = i.habits.kw
  if (led.pingUsd >= 1 && led.savedUsd < 0.5 * led.pingUsd) return no('pings have not paid for you so far')
  if (i.state.finished) return no('the work looks finished: a cold start is a free chance to change model')
  if (i.state.aboveNeed && !i.state.unfinished) return no('the model is above what the next task likely needs')
  const saving = rewriteUsd(i.feat.tokens, i.rate, i.ttlMs) - pingCostUsd(i.feat.tokens, i.rate)
  if (saving < i.minRewriteUsd) return no('a cold start would cost too little to matter')
  return null
}

export function gate(i: GateInput): Gate {
  const common = refusal(i)
  const champion: Verdict = common ?? { allow: true, why: 'a cold start is dear', net: null }
  let challenger: Verdict
  if (common) challenger = common
  else {
    const v = pingValue({ habits: i.habits, feat: i.feat, ttlMs: i.ttlMs, rate: i.rate })
    challenger = v.net > 0 ? { allow: true, why: i.feat.asked ? 'the assistant asked a question, and a return is likely' : 'a return is likely', net: v.net } : { allow: false, why: 'a return is too unlikely to pay for the pings', net: v.net }
  }
  const active = i.habits.cc.active
  return { champion, challenger, use: active === 'challenger' ? challenger : champion, active }
}
