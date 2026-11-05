// The policy-auto route as one pure function. decideAuto in hooks/v4.ts gathers the facts, makes the judge calls and
// applies the side effects. This module turns the facts into the route.
//
// Contract:
// - No `$`, no module state, no I/O. The input is plain data with no functions in it, so a record of it can be replayed.
// - planAuto gives the floors, the judge-failure fallback and the model the second effortless call is about.
//   decideAuto makes that call, adds the verdict to `verdicts`, names it in `second` and calls routeAuto.
// - routeAuto runs planAuto again on the full verdicts, then the optimizer, resolve() and the Opus consult. The second
//   verdict cannot change the plan: it is about a model with no verdict, never the anchor or the running model.
// - Costs come from a snapshot table. `null` stands for a configuration with no finite price.
import type { CacheState, Complexity, EffectiveRoute, Effort, Family, Floor, Risk, Route, Tier } from './types.ts'
import { EFFORTS, tierRank } from './types.ts'
import type { Stage } from './stage.ts'
import type { JudgeAnswer } from './classify.ts'
import type { PriceRow } from './prices.ts'
import type { Rent } from './rent.ts'
import { BAND_OF, TIER_BAND } from './bands.ts'
import { DEFAULT_PARAMS, remainingFor, switchCheck, type SwitchInput } from './policy.ts'
import { resolve } from './authority.ts'
import { consultOrSwitch } from './strategy.ts'
import { executorEffort } from './executor.ts'
import { TASK_STEPS, tierOf } from './optimizer.ts'
import { maxEffort } from './effort.ts'
import { bucketOf } from './learn.ts'
import { fnv1a } from './failures.ts'
import { eligibilityOf, fallbackEffort, fallbackModel, optimizeAuto, ownEffort, runningRuledOut, secondCall, type AutoChoice, type AutoFloors, type FamilyVerdict } from './auto.ts'

export const AUTO_ROUTE_SCHEMA = 1
// jev-router config.mjs THRESHOLDS.minConfidence (commit 38da6b8)
export const LOW_CONFIDENCE = 0.3

const FAMILIES: Family[] = ['haiku', 'sonnet', 'opus']
const CHEAPER: Record<Family, Family[]> = { haiku: [], sonnet: ['haiku'], opus: ['haiku', 'sonnet'] }

export type Verdicts = Partial<Record<Family, FamilyVerdict | null>>
export type LadderFloor = { family: Family; effort: Effort; band: number; because: string }

// FloorFacts: what the mandatory-quality floors read about the task and the session.
export interface FloorFacts {
  taskId: string
  risk: Risk
  riskReasons: string[]
  ladderFloor: LadderFloor | null
  taskDecision: { taskId: string; family: Family; effort: Effort } | null
  stayUp: number
  currentFamily: Family | null
}

export interface AutoRouteInput {
  schemaVersion: number
  now: number
  allowed: Family[]
  appFamily: Family
  fixedFamily?: Family
  fixedEffort?: Effort
  command?: { label: string }                       // a typed model or effort command: the route resolve() gives the person
  shortcut: boolean
  kept: { family: Family; effort: Effort } | null   // the unfinished task's decision, when the shortcut keeps it
  judge: Pick<JudgeAnswer, 'tier' | 'complexity' | 'effort' | 'confidence' | 'why'> | null
  judgeCached: boolean
  anchor: Family
  verdicts: Verdicts                                // as the judges answered, before any fallback
  second?: Family                                   // the model of the second effortless call, when it was made
  complexity: Complexity
  stage: Stage
  previousStage: Stage
  boundary: boolean
  riskChanged: boolean
  planBoundary: boolean
  planExited: boolean
  floor: FloorFacts
  current: { route: Route; running: Effort } | null
  usable: Route | null                              // the running route, unless its family is out
  appEffort?: Effort
  executor: { on: boolean; taskRoute: { family: Family; effort: Effort } | null }
  reachHaiku?: boolean
  opusOnEvidence?: boolean
  haikuFirst?: boolean
  start?: 'v6a' | 'v6b'
  learned: { on: boolean; opusBuckets: string[] }
  votes: { tier: Tier; n: number }
  switching: {
    cache: CacheState
    reset: boolean
    requestsSinceSwitch: number
    verifiedSinceSwitch: boolean
    switchesThisTask: number
    remainingTable: SwitchInput['remainingTable']
    warm: Record<Family, boolean>
    warmPrefix: Partial<Record<Family, number>>
    resetPrefixTokens?: number
    continuity: { provider: string; compacted: boolean; dropped: Partial<Record<Family, number>>; rent: Rent | null }
  }
  economics: {
    attempt: Record<Family, Record<Effort, number | null>>
    outputPerStep: Record<Family, number>
    effortOutput: Record<Effort, number>
    effortSteps: Record<Effort, number>
    prices: PriceRow
    calibrated: boolean
  }
  consult: { lastWorkBand?: number; consulted: string[]; packetTokens: number; ttlMs: number }
  policy: { lowConfidence: number }
}

