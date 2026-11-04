// Conditional route properties for policy auto. Each property names its comparison domain: what varies and what is
// held fixed. The spaces are walked in full, not sampled. Where the code breaks a broad form of a rule on purpose, or
// by a known path, the precondition is narrowed and a named test pins what the code does today.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { routeAuto, type AutoRouteInput } from '../hooks/lib/auto-route.ts'
import { BAND_OF, ladderStep, nextEffort, type LadderStep } from '../hooks/lib/bands.ts'
import { assess, textConsequence, type ConsequenceInput } from '../hooks/lib/consequence.ts'
import { escalation, EMPTY_LADDER, type LadderSignals } from '../hooks/lib/failures.ts'
import { EFFORTS, RISKS, type Effort, type Family, type FailureRecord, type Risk, type Tier } from '../hooks/lib/types.ts'
import { input, type Given } from './auto-route-fixture.mts'

const FAMILIES: Family[] = ['haiku', 'sonnet', 'opus']
const ALLOWED: Family[][] = [['haiku'], ['sonnet'], ['opus'], ['haiku', 'sonnet'], ['haiku', 'opus'], ['sonnet', 'opus'], ['haiku', 'sonnet', 'opus']]
const TIERS: (Tier | null)[] = [null, 'T0', 'T1', 'T2', 'T3', 'T4']
const VERDICT_EFFORTS: Effort[] = ['low', 'medium', 'high', 'max']
const RUNNING = FAMILIES.flatMap((family) => EFFORTS.map((effort) => ({ family, effort })))
const rank = (r: Risk) => RISKS.indexOf(r)
const bandOfRoute = (r: { family: Family; effort: Effort }) => BAND_OF[r.family][r.effort]
const named = (r: { family: Family; effort: Effort }) => `${r.family}/${r.effort}`

// The judge evidence one session can carry: the AutoMode tier (a failed judge included), the need asked with the
// Sonnet anchor (a failed call included), and one shared effort for the Haiku and Opus verdicts (or none asked).
type Evidence = { tier: Tier | null; need: [Family, Effort] | null; own: Effort | null }
function* evidence(): Generator<Evidence> {
  const needs: ([Family, Effort] | null)[] = [null, ...FAMILIES.flatMap((m) => VERDICT_EFFORTS.map((e): [Family, Effort] => [m, e]))]
  for (const tier of TIERS) for (const need of needs) for (const own of [null, 'low', 'high'] as (Effort | null)[]) yield { tier, need, own }
}
function given(e: Evidence, rest: Given): Given {
  const verdicts: Given['verdicts'] = { sonnet: e.need }
  if (e.own) { verdicts.haiku = ['haiku', e.own]; verdicts.opus = ['opus', e.own] }
  return { judge: e.tier ? { tier: e.tier, complexity: 'complex' } : null, verdicts, ...rest }
}

// The former hole in floor preservation, now closed. On a warm Haiku session whose need call failed, a T3 or T4 AutoMode
// judge makes fallbackModel fix the model to Opus. The floor's tier (T1 or T2) is then below the candidate's (T3), so
// resolve() does not mark the move mandatory, and runningRuledOut passed, because the fixed model was the only
// candidate. The vote gate then held Haiku below the floor. runningRuledOut now rules out a running model a floor
// excludes even when it is no candidate (found in W1, where a failed judge left a hard task on Haiku).
const haikuHoldHole = (e: Evidence, running: { family: Family } | null, allowed: Family[]) =>
  running?.family === 'haiku' && allowed.includes('haiku') && e.need === null && (e.tier === 'T3' || e.tier === 'T4') && allowed.includes('opus')

// ---------------------------------------------------------------- 1. ladderStep: strong is never below weak

// Varies: the running family and effort, and the allowed set (the empty set means no limit). Fixed: everything else;
// ladderStep reads no floor, policy or session state. A null step means no rung is left. Strong is null only when weak
// is null too, and a non-null step is always above the running band.
test('ladderStep: the strong step is never below the weak step, and both climb', () => {
  for (const running of RUNNING) for (const allowed of [[], ...ALLOWED] as Family[][]) {
    const weak = ladderStep(running, 'weak', allowed)
    const strong = ladderStep(running, 'strong', allowed)
    const where = `${named(running)} allowed=[${allowed}]`
    if (weak) assert.ok(strong, `weak has a rung, so strong has one: ${where}`)
    if (weak && strong) assert.ok(strong.band >= weak.band, `strong ${strong.band} >= weak ${weak.band}: ${where}`)
    for (const s of [weak, strong]) if (s) assert.ok(s.band > bandOfRoute(running), `a step climbs: ${where} -> ${named(s)}`)
  }
})

