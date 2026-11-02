// AutoMode Auto (policy `auto`): one joint model x effort decision.
//
// The task decides the route, not the model the session started on.
//
// Evidence, and only this evidence, decides the route:
//   need             One effortless answer with a fixed anchor: Current: sonnet (A9 in lib/effortless-adapt.ts). It is
//                    the only answer whose `model` counts. Effortless asks for "the cheapest pair that will still do the
//                    job well" relative to Current, so an answer about the running model moves with the start model.
//   own verdict      An effortless answer about one model gives that model's effort and nothing else. A verdict is used
//                    only for the model it was asked about: no conversion between models.
//   AutoMode judge   (lib/classify.ts, contract v2) gives difficulty (tier), complexity, risk and consequence.
//
// Eligibility rules (explicit, no numbers, no success rates). They read `need`, the tier and the consequence:
//   Opus required   T4, a Fable verdict, T3 plus critical, or T3 plus need=opus. An escalation floor also requires it, by
//                   excluding the models that cannot reach its step (AutoFloors.exclude).
//   Haiku           Both judges must name it: need=haiku and T0. An effort verdict alone never makes Haiku eligible.
//   Sonnet          Everything else. One judge's model name never forces Opus: T1 with need=opus runs on Sonnet.
//   Opus            Always eligible, so a running Opus can hold. It runs only when no weaker model is eligible.
// The effort comes from the chosen model's own verdict, within its floors. Price is only a tie-break: it decides between
// Haiku and Sonnet when both are eligible, and never brings Opus in. resolve() then decides hold or switch with the real
// cache economics. Nothing eligible: the strongest available model, labeled inadequate.
// A failed AutoMode judge leaves T3 unknown, so need=opus still rules out the weaker models there.
// Hard work never runs Opus below high: T4 or a Fable verdict, which Opus must carry since the router has no Fable route.
// A verdict's effort for Fable-level work is understated for Opus (the judge prompt asks for lower effort on Fable). An
// explicit user effort still wins.
// Pure: no `$`, no I/O.
import type { Complexity, Effort, Family, Risk, Tier } from './types.ts'
import { EFFORTS, tierRank } from './types.ts'
import { bounded, type ModelKey } from './effortless.ts'
import { NEED_ANCHOR } from './effortless-adapt.ts'

export interface FamilyVerdict { model: ModelKey; effort: Effort; why: string; sure?: number }
export type Eligibility = 'eligible' | 'ineligible' | 'unavailable' | 'needs-verdict'

export interface AutoCandidate {
  family: Family
  effort: Effort
  verdictEffort?: Effort        // what the effortless judge said for this model, before floors
  eligibility: Eligibility
  why: string[]
  attemptUsd: number
}
export interface AutoChoice { best: AutoCandidate; candidates: AutoCandidate[]; inadequate: boolean; rule: string }

export interface AutoFloors {
  effortMin?: Partial<Record<Family, Effort>>  // quality floors per model (escalation, consequence, challenge)
  exclude?: Partial<Record<Family, string>>    // models a floor rules out, with the reason
  fixedEffort?: Effort                         // an explicit user effort command
  fixedFamily?: Family                         // an explicit user model command, or the model kept on a failed judge
  because: string[]
}
export interface AutoInput {
  allowed: Family[]                                        // after provider constraints (breakers, Haiku guards)
  verdicts: Partial<Record<Family, FamilyVerdict | null>>  // the effortless answer asked ABOUT each model; null: failed
  need: FamilyVerdict | null                               // the fixed-anchor answer; null: it failed
  hm: { tier: Tier; complexity: Complexity } | null        // null: the AutoMode judge failed
  consequence?: Risk
  floors: AutoFloors
  current: { family: Family; effort: Effort } | null
  cost: (family: Family, effort: Effort) => number         // one attempt, cache-neutral (optimizer.attemptCost)
}

const RANK: Record<ModelKey, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }
const FAMILIES: Family[] = ['haiku', 'sonnet', 'opus'] // cheapest first
const at = (e: Effort) => EFFORTS.indexOf(e)
export const maxEffort = (a: Effort, b: Effort): Effort => (at(a) >= at(b) ? a : b)
export const hmModel = (t: Tier): Family => (t === 'T0' ? 'haiku' : t === 'T1' || t === 'T2' ? 'sonnet' : 'opus')

// effortlessFloor: the rank of the model the need names. No other effortless answer counts.
export const effortlessFloor = (need: FamilyVerdict | null): number | null => (need ? RANK[need.model] : null)

// effortMinFor: the quality floor for one model, with the hard-work floor for Opus on top of the caller's floors.
function effortMinFor(family: Family, i: Pick<AutoInput, 'need' | 'hm' | 'floors'>): Effort | undefined {
  const floor = i.floors.effortMin?.[family]
  const hard = i.hm?.tier === 'T4' || effortlessFloor(i.need) === RANK.fable
  return family === 'opus' && hard ? maxEffort(floor ?? 'low', 'high') : floor
}

