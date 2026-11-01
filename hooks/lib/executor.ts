// The Sonnet executor: a task's model is not predicted before the work. Pure: no $ and no I/O.
//
// The model is Sonnet. A pin, a floor or the escalation ladder can still move it, and lib/authority.ts still applies
// them. Effort is what moves with the task, and only upward inside it: medium by default, high where the effort judge
// or a floor asks. A warm task keeps its effort, so a follow-up never reclassifies it. On a provider that splits the
// cache by effort, a change would also pay for a rewrite. Higher rungs come from floors and the ladder, not from here.
import { EFFORTS, type Effort } from './types.ts'

const rank = (e: Effort) => EFFORTS.indexOf(e)

export function executorEffort(judged: Effort | undefined, taskEffort: Effort | undefined): Effort {
  const verdict = judged ?? 'medium'
  const clamped: Effort = rank(verdict) <= rank('medium') ? 'medium' : 'high'
  return taskEffort && rank(taskEffort) > rank(clamped) ? taskEffort : clamped
}
