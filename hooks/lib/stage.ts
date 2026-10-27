// Task stage: what the agent is doing now, beyond what the person asked. Pure: no `$`.
//
// The router already knows the message class (transition.ts), the judge's verdict, plan mode, edits, checks and
// failures. This module folds them into one stage per prompt, so the route follows the work and not the last prompt:
//
//   lookup         a question or a read-only answer
//   explore        mapping the repository (a Haiku worker's work)
//   analyze        understanding a problem before changing anything
//   plan           plan mode
//   plan-approved  the first prompt after plan mode ends: implementation is judged on its own
//   implement      changing code
//   verify         running checks
//   debug          a repeated failing check after an edit
//   reconsider     the person challenges finished work ("are you sure", "you missed")
//   review         an independent review
//   repo-op        commit or push
//   complete       a closing remark
//
// A stage changes the route only where it carries information the judge's tier does not: plan mode (a plan needs more
// than the same task implemented), and a challenge (it asks for a new check, so it keeps at least the work's band).
// Everything else is recorded for the trace and the status row.
import type { Complexity, Tier } from './types.ts'
import type { Transition } from './transition.ts'

export type Stage = 'lookup' | 'explore' | 'analyze' | 'plan' | 'plan-approved' | 'implement' | 'verify' | 'debug' | 'reconsider' | 'review' | 'repo-op' | 'complete'

export interface StageInput {
  planMode: boolean
  planJustExited: boolean
  transition?: Transition
  tier?: Tier
  complexity?: Complexity
  strategy?: 'direct' | 'isolated-worker' | 'engineering-workflow'
  text: string
  previous: Stage
  repeatedFailure: boolean   // the same failing check twice after an edit (the escalation evidence)
  hasEdits: boolean
}

// A challenge to finished or proposed work: it asks for a new check, not a status.
const CHALLENGE = /\b(are you (?:really |absolutely |completely )?sure|you (missed|forgot|broke|did not|didn'?t)|that'?s (wrong|not right)|is (that|this) (really|actually)|will (that|this|it) (really|actually)|doesn'?t (work|fix)|still (broken|fails?|failing))\b/i
const REVIEW = /^(?:please )?(?:run |do |give me )?(?:a |the )?(?:final |code |independent )?review\b/i
const ANALYZE = /\b(analy[sz]e|investigate|root cause|why (does|is|did)|audit|understand|find out)\b/i

export const isChallenge = (text: string) => CHALLENGE.test(text)

// stageOf reads the stage for one prompt. The order matters: the first rule that holds wins.
export function stageOf(i: StageInput): Stage {
  if (i.planMode) return 'plan'
  if (i.planJustExited) return 'plan-approved'
  if (i.transition === 'repository') return 'repo-op'
  if (i.transition === 'verification') return 'verify'
  if (i.transition === 'acknowledgment') return 'complete'
  if (i.repeatedFailure) return 'debug'
  if (CHALLENGE.test(i.text) && (i.previous === 'implement' || i.previous === 'verify' || i.previous === 'debug' || i.previous === 'complete' || i.previous === 'repo-op' || i.previous === 'reconsider' || i.previous === 'plan-approved')) return 'reconsider'
  if (REVIEW.test(i.text.trim())) return 'review'
  if (i.strategy === 'isolated-worker') return 'explore'
  if (i.tier === 'T0' && !i.hasEdits) return 'lookup'
  if (!i.hasEdits && ANALYZE.test(i.text) && (i.tier === 'T2' || i.tier === 'T3' || i.tier === 'T4')) return 'analyze'
  return 'implement'
}