type Evidence = Pick<AutoInput, 'need' | 'hm' | 'consequence'>

// opusRequired: why this task rules out every weaker model, or null.
function opusRequired(i: Evidence): string | null {
  const tier = i.hm?.tier
  if (tier === 'T4') return 'T4: a focused attempt already failed'
  if (i.need?.model === 'fable') return 'a fable verdict: opus carries it'
  if (tier === 'T3' && i.consequence === 'critical') return 'T3 on critical work'
  if (tier === 'T3' && i.need?.model === 'opus') return 'T3 and the need names opus'
  if (!i.hm && i.need?.model === 'opus') return 'the need names opus and the automode judge did not answer'
  return null
}

// eligibilityOf applies the rules above to one model. It never reads an own verdict, so the verdicts a session happens
// to hold cannot change the answer.
export function eligibilityOf(family: Family, i: Evidence): { eligibility: Eligibility; why: string[] } {
  if (!i.need) {
    const missing = family === 'opus' ? null : opusRequired(i)
    return missing ? { eligibility: 'ineligible', why: ['no effortless answer yet', missing] } : { eligibility: 'needs-verdict', why: ['no effortless answer yet'] }
  }
  const why = [`effortless: the need names ${i.need.model}`]
  if (i.hm) why.push(`automode: ${i.hm.tier} (${hmModel(i.hm.tier)})`)
  if (family === 'opus') return { eligibility: 'eligible', why: [...why, 'opus: the strongest model'] }
  const required = opusRequired(i)
  if (required) return { eligibility: 'ineligible', why: [...why, required] }
  if (family === 'sonnet') return { eligibility: 'eligible', why: [...why, 'sonnet: no rule requires opus'] }
  if (!i.hm) return { eligibility: 'ineligible', why: [...why, 'haiku needs both judges; the automode judge did not answer'] }
  return i.need.model === 'haiku' && i.hm.tier === 'T0' ? { eligibility: 'eligible', why: [...why, 'both judges name haiku'] } : { eligibility: 'ineligible', why: [...why, 'haiku needs both judges'] }
}

// firstCalls: the effortless calls that run beside the AutoMode judge. The first one gives the need. The running model
// is also asked when it differs, so a hold has its own effort. A fixed model needs only its own verdict.
export function firstCalls(fixedFamily: Family | undefined, running: Family | undefined): Family[] {
  if (fixedFamily) return [fixedFamily]
  return running && running !== NEED_ANCHOR ? [NEED_ANCHOR, running] : [NEED_ANCHOR]
}

// secondCall: the one model a second effortless call should be asked about, or null. Asked only when that model
// could win: it is eligible (or awaits its verdict) and either the anchor model is out, or it is cheaper than the
// anchor. At most one extra call per decision.
export function secondCall(i: AutoInput, anchor: Family): Family | null {
  if (i.floors.fixedFamily) return null
  const ok = (f: Family) => i.allowed.includes(f) && !i.floors.exclude?.[f]
  const st = (f: Family) => eligibilityOf(f, i).eligibility
  const anchorOk = ok(anchor) && st(anchor) === 'eligible'
  for (const f of FAMILIES) {
    if (f === anchor || i.verdicts[f] !== undefined || !ok(f)) continue
    const e = st(f)
    if (e !== 'eligible' && e !== 'needs-verdict') continue
    if (!anchorOk || RANK[f] < RANK[anchor]) return f
  }
  return null
}

// runningRuledOut: must the session leave its running model now? A provider limit, a quality floor and an escalation
// say so. T4 counts as escalation evidence, because a focused attempt already failed. Haiku out of its rule means real
// work on Haiku. Any other upgrade from the judges goes through the normal gate in the switch check.
export function runningRuledOut(family: Family | undefined, choice: AutoChoice, floors: AutoFloors, hm: AutoInput['hm']): boolean {
  const own = family ? choice.candidates.find((c) => c.family === family) : undefined
  if (!own) return false
  if (own.eligibility === 'unavailable') return true
  return own.eligibility === 'ineligible' && (!!floors.exclude?.[own.family] || hm?.tier === 'T4' || own.family === 'haiku')
}

// ownEffort: the effort a hold runs the running model at, when the optimizer worked one out. It holds the same rules as
// any other route (floors, T3 and T4 never at low), also for a model the rules rule out.
export function ownEffort(own: AutoCandidate | undefined): Effort | undefined {
  return own && (own.verdictEffort || (own.eligibility === 'eligible' && Number.isFinite(own.attemptUsd))) ? own.effort : undefined
}

