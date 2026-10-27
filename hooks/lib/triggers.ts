// Event triggers: when the route should be looked at again between person prompts. Deterministic and
// pure. Most triggers re-run the optimizer on the stored demand (no model call); only a real change in
// what the task is (scope growth past a threshold) asks the judge again, at most once per task stage.
// An ordinary tool step never triggers anything.
import type { Family } from './types.ts'

export type TriggerEvent =
  | { kind: 'check-pass'; implementing: boolean }       // a test or build passed
  | { kind: 'check-fail'; repeated: boolean; defect: boolean }
  | { kind: 'context'; prefixTokens: number; family: Family } // after a response, the prompt size
  | { kind: 'step-start'; idleMs: number; ttlMs: number }    // before a request: was the cache left to expire
  | { kind: 'compacted' }
  | { kind: 'scope'; outsidePaths: number }              // files edited outside the discovered or planned set
  | { kind: 'plan-exit' }
  | { kind: 'plan-enter' }                               // plan mode began after this prompt was already routed

export interface TriggerState {
  haikuMaxContext: number
  longContextAt: number          // Haiku's 5x price step
  scopeThreshold: number         // edited files outside the known set before the task is judged again
  judgedThisStage: boolean       // the judge already re-ran in this stage
  verifiedAfterPlan: boolean     // a check already passed in this implementation stage
}

export type TriggerAction = 'none' | 'reoptimize' | 'judge' | 'escalate'
export interface Trigger { action: TriggerAction; reason: string; mandatory: boolean }

const none: Trigger = { action: 'none', reason: '', mandatory: false }

export function trigger(s: TriggerState, e: TriggerEvent): Trigger {
  switch (e.kind) {
    case 'check-fail':
      // Repeated substantive failures escalate through failures.ts; a single failure is ordinary work.
      return e.repeated && e.defect ? { action: 'escalate', reason: 'repeated failing check after an edit', mandatory: true } : none
    case 'check-pass':
      // The first passed check of an implementation stage is a natural point to step down: the hard
      // part is behind, and the downgrade gates now see a verified state.
      return e.implementing && !s.verifiedAfterPlan ? { action: 'reoptimize', reason: 'first passed check in implementation', mandatory: false } : none
    case 'context':
      if (e.family === 'haiku' && e.prefixTokens > s.haikuMaxContext) return { action: 'reoptimize', reason: `context ${e.prefixTokens} past Haiku's limit`, mandatory: true }
      return none
    case 'step-start':
      return e.idleMs > e.ttlMs ? { action: 'reoptimize', reason: 'the cache expired while idle: a low-penalty point', mandatory: false } : none
    case 'compacted':
      return { action: 'reoptimize', reason: 'compaction: smaller context, same task', mandatory: false }
    case 'scope':
      return e.outsidePaths >= s.scopeThreshold && !s.judgedThisStage ? { action: 'judge', reason: `${e.outsidePaths} files edited outside the known scope`, mandatory: false } : none
    case 'plan-exit':
      return { action: 'reoptimize', reason: 'plan approved: implementation starts', mandatory: false }
    case 'plan-enter':
      return { action: 'reoptimize', reason: 'plan mode began after the prompt was routed', mandatory: false }
  }
}
