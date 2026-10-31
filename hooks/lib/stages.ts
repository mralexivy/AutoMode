// Workflow stage selection: which V2 stages a task needs. The V2 workflow runs only with a stated
// purpose (strategy.ts); when it runs, it runs only the stages the demand calls for. Verification always
// runs. Review is added by consequence, and the workflow also runs it whenever one of its own mandatory
// rules fires, so leaving it out here can never skip a required review.
import type { Demand } from './optimizer.ts'
import type { Complexity, Risk } from './types.ts'

export type Stage = 'discover' | 'architect' | 'implement' | 'verify' | 'review'
export const ALL_STAGES: Stage[] = ['discover', 'architect', 'implement', 'verify', 'review']

export function stagesFor(d: Demand, opts: { userAsked?: boolean; manyFiles?: boolean; reviewRequired?: boolean } = {}): Stage[] {
  if (opts.userAsked) return ALL_STAGES // am:run: the person asked for the whole workflow
  const out: Stage[] = []
  if (opts.manyFiles || d.steps >= 19) out.push('discover')
  // Architecture-heavy: an Opus plan pays for itself before a cheaper implementer builds it.
  if (d.difficulty >= 3.6 || d.reasoning >= 3.8 || d.planning) out.push('architect')
  out.push('implement', 'verify')
  // The envelope can require a review that the demand does not: many edits, or no adequate model.
  if (d.verification === 'review' || opts.reviewRequired) out.push('review')
  return out
}

// workflowArgs: the args the router tells the main session to send to the workflow. The tier is the
// task's real one, because a fixed "complex" put every task in band S2.
export function workflowArgs(i: { demand: Demand | null; userAsked: boolean; risk: Risk; complexity: Complexity; reviewRequired: boolean; mode: string; reviewPolicy: string; maxConcurrency: number }) {
  const stages = i.demand ? stagesFor(i.demand, { userAsked: i.userAsked, reviewRequired: i.reviewRequired }) : undefined
  return {
    task: '<the full task with every constraint>', tier: i.risk === 'critical' ? 'critical' : i.complexity, mode: i.mode,
    reviewPolicy: i.reviewRequired ? 'always' : i.reviewPolicy, maxConcurrency: i.maxConcurrency, ...(stages ? { stages } : {}),
  }
}