export type VerdictNote = { family: Family; effort: Effort; fallback: string }

export interface AutoPlan {
  floors: AutoFloors
  tier: Floor
  escalated: { family: Family; effort: Effort } | null
  verdicts: Verdicts
  notes: VerdictNote[]
  fallback?: string
  ownFallback?: string
  learnedBucket?: string
  secondJudge: Family | null
  reasons: string[]
}

export interface AutoRouteResult extends Omit<AutoPlan, 'secondJudge'> {
  need: FamilyVerdict | null
  kept: FamilyVerdict | null
  choice: AutoChoice
  shadow: AutoChoice['best'] | null
  own: AutoChoice['candidates'][number] | undefined
  votes: { tier: Tier; n: number }
  resolved: EffectiveRoute
  route: EffectiveRoute
  lastWorkBand?: number
  consult: { key: string; choice: 'consult' | 'switch'; consultUsd: number; switchUsd: number; why: string } | null
}

// escalationStep: the floor the ladder set for this task, until a check passes.
export function escalationStep(floor: LadderFloor | null, allowed: Family[]): LadderFloor | null {
  return floor && (!allowed.length || allowed.includes(floor.family)) ? floor : null
}

// autoFloors: the mandatory-quality step as constraints on the candidates, and the same as a tier floor for resolve().
export function autoFloors(f: FloorFacts, complexity: Complexity, allowed: Family[], stage?: Stage): { floors: AutoFloors; tier: Floor; escalated: { family: Family; effort: Effort } | null } {
  const effortMin: Partial<Record<Family, Effort>> = {}
  const exclude: Partial<Record<Family, string>> = {}
  const because: string[] = []
  let tier: Floor = { tier: 'T0', because: [] }
  // Consequence: critical work that is not trivial gets at least Sonnet high, the v4 implementer floor, or Opus medium, its band.
  if (f.risk === 'critical' && complexity !== 'trivial') {
    const why = `critical consequence: ${f.riskReasons.slice(0, 2).join('; ') || 'observed'}`
    exclude.haiku = why
    effortMin.sonnet = 'high'
    effortMin.opus = 'medium'
    because.push(why)
    tier = { tier: 'T2', because: [why] }
  }
  // Defect escalation: one step up from the running route; every model must reach that step or it is out.
  const step = escalationStep(f.ladderFloor, allowed)
  if (step) {
    for (const x of FAMILIES) {
      const e = EFFORTS.find((y) => BAND_OF[x][y] >= step.band)
      if (!e) exclude[x] = step.because
      else effortMin[x] = maxEffort(effortMin[x] ?? 'low', e)
    }
    because.push(step.because)
    const t = tierOf(step.family, step.effort)
    if (tierRank(t) >= tierRank(tier.tier)) tier = { tier: t, effort: step.effort, band: step.band, because: [step.because] }
  }
  // A challenge to finished work ("are you sure", "you missed") keeps at least the configuration of the work it
  // challenges (v4.1, kept as a floor: upstream only asks its judge to). A model that cannot reach it is out.
  const td = f.taskDecision && f.taskDecision.taskId === f.taskId ? f.taskDecision : null
  if (stage === 'reconsider' && td) {
    const band = BAND_OF[td.family][td.effort]
    const why = `a challenge keeps the work's ${td.family} ${td.effort}`
    for (const x of FAMILIES) {
      const e = EFFORTS.find((y) => BAND_OF[x][y] >= band)
      if (!e) exclude[x] ??= why
      else effortMin[x] = maxEffort(effortMin[x] ?? 'low', e)
    }
    because.push(why)
  }
  // Upstream redo: after a "that's wrong" the next prompts stay on the chat's model, never a cheaper one.
  if (f.stayUp > 0 && f.currentFamily) for (const x of CHEAPER[f.currentFamily]) exclude[x] ??= `a redo keeps the model for ${f.stayUp} more prompts`
  return { floors: { effortMin, exclude, because }, tier, escalated: step ? { family: step.family, effort: step.effort } : null }
}

