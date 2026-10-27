// Message transitions: what a short message does to the running task. A deterministic classifier for
// the unambiguous cases only; everything else (including every affirmative that approves new work) goes
// to the judge. Pure: no `$`. Before this, any message of 12 characters or fewer kept the running route,
// so "commit" and "done" ran on Opus xhigh because the task before them had.
import type { Effort } from './types.ts'

export type Transition = 'acknowledgment' | 'continue' | 'begin-approved' | 'verification' | 'repository' | 'ambiguous'

export interface TransitionResult {
  kind: Transition
  // A transition the router decides without a judge call. `effort` is the effort it asks for on the
  // running model; absent means the running effort stays.
  bypassJudge: boolean
  effort?: Effort
  why: string
}

const MAX_WORDS = 6
const clean = (t: string) => t.trim().toLowerCase().replace(/[.!?\s]+$/g, '').replace(/\s+/g, ' ')

// Only commit and push are mechanical. A bare merge or rebase can mean conflict resolution, so those go to the judge.
const REPOSITORY = /^(?:(?:please|now) )?(?:git )?(?:commit|push|stage|open (?:a )?(?:pr|mr)|create (?:a )?(?:pr|mr))(?: (?:it|them|this|all|everything|the changes|and|&|then|push|mr|pr|commit|to main))*$/
const VERIFICATION = /^(?:please )?(?:re-?run |run )?(?:the )?(?:tests?|lint|build|typecheck|type check|checks?|ci)$/
const ACKNOWLEDGMENT = /^(?:ok(?:ay)?|thanks?(?: you)?|thx|got it|great|nice|perfect|cool|good|hello|hi|hey)$/
const CONTINUE = /^(?:continue|go on|go ahead|proceed|carry on|keep going|next|resume|go|now fix (?:it|them|the tests))$/
const AFFIRMATIVE = /^(?:yes(?: please)?|yep|yeah|y|sure|do it|implement(?: it)?|ship it|approved|lgtm|sounds good|go for it)$/
// Words a reply uses to say it finished, so a later "done" only closes the task.
const CLOSES = /\b(done|complete[d]?|finished|committed|pushed|merged|all set|ready|fixed|updated|renamed|added|removed)\b/i
// Words a reply uses to hand a decision or a step to the person.
const HANDS_OVER = /\b(plan|proposal|propos(?:e|ed)|approach|options?|shall i|should i|want me to|would you like|do you want|which (?:one|option)|let me know|tell me when|once you)\b/i

// closeTo: a one-word message within two edits of `word` (the history holds "contiunue", "continie", "contineu").
function closeTo(text: string, word: string): boolean {
  if (Math.abs(text.length - word.length) > 2 || text.includes(' ')) return false
  const row = Array.from({ length: text.length + 1 }, (_, i) => i)
  for (let j = 1; j <= word.length; j++) {
    let diag = row[0]
    row[0] = j
    for (let i = 1; i <= text.length; i++) {
      const up = row[i]
      row[i] = Math.min(row[i] + 1, row[i - 1] + 1, diag + (text[i - 1] === word[j - 1] ? 0 : 1))
      diag = up
    }
  }
  return row[text.length] <= 2
}

export function transitionOf(text: string, lastReply: string): TransitionResult {
  const t = clean(text)
  const ambiguous = (why: string): TransitionResult => ({ kind: 'ambiguous', bypassJudge: false, why })
  if (!t || t.split(' ').length > MAX_WORDS) return ambiguous('not a short transition')
  const answersHandOver = HANDS_OVER.test(lastReply.slice(-600)) || lastReply.slice(-400).includes('?')

  if (REPOSITORY.test(t)) return { kind: 'repository', bypassJudge: true, effort: 'medium', why: 'repository operation: same model, medium effort' }
  if (VERIFICATION.test(t)) return { kind: 'verification', bypassJudge: true, effort: 'medium', why: 'verification: same model, medium effort' }
  if (AFFIRMATIVE.test(t)) return { kind: 'begin-approved', bypassJudge: false, why: 'approves work: judged on the work it starts' }
  if (t === 'done') {
    // "done" is ambiguous: it answers a step the reply handed over (continue the work), or it closes a task the reply
    // finished. After any other reply it is not decided here: in the audit, a "done" was followed by 74 requests of work.
    if (answersHandOver) return { kind: 'continue', bypassJudge: true, why: 'the person finished a step the reply asked for' }
    return CLOSES.test(lastReply.slice(-300))
      ? { kind: 'acknowledgment', bypassJudge: true, effort: 'low', why: 'closing remark after a finished task: same model, low effort' }
      : ambiguous('done after a reply that did not close the task')
  }
  if (ACKNOWLEDGMENT.test(t) || CONTINUE.test(t) || (closeTo(t, 'continue') && t.length >= 6)) {
    // After a question or a proposal, a short word chooses what happens next: the judge decides.
    if (answersHandOver) return { kind: 'begin-approved', bypassJudge: false, why: 'answers a question or proposal: judged on the work it starts' }
    return ACKNOWLEDGMENT.test(t)
      ? { kind: 'acknowledgment', bypassJudge: true, effort: 'low', why: 'acknowledgment: same model, low effort' }
      : { kind: 'continue', bypassJudge: true, why: 'continue: the running route stays' }
  }
  return ambiguous('short but not a known transition')
}