// ---------------------------------------------------------------- 2. assess: the judge only raises

const PROMPTS = [
  'Prod is down since the last deploy, fix it',
  'Fix the login redirect for SSO users',
  'Rename the auth helpers without changing behavior',
  'Fix the typo in the login heading',
  'What does the payments module do?',
  'Can we store the session token in a cookie?',
  'Draft a Slack message about the refund outage',
  'Deploy the release to prod',
  'Run `DROP TABLE users` on the staging copy',
  'Add a dark mode toggle to settings',
]
const JUDGES: NonNullable<ConsequenceInput['judge']>[] = RISKS.flatMap((risk) => [undefined, ...RISKS].flatMap((consequence) => [0.3, 0.9].map((confidence) => ({ risk, ...(consequence ? { consequence } : {}), confidence }))))

// Varies: the judge (risk, consequence, confidence). Fixed: the text, the path and diff layers, a failed verification and
// the judgeFailed flag. The comparison is against the same inputs with no judge. The bound is that assessment, not
// textConsequence: a critical text alone caps at elevated without hard evidence (see the next test).
test('assess: a judge can raise the consequence, never lower it below the same inputs without a judge', () => {
  let walked = 0
  for (const text of PROMPTS) for (const pathLevel of RISKS) for (const observedLevel of RISKS) for (const verificationFailed of [false, true]) for (const judgeFailed of [false, true]) {
    const base: ConsequenceInput = { text, pathLevel, observedLevel, verificationFailed, judgeFailed }
    const without = assess(base)
    const textLevel = textConsequence(text).level
    for (const judge of JUDGES) {
      const withJudge = assess({ ...base, judge })
      const where = JSON.stringify({ ...base, judge })
      assert.ok(rank(withJudge.level) >= rank(without.level), `level ${withJudge.level} >= ${without.level}: ${where}`)
      assert.ok(rank(withJudge.routing) >= rank(without.routing), `routing ${withJudge.routing} >= ${without.routing}: ${where}`)
      assert.ok(rank(withJudge.routing) >= rank(textLevel), `routing never below the text layer: ${where}`)
      const reviewRank = (r: string | null) => (r === 'opus' ? 2 : r === 'sonnet' ? 1 : 0)
      assert.ok(reviewRank(withJudge.review) >= reviewRank(without.review), `review never drops: ${where}`)
      walked++
    }
  }
  assert.ok(walked > 5_000, `walked ${walked}`)
})

test('assess: a critical text with no hard evidence and no judge gives level elevated, routing critical', () => {
  const text = 'Fix the login redirect for SSO users'
  assert.equal(textConsequence(text).level, 'critical')
  const a = assess({ text })
  assert.deepEqual([a.level, a.routing, a.review], ['elevated', 'critical', null])
})

// ---------------------------------------------------------------- 3. floors hold through routeAuto

