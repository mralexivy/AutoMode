// Execution strategy (v6, bench/experiments/V6.md): how a task starts and how it recovers. Pure: no `$` and no I/O.
//
// The proof runs showed that the model choice is mostly right and the recovery is what costs. A mid-task model switch
// moves the whole conversation into a pricier model's cache: in v5 six such switches cost $8.18 more than Sonnet high.
// The strategies below differ in the start route and in what replaces that switch.
//
//   legacy  main's routing and ladder, unchanged.
//   v6a     Haiku only for T0, or T1 with no risk and no complex work; else Sonnet high. Recovery is an effort raise;
//           a model switch only while the context is small, or for Opus on observed critical evidence.
//   v6b     v6a, but Sonnet runs at the judged effort (medium allowed) unless the work is complex, T3 or critical.
//   v6c     v6b, and where a switch would move a large context, a fresh rescue builder one model up runs instead,
//           once per model.
import type { Effort, Family, Risk } from './types.ts'

export type Strategy = 'legacy' | 'v6a' | 'v6b' | 'v6c'
export const isV6 = (s: string | undefined): s is 'v6a' | 'v6b' | 'v6c' => s === 'v6a' || s === 'v6b' || s === 'v6c'

// v6HaikuStart: the work a Haiku miss costs little on. A tier label alone is not enough: T1 must also carry no risk
// and no complex work.
export function v6HaikuStart(tier: string | undefined, complexity: string | undefined, consequence: Risk | undefined): boolean {
  if (tier === 'T0') return consequence !== 'critical'
  return tier === 'T1' && (consequence ?? 'none') === 'none' && complexity !== 'complex'
}

// v6SonnetFloor: the lowest effort Sonnet starts at. v6a always high, the effort fixed Sonnet high passed 30 of 30 at.
// v6b and v6c take the judged effort down to medium, except on complex, T3 or critical work.
export function v6SonnetFloor(s: 'v6a' | 'v6b' | 'v6c', tier: string | undefined, complexity: string | undefined, consequence: Risk | undefined): Effort {
  if (s === 'v6a') return 'high'
  return complexity === 'complex' || tier === 'T3' || tier === 'T4' || consequence === 'critical' ? 'high' : 'medium'
}

export type RecoveryAction = 'switch' | 'rescue' | 'hold'

export interface RecoveryInput {
  strategy: 'v6a' | 'v6b' | 'v6c'
  to: Family                  // the model the ladder's step names
  prefixTokens: number        // the running context
  smallContext: number        // below this a switch costs little (rescueSwitchTokens)
  observedCritical: boolean   // the diff itself showed critical risk
  rescued: number             // fresh rescue builders already run at `to` for this task
}

// recovery: what replaces the ladder's model switch.
//   A small context switches: the rebuild costs cents, and the same conversation keeps its corrections.
//   Opus on observed critical evidence switches under v6a and v6b: quality first.
//   v6c starts a fresh builder at `to`, once per model; a second need at the same model holds.
//   Otherwise the route holds, and the model fixes the failure or says why it does not apply.
export function recovery(i: RecoveryInput): RecoveryAction {
  if (i.prefixTokens < i.smallContext) return 'switch'
  if (i.strategy === 'v6c') return i.rescued > 0 ? 'hold' : 'rescue'
  return i.to === 'opus' && i.observedCritical ? 'switch' : 'hold'
}

export type RescueMode = 'repair' | 'restart'

// rescueMode: repair keeps the work when a check passed after the first edit, the evidence that part of it holds.
// With no such pass the edits are not progress, so the builder starts again from the original code.
export function rescueMode(firstEditAt: number | null, passedAt: number[]): RescueMode {
  return firstEditAt !== null && passedAt.some((t) => t > firstEditAt) ? 'repair' : 'restart'
}

export interface RescueBrief {
  family: Family
  mode: RescueMode
  because: string
  packet: string             // the evidence packet (lib/handoff.ts): goal, corrections, acceptance, failures, diff
  passedChecks: string[]     // checks that passed after the first edit
  remainingUsd: number | null
}

// rescueNote: the instruction to the main session. It never moves this conversation to the builder.
export function rescueNote(b: RescueBrief): string {
  const start = b.mode === 'repair'
    ? `Mode: repair. Keep the current changes: these checks passed after the first edit: ${b.passedChecks.slice(0, 5).join('; ')}. Fix what still fails.`
    : 'Mode: restart. No check passed after the edits, so they are not progress. The builder implements the goal from the original code.'
  const budget = b.remainingUsd === null ? '' : ` The task has $${b.remainingUsd.toFixed(2)} of its budget left.`
  // Subagents may not run git writes, so the main session sets the tree aside before a restart.
  const first = b.mode === 'restart' ? ' First run `git stash push -u -m automode-failed-attempt` yourself: the stash keeps the attempt for reference.' : ''
  return [
    `[AutoMode: ${b.because}. Do not continue this attempt in this conversation.${first} Then call the Agent tool with subagent_type "automode:implementer" and model "${b.family}", wait for it, and give it this brief:`,
    start,
    b.packet,
    `When it returns, run the failing check once and report the result.${budget}]`,
  ].join('\n\n')
}

// builderNote (builder: on): non-trivial work goes to one builder subagent at the routed model from the start.
export const builderNote = (family: Family) =>
  `Hand the implementation to one builder: call the Agent tool with subagent_type "automode:implementer" and model "${family}", give it the whole request, the acceptance criteria and any correction the person made, and wait for it. Then run the checks yourself and report.`
