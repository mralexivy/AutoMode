// Subagent model policy. bench/subagents.mjs measures, on your own transcripts, how much subagent spend comes from
// built-in general-purpose and Explore subagents that inherited Opus from the main session. A subagent gets a scoped task and returns to a
// session that checks its work, so Sonnet (or Haiku for read-only search) is adequate for these built-in
// types. The policy touches only built-in types with no model chosen: a plugin or user agent may pin its
// model in its definition, which this hook cannot see, so those are never overridden; planners,
// architects and reviewers keep their model.
import type { Effort, Family } from './types.ts'
import type { Demand } from './optimizer.ts'

export interface SubagentRoute { model: 'haiku' | 'sonnet'; effort: Effort; why: string }

export function subagentRoute(i: { type: string; explicitModel?: string; parentFamily: Family | null; demand: Demand | null }): SubagentRoute | null {
  if (i.explicitModel) return null
  if (i.type === 'Explore') return { model: 'haiku', effort: 'medium', why: 'read-only search: Haiku' }
  if (i.type !== 'general-purpose' || i.parentFamily !== 'opus') return null
  const d = i.demand
  // The subagent's share of a hard task can still be hard: effort follows the task's demand.
  const effort: Effort = !d ? 'high' : d.difficulty >= 3.6 || d.reasoning >= 3.9 ? 'xhigh' : d.difficulty >= 3.0 ? 'high' : 'medium'
  return { model: 'sonnet', effort, why: `general-purpose subagent of an Opus session: Sonnet ${effort} (inherited Opus was 73% of measured subagent spend)` }
}
