// Routing authority: generate, then constrain. One pipeline decides every effective route:
//   1 hard choices (user override, pinned workflow role) are final
//   2 the quality floor is the minimum tier and is never lowered later
//   3 a candidate (judge, continuation, rules, fallback) is lifted to the floor
//   4 the switch check (cache policy) answers switch or hold, never below the floor
//   5 the effective route records its owner, reason, floor, candidate and check
import type { Candidate, EffectiveRoute, Effort, Family, Floor, Owner, Route, Tier } from './types.ts'
import { tierRank } from './types.ts'
import type { SwitchInput } from './policy.ts'
import { switchCheck, tierAtLeast } from './policy.ts'

export interface Ladder { models: Record<Family, string>; tiers: Record<Tier, { family: Family; effort: Effort }> }

export const DEFAULT_LADDER: Ladder = {
  models: { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' },
  tiers: {
    T0: { family: 'haiku', effort: 'low' },
    T1: { family: 'sonnet', effort: 'medium' },
    T2: { family: 'sonnet', effort: 'high' },
    T3: { family: 'opus', effort: 'high' },
    T4: { family: 'opus', effort: 'max' },
  },
}

export function routeFor(tier: Tier, ladder: Ladder = DEFAULT_LADDER, effort?: Effort): Route {
  const t = ladder.tiers[tier]
  return { tier, family: t.family, model: ladder.models[t.family], effort: effort ?? t.effort }
}

export interface AuthorityInput {
  override?: { tier?: Tier; effort?: Effort; reason: string }
  workflowRole?: { tier: Tier; reason: string }
  floor: Floor
  candidate: Candidate
  effortHint?: Effort                       // the optimizer's effort within the tier's model
  heldEffort?: Effort                       // the effort the CURRENT model should run at for this prompt, if the model switch is held
  // Policy auto (from v4.1): output per request and steps per request by configuration, so the switch check prices each as it will run.
  effortCost?: { output: (r: Route) => number; steps: (r: Route) => number }
  currentInadequate?: boolean               // policy auto: the running model is ruled out for the task, so a stronger one switches at once
  current: Route | null
  switchInput: Omit<SwitchInput, 'current' | 'candidate' | 'target' | 'floor' | 'mandatory'>
  ladder?: Ladder
}

export function resolve(i: AuthorityInput, resetSinceLastRequest = false): EffectiveRoute {
  const ladder = i.ladder ?? DEFAULT_LADDER
  const overridden: { owner: Owner; reason: string }[] = []

  if (i.override?.tier || i.override?.effort) {
    const tier = i.override.tier ?? i.current?.tier ?? i.candidate.tier
    const r = routeFor(tier, ladder, i.override.effort)
    if (tierRank(tier) < tierRank(i.floor.tier)) overridden.push({ owner: 'quality-escalation', reason: `floor ${i.floor.tier} (${i.floor.because.join('; ')}) kept as a pending requirement` })
    return { ...r, owner: 'user-override', reason: i.override.reason, floor: i.floor, candidate: i.candidate, overridden }
  }
  if (i.workflowRole) {
    return { ...routeFor(i.workflowRole.tier, ladder), owner: 'workflow-role', reason: i.workflowRole.reason, floor: i.floor, candidate: i.candidate, overridden }
  }

  const lifted = tierAtLeast(i.candidate.tier, i.floor)
  const floorMandatory = tierRank(i.floor.tier) > 0 && tierRank(lifted) === tierRank(i.floor.tier) && (!i.current || tierRank(i.current.tier) < tierRank(i.floor.tier))
  // Quality first: when the running configuration is below the need, moving up is not a discretionary upgrade.
  const mandatory = floorMandatory || !!i.currentInadequate
  if (lifted !== i.candidate.tier) overridden.push({ owner: i.candidate.source === 'judge' ? 'judge' : i.candidate.source, reason: `${i.candidate.tier} lifted to floor ${i.floor.tier}` })
  // The optimizer's effort applies within the candidate's model. A floor-lifted tier takes the tier's
  // own effort, never a lower one from the candidate.
  // A floor that names its own effort (an escalation step, policy auto) lifts to that effort, not the ladder's.
  const tierEffort = lifted === i.floor.tier && i.floor.effort ? i.floor.effort : ladder.tiers[lifted].effort
  const effort = lifted !== i.candidate.tier ? tierEffort : i.effortHint ?? tierEffort
  const target = routeFor(lifted, ladder, effort)
  const priced = i.effortCost && i.current
    ? { expectedOutputTokens: i.effortCost.output(i.current), targetOutputTokens: i.effortCost.output(target), targetStepRatio: i.effortCost.steps(target) / i.effortCost.steps(i.current) }
    : {}
  const check = switchCheck({ ...i.switchInput, ...priced, current: i.current, candidate: i.candidate, target, floor: i.floor, mandatory }, resetSinceLastRequest)

  if (check.verdict === 'switch') {
    const owner: Owner = mandatory ? 'quality-escalation' : i.candidate.source === 'judge' ? 'judge' : i.candidate.source
    const reason = floorMandatory ? `floor ${i.floor.tier}: ${i.floor.because.join('; ')}` : mandatory ? `the running route is below the need: ${i.candidate.reason}` : i.candidate.reason
    return { ...target, owner, reason, floor: i.floor, candidate: i.candidate, check, overridden }
  }
  // Hold: the model stays (never below the floor; the floor case always switches). The effort does not:
  // a held model still runs each prompt at the effort that prompt needs, because an effort change keeps
  // the cache where the provider shares it. Where the provider splits the cache by effort (gate
  // provider-effort) the warm effort stays until a low-penalty point, as effortFor applies it.
  const keep = i.current ?? target
  const heldAt = i.current && i.heldEffort && check.gate !== 'provider-effort' ? i.heldEffort : keep.effort
  overridden.push({ owner: i.candidate.source === 'judge' ? 'judge' : i.candidate.source, reason: `held by ${check.gate}: ${target.tier}/${target.effort}` })
  return { ...keep, effort: heldAt, owner: 'cache-policy', reason: `hold (${check.gate})${heldAt !== keep.effort ? `, effort ${heldAt}` : ''}`, floor: i.floor, candidate: i.candidate, check, overridden }
}