// optimizeAuto: the weakest model the rules allow, at its own effort. No retry charge, no score.
export function optimizeAuto(i: AutoInput): AutoChoice {
  const families = i.floors.fixedFamily ? [i.floors.fixedFamily] : FAMILIES
  const candidates: AutoCandidate[] = families.map((family) => {
    const v = i.verdicts[family]
    if (!i.allowed.includes(family)) return { family, effort: v?.effort ?? 'medium', eligibility: 'unavailable', why: ['not available now (breaker or Haiku guard)'], attemptUsd: Infinity }
    const excludedBy = i.floors.exclude?.[family]
    if (excludedBy && !i.floors.fixedFamily) return { family, effort: v?.effort ?? 'medium', eligibility: 'ineligible', why: [excludedBy], attemptUsd: Infinity }
    const e = i.floors.fixedFamily ? { eligibility: 'eligible' as Eligibility, why: ['the model is fixed (a command, routeModels false, or a failed judge)'] } : eligibilityOf(family, i)
    if (!v && !i.floors.fixedEffort) return { family, effort: 'medium', eligibility: e.eligibility === 'eligible' ? 'needs-verdict' : e.eligibility, why: [...e.why, 'no effort verdict for this model'], attemptUsd: Infinity }
    // Upstream bounded(): the verdict's effort within the quality floor for this model.
    let effort = v ? v.effort : i.floors.fixedEffort!
    const notes = [...e.why]
    const min = effortMinFor(family, i)
    if (min && at(effort) < at(min)) { effort = bounded(effort, min, 'max'); notes.push(`floor ${min}`) }
    // The judges disagree on the effort: the AutoMode judge rates the task T3 or T4 and effortless says low.
    // The conservative side wins: medium. Recorded.
    if (v && i.hm && tierRank(i.hm.tier) >= 3 && effort === 'low') { effort = 'medium'; notes.push('judges disagree (T3/T4 task, low effort): medium') }
    if (i.floors.fixedEffort) { if (effort !== i.floors.fixedEffort) notes.push(`user effort ${i.floors.fixedEffort}`); effort = i.floors.fixedEffort }
    return { family, effort, ...(v ? { verdictEffort: v.effort } : {}), eligibility: e.eligibility, why: notes, attemptUsd: e.eligibility === 'eligible' ? i.cost(family, effort) : Infinity }
  })
  const usable = candidates.filter((c) => c.eligibility === 'eligible' && Number.isFinite(c.attemptUsd))
  // Opus runs only when no weaker model can. Between Haiku and Sonnet the price breaks the tie; on a tie of price the
  // running model (its cache), then the lower effort.
  const weaker = usable.filter((c) => c.family !== 'opus')
  const field = weaker.length ? weaker : usable
  const order = (a: AutoCandidate, b: AutoCandidate) => a.attemptUsd - b.attemptUsd || Number(b.family === i.current?.family) - Number(a.family === i.current?.family) || at(a.effort) - at(b.effort)
  if (field.length) return { best: field.sort(order)[0], candidates, inadequate: false, rule: field.length > 1 ? 'cheapest eligible pair' : 'the weakest eligible model' }
  // Nothing eligible with a known effort: the strongest available model, labeled inadequate when it was not eligible.
  // With no need there is no evidence for Opus: Sonnet runs, unless a rule rules it out.
  const pool = candidates.filter((c) => c.eligibility !== 'unavailable')
  const waiting = i.need ? undefined : pool.find((c) => c.family === 'sonnet' && c.eligibility === 'needs-verdict')
  const strongest = waiting ?? (pool.length ? pool : candidates).slice().sort((a, b) => RANK[b.family] - RANK[a.family])[0]
  const floored = maxEffort(i.verdicts[strongest.family]?.effort ?? i.current?.effort ?? 'high', effortMinFor(strongest.family, i) ?? 'low')
  // The same rule as above: a T3 or T4 task never runs at low, on the last model standing either.
  const effort = i.floors.fixedEffort ?? (i.hm && tierRank(i.hm.tier) >= 3 ? maxEffort(floored, 'medium') : floored)
  const best ={ ...strongest, effort, attemptUsd: i.cost(strongest.family, effort) }
  const inadequate = strongest.eligibility !== 'eligible' && strongest.eligibility !== 'needs-verdict'
  return { best, candidates, inadequate, rule: inadequate ? 'no eligible model: the strongest available, labeled inadequate' : waiting ? 'no need: sonnet at its known or running effort' : 'no effort verdict for an eligible model: the strongest available at its known or running effort' }
}