// executorInput: the optimizer's input under the Sonnet executor, or null where it does not apply. A fixed model (a pin,
// routeModels false, a failed judge) stays fixed. A floor that rules Sonnet out, such as an escalation, reaches Opus the
// usual way. taskRoute is the task's last route while its cache is warm.
export function executorInput(on: boolean, verdicts: Verdicts, floors: AutoFloors, taskRoute: { family: Family; effort: Effort } | null) {
  if (!on || floors.fixedFamily || floors.exclude?.sonnet) return null
  const effort = executorEffort(verdicts.sonnet?.effort, taskRoute?.family === 'sonnet' ? taskRoute.effort : undefined)
  return { verdicts: { ...verdicts, sonnet: { model: 'sonnet' as const, effort, why: 'executor' } }, floors: { ...floors, fixedFamily: 'sonnet' as const } }
}

// costOf: the cost function the optimizer takes, read from the snapshot table.
export const costOf = (attempt: AutoRouteInput['economics']['attempt']) => (family: Family, effort: Effort) => attempt[family][effort] ?? Infinity

// planAuto: floors, the judge-failure fallback, the low-confidence and learned exclusions, and the second call.
export function planAuto(i: AutoRouteInput): AutoPlan {
  const reasons: string[] = []
  const cur = i.current?.route ?? null
  const mq = autoFloors(i.floor, i.complexity, i.allowed, i.stage)
  let needTier: Floor = { tier: 'T0', because: [] }
  if (mq.floors.because.length) reasons.push(`floors: ${mq.floors.because.join('; ')}`)
  const floors: AutoFloors = { ...mq.floors, ...(i.fixedFamily ? { fixedFamily: i.fixedFamily } : {}), ...(i.fixedEffort ? { fixedEffort: i.fixedEffort } : {}) }
  let verdicts: Verdicts = { ...i.verdicts }
  const notes: VerdictNote[] = []
  const askedNeed = i.verdicts[i.anchor] ?? null
  const answer = i.judge

  // Judge failures, state-aware. A failed verdict for the running model is replaced from the fallback table, so a
  // failed call never moves the session to another model. A failed AutoMode judge keeps the model as well.
  let fallback: string | undefined
  let ownFallback: string | undefined // only the running model's effort failed: the need still decides the model
  if (!i.shortcut) {
    if (cur && !verdicts[cur.family] && (!i.fixedFamily || i.fixedFamily === cur.family)) {
      const fb = fallbackEffort({ sameTask: !i.boundary, sameStage: i.stage === i.previousStage, riskChanged: i.riskChanged, planBoundary: i.planBoundary, previous: { family: cur.family, effort: i.current!.running }, previousAdequate: true, appEffort: i.appEffort, escalation: mq.escalated, effortMin: mq.floors.effortMin?.[cur.family] })
      verdicts = { ...verdicts, [cur.family]: { model: cur.family, effort: fb.effort, why: 'fallback' } }
      notes.push({ family: cur.family, effort: fb.effort, fallback: fb.source })
      if (askedNeed) { ownFallback = fb.source; reasons.push(`own verdict failed: ${fb.source}`) }
      else fallback = fb.source
    }
    // The need failed and the running model answered: nothing here can move the session.
    if (cur && !askedNeed && !i.fixedFamily && !fallback) fallback = 'the need call failed: no model switch'
    if (!cur && !Object.values(verdicts).some(Boolean)) {
      // No verdict at all on a first prompt: the app model (if available), never a model taken from the tier name.
      const f = i.fixedFamily ?? (i.allowed.includes(i.appFamily) ? i.appFamily : i.allowed[i.allowed.length - 1])
      const fb = fallbackEffort({ sameTask: false, sameStage: false, riskChanged: false, planBoundary: false, previous: null, previousAdequate: false, appEffort: i.appEffort, escalation: null, effortMin: mq.floors.effortMin?.[f] })
      verdicts = { [f]: { model: f, effort: fb.effort, why: 'fallback' } }
      floors.fixedFamily = f
      fallback = fb.source
    }
    if ((!answer || fallback) && cur && !i.fixedFamily && i.allowed.includes(cur.family)) { floors.fixedFamily = cur.family; fallback = fallback ?? 'automode judge failed: no model switch' }
    // The AutoMode judge failed and the need answered: a hold on Haiku never outlives a need for a stronger model. Found
    // in W1: a question had moved the session to Haiku, the next prompt's AutoMode judge reply did not parse, and a hard
    // migration that both effortless calls rated opus/high ran on Haiku, at Opus's cost. The need's model is a minimum:
    // Opus only where a judge's word may start Opus, else Sonnet.
    if (!answer && askedNeed && floors.fixedFamily === 'haiku' && !i.fixedFamily && askedNeed.model !== 'haiku') {
      const want: Family = askedNeed.model === 'opus' && !i.opusOnEvidence && i.allowed.includes('opus') ? 'opus' : 'sonnet'
      if (i.allowed.includes(want)) {
        // A floor, not a candidate: an upgrade without one waits for two votes, and the hold kept Haiku in W1 too.
        const why = `the AutoMode judge failed and the need names ${askedNeed.model}`
        floors.fixedFamily = want
        floors.exclude = { ...floors.exclude, haiku: why }
        floors.because = [...floors.because, why]
        if (tierRank(needTier.tier) < tierRank('T2')) needTier = { tier: 'T2', because: [why] }
        verdicts = { ...verdicts, [want]: verdicts[want] ?? { model: want, effort: maxEffort(askedNeed.effort ?? 'high', mq.floors.effortMin?.[want] ?? 'low'), why: 'fallback' } }
        notes.push({ family: want, effort: verdicts[want]!.effort, fallback: `the need names ${askedNeed.model}` })
        fallback = `${fallback}; the need names ${askedNeed.model}: ${want}, not haiku`
      }
    }
    // v6: on a first prompt with the AutoMode judge failed, the need decides the model, not the model the session was
    // launched on. Found in S1: the judge timed out on mistune in a session launched on Opus, and the task ran on Opus
    // although the need said Sonnet high. Opus only where a judge's word may start Opus; the legacy start keeps the app model.
    if (!answer && !cur && !i.fixedFamily && !floors.fixedFamily && i.start && askedNeed) {
      const want: Family = askedNeed.model === 'opus' && !i.opusOnEvidence && i.allowed.includes('opus') ? 'opus' : 'sonnet'
      if (i.allowed.includes(want)) { floors.fixedFamily = want; fallback = fallback ?? `automode judge failed on the first prompt: the need names ${askedNeed.model}, so ${want}` }
    }
    if (!answer && !cur && !i.fixedFamily && !floors.fixedFamily) { floors.fixedFamily = i.allowed.includes(i.appFamily) ? i.appFamily : i.allowed[i.allowed.length - 1]; fallback = fallback ?? 'automode judge failed on the first prompt: the app model' }
    // The effortless judge failed and the AutoMode judge answered: its model name is a minimum (fallbackModel).
    if (fallback && answer && floors.fixedFamily && !i.fixedFamily && !i.executor.on) {
      const fm = fallbackModel(floors.fixedFamily, { tier: answer.tier, effort: answer.effort, confidence: answer.confidence }, i.allowed, i.floor.risk, i.policy.lowConfidence)
      if (fm.family !== floors.fixedFamily) {
        floors.fixedFamily = fm.family
        verdicts = { ...verdicts, [fm.family]: { model: fm.family, effort: maxEffort(fm.effort ?? 'high', mq.floors.effortMin?.[fm.family] ?? 'low'), why: 'fallback' } }
        notes.push({ family: fm.family, effort: verdicts[fm.family]!.effort, fallback: fm.why })
      }
      fallback = `${fallback}; ${fm.why}`
    }
    if (fallback) reasons.push(`fallback: ${fallback}`)
  }

  // Uncertainty never buys a cheaper model (jev-router policy.mjs `low-confidence-no-downgrade`, threshold 0.3 as
  // there): a low-confidence AutoMode verdict rules out every model cheaper than the running one.
  if (answer && cur && answer.confidence < i.policy.lowConfidence && !floors.fixedFamily) {
    const rankF: Record<Family, number> = { haiku: 0, sonnet: 1, opus: 2 }
    for (const f of FAMILIES) if (rankF[f] < rankF[cur.family]) floors.exclude = { ...(floors.exclude ?? {}), [f]: `low judge confidence (${answer.confidence}): no downgrade` }
    reasons.push('low confidence: no downgrade (jev-router)')
  }

  // What this project taught: this kind of task kept needing rescue, so it starts on Opus. Learning only raises a route.
  const taught = i.learned.on && answer && askedNeed && !floors.fixedFamily && i.allowed.includes('opus') ? bucketOf(answer.tier, askedNeed.model) : null
  let learnedBucket: string | undefined
  if (taught && i.learned.opusBuckets.includes(taught)) {
    floors.exclude = { ...(floors.exclude ?? {}), haiku: `learned: ${taught} needed rescue in this project`, sonnet: `learned: ${taught} needed rescue in this project` }
    reasons.push(`learned: ${taught} starts on opus`)
    learnedBucket = taught
  }

  // Call 2, only when needed: one effortless call about the model that could win (cheaper than the anchor and
  // eligible, or the anchor is out). Its effort is valid for that model only.
  const secondJudge = !i.shortcut && !fallback && !i.judgeCached && !i.executor.on
    ? secondCall({ allowed: i.allowed, verdicts, need: askedNeed, hm: answer ? { tier: answer.tier, complexity: answer.complexity } : null, consequence: i.floor.risk, reachHaiku: i.reachHaiku, opusOnEvidence: i.opusOnEvidence, haikuFirst: i.haikuFirst, start: i.start, floors, current: null, cost: () => 0 }, i.anchor)
    : null
  return { floors, tier: tierRank(needTier.tier) > tierRank(mq.tier.tier) ? needTier : mq.tier, escalated: mq.escalated, verdicts, notes, ...(fallback ? { fallback } : {}), ...(ownFallback ? { ownFallback } : {}), ...(learnedBucket ? { learnedBucket } : {}), secondJudge, reasons }
}