// Varies: the judge evidence, the running route (none, or any family and effort, warm with a 30k prefix) and the
// allowed set. Fixed: consequence critical, complexity complex, no ladder step, no command, no pins, default economics.
// Precondition: some non-Haiku model is allowed, so the floor (Sonnet high or Opus medium, band 2) can be met. Excluded:
// the Haiku hold hole above, pinned by its own test. The band holds, but the family can leave the allowed set. Where a
// failed judge fixes Haiku as the candidate, resolve() lifts the T0 candidate to the T2 floor. routeFor(T2) names
// Sonnet whether or not Sonnet is allowed. That is the one way out of the allowed set, and the test pins it.
test('floor: critical consequence keeps the route at band 2 or more and off Haiku', () => {
  let walked = 0
  let lifted = 0
  for (const e of evidence()) for (const running of [null, ...RUNNING]) for (const allowed of ALLOWED) {
    if (!allowed.some((f) => f !== 'haiku')) continue
    const result = routeAuto(input(given(e, { current: running ? named(running) : undefined, allowed, risk: 'critical' })))
    const r = result.route
    const where = () => JSON.stringify({ e, running, allowed, route: named(r), owner: r.owner })
    assert.notEqual(r.family, 'haiku', `critical leaves Haiku: ${where()}`)
    assert.ok(bandOfRoute(r) >= 2, `critical holds band 2: ${where()}`)
    if (!allowed.includes(r.family)) {
      assert.deepEqual([named(r), r.owner, result.choice.best.family], ['sonnet/high', 'quality-escalation', 'haiku'], `only the T2 lift of a fixed Haiku leaves the allowed set: ${where()}`)
      lifted++
    }
    walked++
  }
  assert.ok(lifted > 0, 'the T2 lift of a fixed Haiku is in the domain')
  assert.ok(walked > 10_000, `walked ${walked}`)
})

test('floor: critical consequence with only Haiku allowed routes to Sonnet high, outside the allowed set', () => {
  for (const e of evidence()) for (const running of [null, ...RUNNING.filter((x) => x.family === 'haiku')]) {
    const r = routeAuto(input(given(e, { current: running ? named(running) : undefined, allowed: ['haiku'], risk: 'critical' }))).route
    assert.deepEqual([named(r), r.owner], ['sonnet/high', 'quality-escalation'], JSON.stringify({ e, running }))
  }
})

// Ladder floors: every step ladderStep gives from the running route. Varies: the judge evidence, the running route, the
// strength of the evidence and the allowed set. Fixed: consequence none, complexity complex, no command, no pins.
// Precondition: the step's family is allowed (escalationStep drops the step otherwise, so no floor exists). Excluded:
// the Haiku hold hole.
function* ladderCases(): Generator<{ e: Evidence; running: { family: Family; effort: Effort }; allowed: Family[]; step: LadderStep; level: 'weak' | 'strong' }> {
  for (const running of RUNNING) for (const allowed of ALLOWED) {
    if (!allowed.includes(running.family)) continue
    for (const level of ['weak', 'strong'] as const) {
      const step = ladderStep(running, level, allowed)
      if (!step || !allowed.includes(step.family)) continue
      for (const e of evidence()) yield { e, running, allowed, step, level }
    }
  }
}
const ladderRoute = (c: { e: Evidence; running: { family: Family; effort: Effort }; allowed: Family[]; step: LadderStep }, extra: Given = {}) =>
  routeAuto(input(given(c.e, { current: named(c.running), boundary: false, allowed: c.allowed, ladder: named(c.step), ...extra }))).route

test('floor: a ladder step keeps the route at or above the step band', () => {
  let walked = 0
  for (const c of ladderCases()) {
    const r = ladderRoute(c)
    assert.ok(bandOfRoute(r) >= c.step.band, `band ${bandOfRoute(r)} >= step ${c.step.band}: ${JSON.stringify({ ...c, route: named(r), owner: r.owner })}`)
    walked++
  }
  assert.ok(walked > 10_000, `walked ${walked}`)
})

test('floor: the ladder floor and the critical floor together keep the higher band', () => {
  for (const c of ladderCases()) {
    if (!c.allowed.some((f) => f !== 'haiku')) continue
    const r = ladderRoute(c, { risk: 'critical' })
    assert.ok(bandOfRoute(r) >= Math.max(2, c.step.band), JSON.stringify({ ...c, route: named(r), owner: r.owner }))
  }
})

// The former hole stays closed: every case in it leaves Haiku for the floor.
test('floor hole closed: a warm Haiku session with a failed need and a T3 or T4 judge leaves Haiku under critical consequence', () => {
  let n = 0
  for (const e of evidence()) for (const running of RUNNING.filter((x) => x.family === 'haiku')) for (const allowed of ALLOWED) {
    if (!haikuHoldHole(e, running, allowed)) continue
    const r = routeAuto(input(given(e, { current: named(running), allowed, risk: 'critical' })))
    assert.notEqual(r.route.family, 'haiku', JSON.stringify({ e, running, allowed }))
    assert.ok(bandOfRoute(r.route) >= 2, JSON.stringify({ e, running, allowed }))
    n++
  }
  assert.ok(n > 0)
})

