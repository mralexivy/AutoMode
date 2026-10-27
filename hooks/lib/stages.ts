// Workflow stage selection: which V2 stages a task needs. The V2 workflow runs only with a stated
// purpose (strategy.ts); when it runs, it runs only the stages the demand calls for. Verification always
// runs. Review is added by consequence, and the workflow also runs it whenever one of its own mandatory
// rules fires, so leaving it out here can never skip a required review.
import type { Demand } from './optimizer.ts'

export type Stage = 'discover' | 'architect' | 'implement' | 'verify' | 'review'
export const ALL_STAGES: Stage[] = ['discover', 'architect', 'implement', 'verify', 'review']

export function stagesFor(d: Demand, opts: { userAsked?: boolean; manyFiles?: boolean } = {}): Stage[] {
  if (opts.userAsked) return ALL_STAGES // am:run: the person asked for the whole workflow
  const out: Stage[] = []
  if (opts.manyFiles || d.steps >= 19) out.push('discover')
  // Architecture-heavy: an Opus plan pays for itself before a cheaper implementer builds it.
  if (d.difficulty >= 3.6 || d.reasoning >= 3.8 || d.planning) out.push('architect')
  out.push('implement', 'verify')
  if (d.verification === 'review') out.push('review')
  return out
}