// routeAuto: the route for this prompt, from the full verdicts.
export function routeAuto(i: AutoRouteInput): AutoRouteResult {
  const { secondJudge: _, ...plan } = planAuto(i)
  const reasons = [...plan.reasons]
  const { floors, verdicts, fallback } = plan
  const cur = i.current?.route ?? null
  const answer = i.judge
  const hm = answer ? { tier: answer.tier, complexity: answer.complexity } : null
  if (i.second) {
    const v = i.verdicts[i.second]
    reasons.push(`second effortless call: ${i.second}${v ? ` -> ${v.model}/${v.effort}` : ' failed'}`)
  }

  // The joint optimizer, or the shortcut's kept decision.
  const cost = costOf(i.economics.attempt)
  const current = cur ? { family: cur.family, effort: i.current!.running } : null
  const askedNeed = i.verdicts[i.anchor] ?? null
  // After a failed judge the model is fixed, and its fallback verdict stands in for later triggers.
  const need = askedNeed ?? (floors.fixedFamily ? verdicts[floors.fixedFamily] ?? null : null)
  const kept: FamilyVerdict | null = i.shortcut && i.kept ? { model: i.kept.family, effort: i.kept.effort, why: 'kept' } : null
  // Under the executor, the judges' verdicts stay as the shadow route. Only the effort reaches the choice.
  const executed = kept ? null : executorInput(i.executor.on, verdicts, floors, i.executor.taskRoute)
  if (executed) reasons.push(`executor: sonnet ${executed.verdicts.sonnet!.effort}`)
  const consequence = i.floor.risk
  const choice: AutoChoice = kept
    ? optimizeAuto({ allowed: i.allowed, verdicts: { [kept.model]: kept }, need: kept, hm: null, floors: { ...floors, fixedFamily: i.allowed.includes(i.kept!.family) ? i.kept!.family : undefined }, current, cost })
    : optimizeAuto({ allowed: i.allowed, ...(executed ?? { verdicts, floors }), need, hm, consequence, reachHaiku: i.reachHaiku, opusOnEvidence: i.opusOnEvidence, haikuFirst: i.haikuFirst, start: i.start, current, cost })
  const shadow = executed ? optimizeAuto({ allowed: i.allowed, verdicts, need, hm, consequence, reachHaiku: i.reachHaiku, opusOnEvidence: i.opusOnEvidence, haikuFirst: i.haikuFirst, start: i.start, floors, current, cost }).best : null
  reasons.push(`optimizer: ${choice.rule} -> ${choice.best.family}/${choice.best.effort}`)
  const own = cur ? choice.candidates.find((c) => c.family === cur.family) : undefined
  // A hold keeps the model, never its old effort: the held model runs at its own verdict for this prompt (or its
  // fallback verdict), within its floors. Found in tests: a failed judge on a new task held Opus at the previous xhigh.
  const ownVerdict = cur ? verdicts[cur.family] : null
  const heldEffort = ownEffort(own) ?? (cur && ownVerdict ? maxEffort(ownVerdict.effort, plan.floors.effortMin?.[cur.family] ?? 'low') : undefined)
  const currentInadequate = runningRuledOut(cur?.family, choice, floors, hm)
  const candidate = { tier: tierOf(choice.best.family, choice.best.effort), source: (i.shortcut ? 'continuation' : fallback ? 'fallback' : 'judge') as 'judge' | 'continuation' | 'fallback', confidence: answer?.confidence ?? 0.5, reason: `${i.shortcut ? 'short go-ahead keeps the task' : answer?.why || 'judges'}; ${choice.best.family} ${choice.best.effort} ${choice.best.eligibility}${choice.inadequate ? ' (inadequate)' : ''}` }
  const votes = i.votes.tier === candidate.tier ? { tier: candidate.tier, n: i.votes.n + 1 } : { tier: candidate.tier, n: 1 }
  let tier = plan.tier
  if (currentInadequate && cur && tierRank(tierOf(choice.best.family, choice.best.effort)) > tierRank(tier.tier))
    tier = { tier: tierOf(choice.best.family, choice.best.effort), effort: choice.best.effort, because: [`${cur.family} ${i.current!.running} is ruled out for this task (${own?.eligibility ?? `excluded: ${floors.exclude?.[cur.family] ?? "floor"}`})`] }
  const commandRoute = i.command ? { tier: tierOf(choice.best.family, choice.best.effort), effort: choice.best.effort, reason: `user: ${i.command.label}` } : undefined
  const e = i.economics
  const sw = i.switching
  const effortCost = { output: (r: Route) => e.outputPerStep[r.family] * e.effortOutput[r.effort], steps: (r: Route) => e.effortSteps[r.effort] }
  const resolved = resolve({
    override: commandRoute, floor: tier, candidate, effortHint: choice.best.effort, heldEffort, ...(currentInadequate ? { currentInadequate } : {}), effortCost, current: i.usable, allowed: i.allowed,
    switchInput: {
      cache: sw.cache, now: i.now, votes: votes.n, requestsSinceSwitch: sw.requestsSinceSwitch, verifiedSinceSwitch: sw.verifiedSinceSwitch,
      sameTask: !i.boundary && !i.planExited, risk: i.floor.risk, expectedOutputTokens: e.outputPerStep[cur?.family ?? 'sonnet'],
      prices: e.prices, params: { ...DEFAULT_PARAMS, calibrated: e.calibrated },
      requestsInPrompt: 0, newTaskSteps: i.boundary ? TASK_STEPS[i.complexity] : undefined, remainingTable: sw.remainingTable, switchesThisTask: sw.switchesThisTask,
      targetWarm: sw.warm[choice.best.family], targetWarmPrefix: sw.warmPrefix[choice.best.family], resetPrefixTokens: sw.resetPrefixTokens,
      ...sw.continuity,
    },
  }, sw.reset)
  reasons.push(`authority: ${resolved.owner} ${resolved.family}/${resolved.effort}${resolved.check?.gate ? ` (${resolved.check.gate})` : ''}`)

  // A challenge to finished hard work on a warm cheaper session: a scoped Opus consult instead of a switch (kept from v4.1).
  // The rules name Opus even when the gate holds the switch: the consult is how the reasoning arrives now.
  let route = resolved
  let consult: AutoRouteResult['consult'] = null
  const lastWorkBand = hm ? (i.stage === 'reconsider' ? i.consult.lastWorkBand : TIER_BAND[hm.tier]) : i.consult.lastWorkBand
  const key = `stage:${i.floor.taskId}:${lastWorkBand ?? 0}`
  if (i.stage === 'reconsider' && cur && cur.family !== 'opus' && (resolved.family === 'opus' || choice.best.family === 'opus') && sw.cache.prefixTokens >= DEFAULT_PARAMS.smallContext && !i.consult.consulted.includes(key)) {
    const c = consultOrSwitch({ prefixTokens: sw.cache.prefixTokens, remainingRequests: remainingFor({ requestsInPrompt: 0, remainingTable: sw.remainingTable }).median, outPerRequest: e.outputPerStep.opus, packetTokens: i.consult.packetTokens, planTokens: 2_000, main: cur.family, ttlMs: i.consult.ttlMs, prices: e.prices })
    consult = { key, ...c }
    if (c.choice === 'consult') {
      const effort = own?.effort ?? cur.effort
      route = { ...cur, tier: tierOf(cur.family, effort), effort, owner: 'quality-escalation', reason: `consult Opus instead of a switch: ${c.why}`, floor: tier, candidate: resolved.candidate, overridden: [...resolved.overridden, { owner: resolved.owner, reason: 'opus switch replaced by a consult' }] }
      reasons.push('consult: Opus architect instead of a switch')
    }
  }
  return { ...plan, tier, reasons, need, kept, choice, shadow, own, votes, resolved, route, lastWorkBand, consult }
}