// ---------------------------------------------------------------- 4. a user override is final

// Varies: the commanded family (allowed), the commanded effort (or none), the judge evidence, cold or warm sessions,
// the consequence and the allowed set. Fixed: a command is present, no ladder step. A command with an effort keeps that
// effort even below a floor: the override is final, and resolve() records the floor as pending.
test('override: a model command keeps the family, and an effort command keeps the effort', () => {
  let walked = 0
  for (const allowed of ALLOWED) for (const fixedFamily of allowed) for (const fixedEffort of [undefined, ...EFFORTS]) for (const risk of ['none', 'critical'] as Risk[])
    for (const running of [null, { family: fixedFamily, effort: 'medium' as Effort }]) for (const tier of TIERS) for (const own of [null, 'high'] as (Effort | null)[]) {
      const e: Evidence = { tier, need: ['sonnet', 'medium'], own }
      const r = routeAuto(input(given(e, { current: running ? named(running) : undefined, boundary: !running, allowed, fixedFamily, ...(fixedEffort ? { fixedEffort } : {}), command: 'am:pick', risk }))).route
      const where = JSON.stringify({ allowed, fixedFamily, fixedEffort, risk, running, tier, own, route: named(r) })
      assert.equal(r.owner, 'user-override', where)
      assert.equal(r.family, fixedFamily, where)
      if (fixedEffort) assert.equal(r.effort, fixedEffort, where)
      walked++
    }
  assert.ok(walked > 1_000, `walked ${walked}`)
})

// Varies: the commanded effort, the allowed set, the judge evidence. Fixed: no model command, a command is present.
test('override: an effort command alone keeps the effort on whatever model the route picks', () => {
  for (const allowed of ALLOWED) for (const fixedEffort of EFFORTS) for (const tier of TIERS) for (const risk of ['none', 'critical'] as Risk[]) {
    const r = routeAuto(input(given({ tier, need: ['sonnet', 'medium'], own: 'high' }, { allowed, fixedEffort, command: 'am:effort', risk }))).route
    assert.equal(r.owner, 'user-override')
    assert.equal(r.effort, fixedEffort, JSON.stringify({ allowed, fixedEffort, tier, risk, route: named(r) }))
  }
})

test('override: a model command for a family outside the allowed set still routes to that family', () => {
  for (const allowed of ALLOWED) for (const fixedFamily of FAMILIES.filter((f) => !allowed.includes(f))) for (const tier of TIERS) {
    const r = routeAuto(input(given({ tier, need: ['sonnet', 'medium'], own: 'high' }, { allowed, fixedFamily, command: 'am:pick' }))).route
    assert.deepEqual([r.family, r.owner], [fixedFamily, 'user-override'], JSON.stringify({ allowed, fixedFamily, tier }))
  }
})

// ---------------------------------------------------------------- 5. the start model does not pick the route

// Varies: the app model. Fixed: a cold session (no running route), the judge evidence, complexity, consequence and the
// allowed set. Precondition: the AutoMode judge answered and at least one effortless verdict answered. With no evidence
// the first prompt takes the app model by design (next test). Warm sessions are out of the domain: the running model's
// cache changes the price of each move, so the route there legitimately depends on where the session stands.
test('start: on a cold session the app model never changes the first candidate', () => {
  let walked = 0
  for (const e of evidence()) for (const allowed of ALLOWED) for (const risk of ['none', 'critical'] as Risk[]) {
    if (!e.tier || (!e.need && !e.own)) continue
    const base = input(given(e, { allowed, risk }))
    const picks = FAMILIES.map((appFamily) => named(routeAuto({ ...base, appFamily } as AutoRouteInput).choice.best))
    assert.deepEqual(picks, [picks[0], picks[0], picks[0]], JSON.stringify({ e, allowed, risk }))
    walked++
  }
  assert.ok(walked > 1_000, `walked ${walked}`)
})