// fallbackModel: the effortless judge failed. The remaining judge decides the model, as the legacy policy does in
// production: the AutoMode judge's model at its own effort, up or down, when it is available. A critical task never
// goes to Haiku, and a judge below the confidence floor never moves the route cheaper (jev-router). Both judges failed:
// the model stays.
export function fallbackModel(keep: Family, hm: { tier: Tier; effort?: Effort; confidence?: number } | null, allowed: Family[], consequence?: Risk, minConfidence = 0): { family: Family; effort?: Effort; why: string } {
  if (!hm) return { family: keep, why: 'both judges failed: the model stays' }
  let need = hmModel(hm.tier)
  if (need === 'haiku' && consequence === 'critical') need = 'sonnet'
  const down = RANK[need] < RANK[keep]
  if (down && (hm.confidence ?? 1) < minConfidence) return { family: keep, why: `the AutoMode judge names ${need} with low confidence: the ${keep} model stays` }
  if (need !== keep && allowed.includes(need)) return { family: need, effort: hm.effort, why: `the effortless judge failed: the AutoMode judge decides (${hm.tier}: ${need})` }
  return { family: keep, why: `the effortless judge failed; the AutoMode judge names ${need}: the ${keep} model stays` }
}

// ---------------------------------------------------------------- resolution order, step 4: is a new decision required?
export interface Transitions {
  newTask: boolean; planEntered: boolean; planExited: boolean; riskChanged: boolean; scopeGrew: boolean
  escalation: boolean; command: boolean; compacted: boolean; effortFixCleared: boolean; stageChanged: boolean
}
export function decisionRequired(t: Partial<Transitions>): { required: boolean; why: string[] } {
  const why = (Object.keys(t) as (keyof Transitions)[]).filter((k) => t[k])
  return { required: why.length > 0, why }
}

// Step 5: the upstream shortcut. A short "go" between two steps keeps the unfinished task's effort with no judge
// call, but only when step 4 requires no new decision. Acknowledgments, "done", commit and push are not steering
// words: they go to the judge, whose prompt rates a closing remark low (the fix for "ok" inheriting xhigh).
const NOT_STEERING = /^(?:ok(?:ay)?|thanks?(?: you)?|thx|great|nice|perfect|cool|good|done|hello|hi|hey|commit|push|merge|rebase)[.!\s]*$/i
export function shortcutApplies(keeps: boolean, text: string, required: { required: boolean }): boolean {
  return keeps && !required.required && !NOT_STEERING.test(text.trim())
}

// ---------------------------------------------------------------- judge failure, state-aware
export interface FallbackInput {
  sameTask: boolean; sameStage: boolean; riskChanged: boolean; planBoundary: boolean
  previous: { family: Family; effort: Effort } | null
  previousAdequate: boolean
  appEffort: Effort | undefined
  escalation: { family: Family; effort: Effort } | null
  effortMin?: Effort
}
export function fallbackEffort(i: FallbackInput): { effort: Effort; source: string } {
  if (i.escalation) return { effort: i.escalation.effort, source: 'escalation applies without a judge' }
  const floor = i.effortMin ?? 'low'
  if (i.previous && i.sameTask && i.sameStage && !i.riskChanged && !i.planBoundary && i.previousAdequate)
    return { effort: maxEffort(i.previous.effort, floor), source: 'judge failed: same task and stage, previous effort kept (upstream)' }
  const app = i.appEffort ?? 'medium'
  return { effort: maxEffort(app, floor), source: i.previous ? 'judge failed on a changed task or stage: the app effort within the floors' : 'judge failed with no previous decision: the app effort within the floors' }
}

// ---------------------------------------------------------------- application: requested, legal and effective effort
// Anthropic per-message effort (docs, 2026-10): a change placed after a user turn that holds only tool_result blocks
// waits for the next user turn with new input. So inside a turn a changed effort is requested at once but becomes
// effective only at a request that carries new input: the turn's first step, a step after a message typed mid-turn,
// or a step after a tool result this mod gave a `context` note. Where the provider has no per-message effort, the
// top-level value applies at once (and restarts the cache).
export interface LegalInput { index: number; newInput: boolean; perMessage: boolean; requested: Effort; lastEffective: Effort | null; modelChanged?: boolean }
export function legalEffort(i: LegalInput): { effective: Effort; legalAt: string; deferred: boolean } {
  if (!i.perMessage) return { effective: i.requested, legalAt: 'top-level effort: applies to this request', deferred: false }
  // A model change rewrites the prompt for the new model: its top-level effort applies at once.
  if (i.modelChanged) return { effective: i.requested, legalAt: 'model change: the new model starts at this effort', deferred: false }
  if (i.lastEffective === null || i.requested === i.lastEffective) return { effective: i.requested, legalAt: 'no change', deferred: false }
  if (i.index === 0) return { effective: i.requested, legalAt: 'first step of the turn: new user input', deferred: false }
  if (i.newInput) return { effective: i.requested, legalAt: 'step after new input in the turn', deferred: false }
  return { effective: i.lastEffective, legalAt: 'tool-result continuation: takes effect at the next new input', deferred: true }
}