// RouteOutcome: the observable part of a route. bench/route-replay.mts compares it between a record and a replay.
export interface RouteOutcome { route: string; owner: string; gate?: string; consult?: 'consult' | 'switch'; fallback?: boolean }
export const outcomeOf = (r: AutoRouteResult): RouteOutcome => ({ route: `${r.route.family}/${r.route.effort}`, owner: r.route.owner, ...(r.resolved.check?.gate ? { gate: r.resolved.check.gate } : {}), ...(r.consult ? { consult: r.consult.choice } : {}), ...(r.fallback ? { fallback: true } : {}) })

// RouteReplay: what a decision record keeps so the route can run again. No prompt text is in it.
export interface RouteReplay {
  input: AutoRouteInput
  outcome: RouteOutcome
  provenance: { schema: number; fingerprint: string; priceBook: string; flags: Record<string, boolean> }
}

// routeFingerprint hashes the source of the functions the route runs. Pure lib files ship unbundled, so a release and
// its checkout give the same value. It covers code only: a changed constant, such as DEFAULT_PARAMS, keeps the value.
let fingerprint: string | undefined
export function routeFingerprint(): string {
  fingerprint ??= fnv1a([routeAuto, planAuto, autoFloors, executorInput, escalationStep, optimizeAuto, eligibilityOf, secondCall, fallbackEffort, fallbackModel, ownEffort, runningRuledOut, resolve, switchCheck, consultOrSwitch, executorEffort].map((f) => f.toString()).join('\n'))
  return fingerprint
}

// replayOf: the replay block of a decision record. The input is copied, so a later change to session state never
// reaches a record that waits to be written.
export function replayOf(input: AutoRouteInput, result: AutoRouteResult, priceBook: string, flags: Record<string, boolean>): RouteReplay {
  return { input: JSON.parse(JSON.stringify(input)), outcome: outcomeOf(result), provenance: { schema: AUTO_ROUTE_SCHEMA, fingerprint: routeFingerprint(), priceBook, flags } }
}