// Outside the domain above. A failed AutoMode judge fixes the app model. With no verdict at all, the app model is the
// start, and the AutoMode judge's model (hmModel) replaces it when that model is allowed (fallbackModel).
test('start: a first prompt with a failed AutoMode judge, or no verdict at all, starts from the app model', () => {
  for (const allowed of ALLOWED) for (const appFamily of allowed) {
    const noJudge = routeAuto({ ...input(given({ tier: null, need: ['sonnet', 'medium'], own: null }, { allowed })), appFamily })
    assert.equal(noJudge.choice.best.family, appFamily, `no judge: ${JSON.stringify({ allowed, appFamily })}`)
    for (const tier of ['T0', 'T1', 'T2', 'T3', 'T4'] as Tier[]) {
      const noVerdict = routeAuto({ ...input(given({ tier, need: null, own: null }, { allowed })), appFamily })
      const judged: Family = tier === 'T0' ? 'haiku' : tier === 'T3' || tier === 'T4' ? 'opus' : 'sonnet'
      assert.equal(noVerdict.choice.best.family, allowed.includes(judged) ? judged : appFamily, `no verdict: ${JSON.stringify({ allowed, appFamily, tier })}`)
    }
  }
})

// ---------------------------------------------------------------- 6. escalation, ladder step, floor

const fail = (over: Partial<FailureRecord>): FailureRecord => ({ fingerprint: 'fp1', class: 'defect', command: 'npm test', exitCode: 1, at: 10, editedSince: true, evidence: 'AssertionError: expected 1 to equal 2', tests: ['adds'], ...over })
// Strong evidence, one way each. effortCapped is set from the running route, as runLadder sets it.
const STRONG: { name: string; history: FailureRecord[]; signals: Partial<LadderSignals> }[] = [
  { name: 'reviewer blocker', history: [], signals: { reviewerBlockers: 1 } },
  { name: 'revert', history: [], signals: { reverts: 1 } },
  { name: 'regression', history: [fail({})], signals: { passed: { 'npm test': 5 }, editedSincePass: () => ['src/a.ts'] } },
  { name: 'repeat after a raise', history: [fail({ at: 5 }), fail({ at: 10 })], signals: { raised: { fp1: 1 } } },
  { name: 'repeat at the top effort', history: [fail({ at: 5 }), fail({ at: 10 })], signals: {} },
]

// Varies: the strong evidence, the running route, the allowed set and the judge evidence. Fixed per comparison: the
// allowed set, the policy (default), consequence none, no command. The chain is the one runLadder runs: escalation,
// then ladderStep, then the step as `ladderFloor`. Precondition: the evidence is strong for this running route, the
// step exists and its family is allowed. Excluded: the Haiku hold hole, which can land below the running band.
test('chain: strong evidence never lands the route below the running band', () => {
  const seen = new Set<string>()
  let walked = 0
  for (const s of STRONG) for (const running of RUNNING) for (const allowed of ALLOWED) {
    if (!allowed.includes(running.family)) continue
    const esc = escalation(s.history, { ...EMPTY_LADDER, ...s.signals, effortCapped: !nextEffort(running.family, running.effort) })
    if (esc.level !== 'strong') continue
    const step = ladderStep(running, 'strong', allowed)
    if (!step || !allowed.includes(step.family)) continue
    const key = `${named(running)}|${allowed}|${named(step)}`
    if (seen.has(key)) continue
    seen.add(key)
    for (const e of evidence()) {
      const r = ladderRoute({ e, running, allowed, step })
      assert.ok(bandOfRoute(r) >= bandOfRoute(running), `${s.name}: ${named(running)} -> ${named(r)} (${r.owner}) ${JSON.stringify({ e, allowed, step })}`)
      walked++
    }
  }
  assert.ok(STRONG.every((s) => escalation(s.history, { ...EMPTY_LADDER, ...s.signals, effortCapped: true }).level === 'strong'), 'each scenario is strong evidence')
  assert.ok(walked > 1_000, `walked ${walked}`)
})

test('chain hole closed: a failed need on warm Haiku under a T3 judge no longer holds Haiku below its running band', () => {
  const running = { family: 'haiku' as Family, effort: 'medium' as Effort }
  const step = ladderStep(running, 'strong', FAMILIES)!
  const r = ladderRoute({ e: { tier: 'T3', need: null, own: 'low' }, running, allowed: FAMILIES, step })
  assert.equal(named(step), 'sonnet/medium')
  assert.notEqual(r.family, 'haiku')
})
