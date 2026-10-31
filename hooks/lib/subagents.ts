// Subagent model policy. bench/subagents.mts measures, on your own transcripts, how much subagent spend comes from
// built-in general-purpose and Explore subagents that inherited Opus from the main session. A subagent gets a scoped task and returns to a
// session that checks its work, so Sonnet (or Haiku for read-only search) is adequate for these built-in
// types. The policy touches only built-in types with no model chosen: a plugin or user agent may pin its
// model in its definition, which this hook cannot see, so those are never overridden; planners,
// architects and reviewers keep their model. Task risk raises this policy: subagents inherit no context, so
// they get the risk as an input. The diagnoser is this mod's own agent, so the policy may set its model.
import type { Effort, Family, Risk } from './types.ts'
import type { Demand } from './optimizer.ts'
import { maxEffort } from './effort.ts'

export interface SubagentRoute { model: Family; effort: Effort; why: string }

const READS = /^\s*(find|search|list|map|locate|trace|read|summari[sz]e|explain|show|count|which|where|what|how|does|look)\b/i
const WRITES = /\b(?:re|over|un)?(fix|edit|chang|writ|implement|add|remov|delet|updat|refactor|renam|creat|modif|replac|apply|commit|migrat|patch|install|rotat|revert|run|make|correct|resolv|set|build|generat|mov|drop|purg|bump)/i
const CLAUSES = /[.;:!?]\s+|\n+|,?\s+(?:and|then|but|so)\s+|,\s+/i

// readOnlyTask reads the subagent's prompt, because a general-purpose agent has every tool. It says yes
// only when every clause opens with a read and the text names no write. A wrong no costs money, a wrong
// yes costs quality on critical work, so anything less than clear counts as a write.
export function readOnlyTask(prompt: string): boolean {
  if (!prompt.trim() || WRITES.test(prompt)) return false
  return prompt.split(CLAUSES).map((c) => c.trim()).filter(Boolean).every((c) => READS.test(c))
}

// subagentEffort: the policy is a floor under the helper judge's pick. A failed judge gives the helper
// floor, so the policy effort stands.
export function subagentEffort(policy: Effort, helper?: Effort | null): Effort {
  return helper ? maxEffort(policy, helper) : policy
}

export function subagentRoute(i: { type: string; explicitModel?: string; parentFamily: Family | null; demand: Demand | null; risk?: Risk; prompt?: string }): SubagentRoute | null {
  if (i.explicitModel) return null
  if (i.type === 'Explore') return { model: 'haiku', effort: 'medium', why: 'read-only search: Haiku' }
  // Diagnosis decides correctness, so risky work does not leave it to Haiku.
  if (i.type === 'automode:diagnoser') return !i.risk || i.risk === 'none' ? null : { model: 'sonnet', effort: 'medium', why: `diagnosis on ${i.risk} work: Sonnet` }
  if (i.type !== 'general-purpose') return null
  const d = i.demand
  // The subagent's share of a hard task can still be hard: effort follows the task's demand.
  const demanded: Effort = !d ? 'high' : d.difficulty >= 3.6 || d.reasoning >= 3.9 ? 'xhigh' : d.difficulty >= 3.0 ? 'high' : 'medium'
  const critical = i.risk === 'critical'
  const effort = critical ? maxEffort(demanded, 'high') : demanded
  if (critical && i.parentFamily && !readOnlyTask(i.prompt ?? '')) return { model: i.parentFamily, effort, why: `general-purpose subagent on critical work: keeps ${i.parentFamily} ${effort}` }
  if (i.parentFamily !== 'opus') return null
  return { model: 'sonnet', effort, why: `general-purpose subagent of an Opus session: Sonnet ${effort}` }
}
