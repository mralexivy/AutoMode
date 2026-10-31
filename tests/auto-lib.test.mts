// @ts-nocheck TODO(types): 44 errors with strict off. Fix them and delete this line to turn checking on for this file.
// Unit tests for the AutoMode Auto pure modules: lib/auto.ts (joint optimizer, escalation step, resolution helpers,
// judge-failure table, legal effort point) and lib/effortless-adapt.ts (documented judge-input changes).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { optimizeAuto, eligibilityOf, effortlessFloor, firstCalls, runningRuledOut, secondCall, fallbackModel, escalationTarget, decisionRequired, shortcutApplies, fallbackEffort, legalEffort } from '../hooks/lib/auto.ts'
import { resolve } from '../hooks/lib/authority.ts'
import { ANTHROPIC } from '../hooks/lib/prices.ts'
import { judgeInputFor, contextOf, NEED_ANCHOR, PLAN_LINE, CLOSING_LINE, stripReminders } from '../hooks/lib/effortless-adapt.ts'
import { keepsEffort } from '../hooks/lib/effortless.ts'

// A cost that scales with the model price (Opus 2x Sonnet, Haiku 0.05x) and the effort output prior.
const PRICE = { haiku: 0.05, sonnet: 1, opus: 2 }
const OUT = { low: 0.6, medium: 1, high: 1.36, xhigh: 1.5, max: 1.8 }
const cost = (f, e) => PRICE[f] * OUT[e]
const v = (model, effort, why = '') => ({ model, effort, why })
// The need is the fixed-anchor answer. A test that sets only verdicts reads it from the Sonnet answer, or its one answer.
const needOf = (verdicts = {}) => verdicts.sonnet ?? Object.values(verdicts)[0] ?? null
const base = (over = {}) => ({ allowed: ['haiku', 'sonnet', 'opus'], verdicts: {}, need: needOf(over.verdicts), hm: { tier: 'T1', complexity: 'standard' }, floors: { because: [] }, current: null, cost, ...over })

const hmOf = (tier, complexity = 'standard') => ({ tier, complexity })

test('eligibility: Haiku needs both judges; an effort verdict alone never makes Haiku eligible', () => {
  assert.equal(eligibilityOf('haiku', { need: v('sonnet', 'low'), hm: hmOf('T2') }).eligibility, 'ineligible')
  assert.equal(eligibilityOf('haiku', { need: v('haiku', 'low'), hm: hmOf('T0') }).eligibility, 'eligible')
  assert.equal(eligibilityOf('haiku', { need: v('sonnet', 'low'), hm: hmOf('T0') }).eligibility, 'ineligible', 'effortless says sonnet is the cheapest adequate model')
  assert.equal(eligibilityOf('haiku', { need: v('haiku', 'low'), hm: null }).eligibility, 'ineligible', 'no AutoMode answer: no Haiku')
})

test('eligibility: the rule table decides Sonnet', () => {
  const t3 = hmOf('T3', 'complex')
  const sonnet = (need, hm, consequence) => eligibilityOf('sonnet', { need, hm, consequence }).eligibility
  assert.equal(sonnet(v('sonnet', 'high'), t3), 'eligible')
  assert.equal(sonnet(v('sonnet', 'medium'), t3), 'eligible', 'T3 alone never forces Opus: the rule table has no effort test')
  assert.equal(sonnet(v('opus', 'high'), t3), 'ineligible', 'T3 plus need=opus')
  assert.equal(sonnet(v('sonnet', 'high'), t3, 'critical'), 'ineligible', 'T3 plus critical')
  assert.equal(sonnet(v('sonnet', 'xhigh'), hmOf('T4')), 'ineligible', 'T4')
  assert.equal(sonnet(v('fable', 'high'), hmOf('T1')), 'ineligible', 'a Fable verdict')
  assert.equal(sonnet(v('opus', 'high'), hmOf('T1')), 'eligible', 'one judge naming Opus over T1 is not enough')
  assert.equal(sonnet(v('opus', 'high'), hmOf('T2'), 'critical'), 'eligible', 'critical needs T3 too')
  assert.equal(sonnet(v('opus', 'high'), null), 'ineligible', 'with no AutoMode answer T3 is unknown')
  assert.equal(sonnet(null, t3), 'needs-verdict')
  assert.equal(eligibilityOf('opus', { need: v('sonnet', 'low'), hm: hmOf('T1') }).eligibility, 'eligible', 'Opus is always eligible')
})

test('eligibility reads only the need: an answer about another model changes nothing', () => {
  assert.equal(effortlessFloor(v('sonnet', 'medium')), 1)
  assert.equal(effortlessFloor(null), null)
  const c = optimizeAuto(base({ hm: hmOf('T3', 'complex'), need: v('sonnet', 'high'), verdicts: { sonnet: v('sonnet', 'high'), opus: v('fable', 'high') } }))
  assert.equal(c.best.family, 'sonnet', 'a Fable answer about Opus is not the need')
  const o = optimizeAuto(base({ hm: hmOf('T4', 'complex'), need: v('sonnet', 'high'), verdicts: { sonnet: v('sonnet', 'high'), opus: v('opus', 'medium') } }))
  assert.equal(`${o.best.family}/${o.best.effort}`, 'opus/high')
  const f = optimizeAuto(base({ allowed: ['opus'], hm: hmOf('T1'), need: v('sonnet', 'low'), verdicts: { opus: v('fable', 'low') } }))
  assert.equal(f.best.effort, 'low', 'the hard-work floor reads the need as well')
})

test('first calls: the fixed anchor, and the running model when it differs, so a hold has an effort', () => {
  assert.equal(NEED_ANCHOR, 'sonnet')
  assert.deepEqual(firstCalls(undefined, undefined), ['sonnet'], 'a first prompt: the app model does not change the call')
  assert.deepEqual(firstCalls(undefined, 'sonnet'), ['sonnet'])
  assert.deepEqual(firstCalls(undefined, 'opus'), ['sonnet', 'opus'])
  assert.deepEqual(firstCalls(undefined, 'haiku'), ['sonnet', 'haiku'])
  assert.deepEqual(firstCalls('opus', 'sonnet'), ['opus'], 'a fixed model needs only its own verdict')
  assert.ok(judgeInputFor('fix it', { family: NEED_ANCHOR, effort: 'high', messages: [] }).includes('Current: sonnet'))
})

test('second call: only for a model that could win, at most one', () => {
  const i = (verdicts, hm, allowed = ['haiku', 'sonnet', 'opus'], floors = { because: [] }) => ({ allowed, verdicts, need: needOf(verdicts), hm, floors, current: null, cost })
  assert.equal(secondCall(i({ sonnet: v('sonnet', 'medium') }, hmOf('T1')), 'sonnet'), null, 'the anchor is eligible and nothing cheaper is')
  assert.equal(secondCall(i({ sonnet: v('haiku', 'low') }, hmOf('T0')), 'sonnet'), 'haiku', 'both judges name Haiku: ask Haiku for its own effort')
  assert.equal(secondCall(i({ sonnet: v('haiku', 'low') }, hmOf('T0'), ['sonnet', 'opus']), 'sonnet'), null, 'Haiku is out')
  assert.equal(secondCall(i({ sonnet: v('opus', 'high') }, hmOf('T3')), 'sonnet'), 'opus', 'the rules require Opus: ask it for its own effort')
  assert.equal(secondCall(i({ sonnet: v('opus', 'high') }, hmOf('T1')), 'sonnet'), null, 'need=opus over T1 stays on Sonnet')
  assert.equal(secondCall(i({ sonnet: v('sonnet', 'high') }, hmOf('T3'), ['haiku', 'opus']), 'sonnet'), 'opus', 'the anchor is unavailable: ask the model that can run')
  assert.equal(secondCall(i({ sonnet: v('haiku', 'low') }, hmOf('T0'), undefined, { fixedFamily: 'sonnet', because: [] }), 'sonnet'), null, 'a fixed model needs no second call')
})

test('selection: the rules pick the model; a second answer naming Opus changes nothing', () => {
  const t3 = hmOf('T3', 'complex')
  const c = optimizeAuto(base({ hm: t3, verdicts: { sonnet: v('sonnet', 'high'), opus: v('sonnet', 'medium') } }))
  assert.equal(c.best.family, 'sonnet')
  // Inverted on purpose. This pair ran on Opus before A9: the answer about Opus named Opus and took Sonnet out.
  const o = optimizeAuto(base({ hm: t3, verdicts: { sonnet: v('sonnet', 'high'), opus: v('opus', 'medium') } }))
  assert.equal(o.best.family, 'sonnet', 'only the need names a model')
  assert.equal(o.rule, 'the weakest eligible model')
  const d = optimizeAuto(base({ hm: t3, verdicts: { sonnet: v('sonnet', 'medium'), opus: v('opus', 'medium') } }))
  assert.equal(`${d.best.family}/${d.best.effort}`, 'sonnet/medium', 'the effort is the chosen model\'s own verdict')
  for (const x of [...c.candidates, ...d.candidates]) assert.equal('robustUsd' in x, false)
})

test('price is only a tie-break: it never brings Opus in', () => {
  const low = optimizeAuto(base({ hm: hmOf('T1'), verdicts: { sonnet: v('sonnet', 'high'), opus: v('opus', 'low') } }))
  assert.ok(cost('opus', 'low') < cost('sonnet', 'high'), 'Opus low is the cheaper attempt here')
  assert.equal(`${low.best.family}/${low.best.effort}`, 'sonnet/high')
  const tie = optimizeAuto(base({ hm: hmOf('T0', 'trivial'), need: v('haiku', 'low'), verdicts: { sonnet: v('haiku', 'low'), haiku: v('haiku', 'low') } }))
  assert.equal(tie.rule, 'cheapest eligible pair')
  assert.equal(tie.best.family, 'haiku')
  const dear = optimizeAuto(base({ hm: hmOf('T0', 'trivial'), need: v('haiku', 'low'), verdicts: { sonnet: v('haiku', 'low'), haiku: v('haiku', 'max') }, cost: (f, e) => (f === 'haiku' ? 9 : cost(f, e)) }))
  assert.equal(dear.best.family, 'sonnet', 'between two adequate models the cheaper one runs')
})

test('start invariance: same task, same verdicts, any start: the same first route', () => {
  const tasks = [
    [hmOf('T1'), undefined, v('sonnet', 'medium'), v('opus', 'low')],
    [hmOf('T1'), undefined, v('opus', 'high'), v('opus', 'high')],     // xmltodict: Opus named, T1
    [hmOf('T3', 'complex'), undefined, v('sonnet', 'high'), v('opus', 'high')],
    [hmOf('T3', 'complex'), undefined, v('opus', 'high'), v('opus', 'high')],
    [hmOf('T3', 'complex'), 'critical', v('sonnet', 'high'), v('opus', 'xhigh')],
    [hmOf('T2'), undefined, v('sonnet', 'high'), v('fable', 'medium')],
    [hmOf('T4', 'complex'), undefined, v('sonnet', 'high'), v('opus', 'medium')],
  ]
  for (const [hm, consequence, need, opus] of tasks) {
    const route = (running) => {
      // What decideAuto holds on each start: the calls firstCalls makes, then the one secondCall names.
      const verdicts = Object.fromEntries(firstCalls(undefined, running).map((f) => [f, f === 'opus' ? opus : need]))
      const input = base({ hm, consequence, need, verdicts, current: running ? { family: running, effort: 'medium' } : null })
      const second = secondCall({ ...input, current: null }, 'sonnet')
      const { best } = optimizeAuto(second ? { ...input, verdicts: { ...verdicts, [second]: second === 'opus' ? opus : need } } : input)
      return `${best.family}/${best.effort}`
    }
    assert.equal(route('opus'), route('sonnet'), JSON.stringify({ hm, need, opus }))
    assert.equal(route(undefined), route('sonnet'), 'a first prompt reads the same')
  }
})

test('runningRuledOut: T4 and real work on Haiku are mandatory moves', () => {
  const t4 = optimizeAuto(base({ hm: hmOf('T4', 'complex'), verdicts: { sonnet: v('sonnet', 'high'), opus: v('opus', 'high') } }))
  assert.equal(runningRuledOut('sonnet', t4, { because: [] }, hmOf('T4', 'complex')), true)
  const work = optimizeAuto(base({ hm: hmOf('T2'), verdicts: { sonnet: v('sonnet', 'high'), haiku: v('haiku', 'low') } }))
  assert.equal(work.candidates.find((c) => c.family === 'haiku').eligibility, 'ineligible')
  assert.equal(runningRuledOut('haiku', work, { because: [] }, hmOf('T2')), true)
})

test('a T4 upgrade is not stopped by the discretionary switch limit', () => {
  const hm = hmOf('T4', 'complex')
  const choice = optimizeAuto(base({ hm, verdicts: { sonnet: v('sonnet', 'high'), opus: v('opus', 'high') } }))
  const r = resolve({
    floor: { tier: 'T0', because: [] }, candidate: { tier: 'T3', source: 'judge', confidence: 0.9, reason: 'case' }, effortHint: 'high',
    currentInadequate: runningRuledOut('sonnet', choice, { because: [] }, hm),
    current: { tier: 'T2', family: 'sonnet', model: 'claude-sonnet-5-5', effort: 'high' },
    switchInput: { cache: { model: 'claude-sonnet-5-5', effort: 'high', prefixTokens: 120_000, lastRequestAt: 1_000, ttlMs: 3_600_000, effortSharesCache: true }, now: 2_000, votes: 1, requestsSinceSwitch: 1, verifiedSinceSwitch: false, sameTask: true, risk: 'none', expectedOutputTokens: 600, prices: ANTHROPIC, requestsInPrompt: 0, switchesThisTask: 3 },
  })
  assert.equal(r.family, 'opus')
  assert.equal(r.owner, 'quality-escalation')
})

test('a missing need is no reason for Opus: Sonnet, unless a rule requires Opus', () => {
  const current = { family: 'opus', effort: 'medium' }
  const old = optimizeAuto(base({ allowed: ['sonnet', 'opus'], hm: hmOf('T1'), need: null, verdicts: { opus: v('opus', 'medium') }, current }))
  assert.equal(`${old.best.family}/${old.best.effort}`, 'sonnet/medium', 'a snapshot from before the need')
  assert.equal(old.inadequate, false)
  const big = optimizeAuto(base({ allowed: ['sonnet', 'opus'], hm: hmOf('T1'), need: null, verdicts: { haiku: v('haiku', 'medium') }, current: { family: 'haiku', effort: 'medium' } }))
  assert.equal(big.best.family, 'sonnet', 'Haiku over its context limit with a failed need call')
  assert.equal(optimizeAuto(base({ hm: hmOf('T4', 'complex'), need: null, current })).best.family, 'opus')
  assert.equal(optimizeAuto(base({ hm: hmOf('T3', 'complex'), consequence: 'critical', need: null, current })).best.family, 'opus')
  assert.equal(optimizeAuto(base({ allowed: ['opus'], hm: hmOf('T1'), need: null, current })).best.family, 'opus', 'nothing else is available')
})

test('runningRuledOut: an upgrade the judges ask for on Sonnet goes through the gate', () => {
  const judgesOnly = optimizeAuto(base({ hm: hmOf('T3', 'complex'), need: v('opus', 'high'), verdicts: { sonnet: v('opus', 'high'), opus: v('opus', 'high') } }))
  assert.equal(judgesOnly.best.family, 'opus')
  assert.equal(judgesOnly.candidates.find((c) => c.family === 'sonnet').eligibility, 'ineligible')
  assert.equal(runningRuledOut('sonnet', judgesOnly, { because: [] }, hmOf('T3', 'complex')), false, 'the judges alone: the normal gate')
  const floors = { exclude: { sonnet: 'an escalation floor' }, because: ['an escalation floor'] }
  const escalated = optimizeAuto(base({ hm: hmOf('T2'), need: v('sonnet', 'high'), verdicts: { sonnet: v('sonnet', 'high'), opus: v('opus', 'high') }, floors }))
  assert.equal(escalated.best.family, 'opus', 'an escalation floor requires Opus')
  assert.equal(runningRuledOut('sonnet', escalated, floors), true)
  const gone = optimizeAuto(base({ allowed: ['sonnet', 'opus'], hm: hmOf('T1'), verdicts: { sonnet: v('sonnet', 'high') } }))
  assert.equal(runningRuledOut('haiku', gone, { because: [] }), true, 'a provider limit')
  assert.equal(runningRuledOut(undefined, gone, { because: [] }), false)
})

test('hard work never runs Opus below high: T4 and a Fable verdict, whatever the verdict effort', () => {
  const t4 = optimizeAuto(base({ hm: hmOf('T4', 'complex'), verdicts: { opus: v('sonnet', 'medium') } }))
  assert.equal(`${t4.best.family}/${t4.best.effort}`, 'opus/high')
  assert.ok(t4.best.why.includes('floor high'), 'the floor is recorded')
  const fable = optimizeAuto(base({ hm: hmOf('T3', 'complex'), need: v('fable', 'high'), verdicts: { opus: v('fable', 'medium') } }))
  assert.equal(`${fable.best.family}/${fable.best.effort}`, 'opus/high')
  const higher = optimizeAuto(base({ hm: hmOf('T4', 'complex'), verdicts: { opus: v('opus', 'xhigh') } }))
  assert.equal(higher.best.effort, 'xhigh', 'the floor never lowers a verdict')
})

test('the hard-work floor also holds when Opus is the strongest available without an eligible pair', () => {
  const c = optimizeAuto(base({ allowed: ['opus'], hm: hmOf('T4', 'complex'), verdicts: { sonnet: v('fable', 'low') } }))
  assert.equal(`${c.best.family}/${c.best.effort}`, 'opus/high')
  const none = optimizeAuto(base({ allowed: ['opus'], hm: null, verdicts: { sonnet: v('fable', 'low') }, current: { family: 'opus', effort: 'medium' } }))
  assert.equal(`${none.best.family}/${none.best.effort}`, 'opus/high', 'a Fable verdict counts without the AutoMode judge')
})

test('the hard-work floor stays narrow: T3 and a user effort are not lifted', () => {
  const t3 = optimizeAuto(base({ hm: hmOf('T3', 'complex'), verdicts: { opus: v('opus', 'medium') } }))
  assert.equal(`${t3.best.family}/${t3.best.effort}`, 'opus/medium')
  const user = optimizeAuto(base({ hm: hmOf('T4', 'complex'), verdicts: { opus: v('opus', 'medium') }, floors: { fixedEffort: 'low', because: [] } }))
  assert.equal(user.best.effort, 'low', 'an explicit user effort wins')
  const sonnet = optimizeAuto(base({ hm: hmOf('T2'), verdicts: { sonnet: v('sonnet', 'medium') } }))
  assert.equal(`${sonnet.best.family}/${sonnet.best.effort}`, 'sonnet/medium', 'the floor is for Opus only')
})

test('T3 and T4 never run at low on the last model standing', () => {
  const c = optimizeAuto(base({ allowed: ['sonnet'], hm: hmOf('T4', 'complex'), verdicts: { sonnet: v('sonnet', 'low') } }))
  assert.equal(`${c.best.family}/${c.best.effort}`, 'sonnet/medium')
  assert.equal(c.inadequate, true, 'still labeled inadequate')
  const t3 = optimizeAuto(base({ hm: hmOf('T3', 'complex'), verdicts: { sonnet: v('sonnet', 'low') } }))
  assert.equal(`${t3.best.family}/${t3.best.effort}`, 'sonnet/medium', 'Sonnet takes T3 work at medium or above')
  const user = optimizeAuto(base({ allowed: ['sonnet'], hm: hmOf('T3', 'complex'), verdicts: { sonnet: v('sonnet', 'low') }, floors: { fixedEffort: 'low', because: [] } }))
  assert.equal(user.best.effort, 'low', 'an explicit user effort wins')
})

test('each model gets its own verdict effort: no conversion between models', () => {
  const c = optimizeAuto(base({ hm: hmOf('T2'), verdicts: { sonnet: v('sonnet', 'xhigh'), opus: v('sonnet', 'low') } }))
  assert.equal(c.candidates.find((x) => x.family === 'sonnet').effort, 'xhigh')
  assert.equal(c.candidates.find((x) => x.family === 'opus').effort, 'low')
})

test('a model without its own verdict is never priced or picked', () => {
  const c = optimizeAuto(base({ hm: hmOf('T1'), verdicts: { opus: v('sonnet', 'medium') } }))
  assert.equal(c.best.family, 'opus')
  assert.equal(c.candidates.find((x) => x.family === 'sonnet').eligibility, 'needs-verdict')
})

test('floors: upstream bounded() lifts an effort to the quality floor; the user effort wins over it', () => {
  const c = optimizeAuto(base({ verdicts: { sonnet: v('sonnet', 'low') }, floors: { effortMin: { sonnet: 'high' }, because: ['escalation'] } }))
  assert.equal(c.best.effort, 'high')
  const u = optimizeAuto(base({ verdicts: { sonnet: v('sonnet', 'low') }, floors: { effortMin: { sonnet: 'high' }, fixedEffort: 'medium', because: [] } }))
  assert.equal(u.best.effort, 'medium')
})

test('judge disagreement on effort: a T3 task never runs at low', () => {
  const c = optimizeAuto(base({ hm: hmOf('T3', 'complex'), verdicts: { opus: v('opus', 'low') } }))
  assert.equal(c.best.effort, 'medium')
  assert.ok(c.best.why.some((w) => /judges disagree/.test(w)))
})

test('a user model command fixes the model; unavailable models stay out', () => {
  const c = optimizeAuto(base({ verdicts: { sonnet: v('sonnet', 'medium'), opus: v('opus', 'high') }, floors: { fixedFamily: 'opus', because: [] } }))
  assert.equal(c.best.family, 'opus')
  const u = optimizeAuto(base({ allowed: ['opus'], verdicts: { sonnet: v('sonnet', 'medium'), opus: v('opus', 'high') } }))
  assert.equal(u.best.family, 'opus')
  assert.equal(u.candidates.find((x) => x.family === 'sonnet').eligibility, 'unavailable')
})

test('nothing eligible: the strongest available, labeled inadequate', () => {
  const c = optimizeAuto(base({ allowed: ['haiku', 'sonnet'], hm: hmOf('T4', 'complex'), verdicts: { sonnet: v('opus', 'high') } }))
  assert.equal(c.inadequate, true)
  assert.equal(c.best.family, 'sonnet')
  assert.equal(c.best.effort, 'high')
})

test('a cost tie keeps the running model', () => {
  const c = optimizeAuto(base({ hm: hmOf('T0', 'trivial'), current: { family: 'sonnet', effort: 'medium' }, cost: () => 1, need: v('haiku', 'low'), verdicts: { sonnet: v('haiku', 'medium'), haiku: v('haiku', 'medium') } }))
  assert.equal(c.best.family, 'sonnet')
})

test('escalation: one step up, never past its tier; no max after two failures on high', () => {
  assert.deepEqual(escalationTarget({ family: 'opus', effort: 'high' }, 'T4', ['sonnet', 'opus']), { family: 'opus', effort: 'xhigh', band: 4 })
  assert.deepEqual(escalationTarget({ family: 'opus', effort: 'xhigh' }, 'T4', ['sonnet', 'opus']), { family: 'opus', effort: 'max', band: 5 })
  assert.deepEqual(escalationTarget({ family: 'sonnet', effort: 'medium' }, 'T3', ['sonnet', 'opus']), { family: 'sonnet', effort: 'high', band: 2 })
  assert.deepEqual(escalationTarget({ family: 'sonnet', effort: 'high' }, 'T3', ['sonnet', 'opus']), { family: 'opus', effort: 'high', band: 3 })
  assert.equal(escalationTarget({ family: 'opus', effort: 'high' }, 'T3', ['sonnet', 'opus']).effort, 'high', 'a T3 floor does not raise Opus high')
  assert.deepEqual(escalationTarget({ family: 'opus', effort: 'xhigh' }, 'T3', ['sonnet', 'opus']), { family: 'opus', effort: 'xhigh', band: 4 }, 'never lower than the running route')
})

test('resolution step 4 and 5: the shortcut never skips a required decision or a closing remark', () => {
  const told = 'user: add export\nassistant: Added the button. Next I wire it up.'
  const none = decisionRequired({})
  assert.equal(none.required, false)
  assert.equal(shortcutApplies(keepsEffort('continue', told), 'continue', none), true)
  assert.equal(shortcutApplies(keepsEffort('ok', told), 'ok', none), false, 'an ok goes to the judge')
  assert.equal(shortcutApplies(keepsEffort('commit', told), 'commit', none), false)
  assert.equal(shortcutApplies(keepsEffort('done', told), 'done', none), false)
  const plan = decisionRequired({ planExited: true })
  assert.deepEqual(plan.why, ['planExited'])
  assert.equal(shortcutApplies(keepsEffort('continue', told), 'continue', plan), false, 'continue after a plan exit is judged')
  const asked = 'user: tidy up\nassistant: Done. Should I archive it?'
  assert.equal(shortcutApplies(keepsEffort('go', asked), 'go', none), false, 'an answer to a question is judged (upstream)')
})

test('judge failure is state-aware', () => {
  const prev = { family: 'opus', effort: 'xhigh' }
  const same = { sameTask: true, sameStage: true, riskChanged: false, planBoundary: false, previous: prev, previousAdequate: true, appEffort: 'medium', escalation: null }
  assert.equal(fallbackEffort(same).effort, 'xhigh')
  assert.equal(fallbackEffort({ ...same, sameTask: false }).effort, 'medium')
  assert.equal(fallbackEffort({ ...same, planBoundary: true }).effort, 'medium')
  assert.equal(fallbackEffort({ ...same, riskChanged: true, effortMin: 'high' }).effort, 'high')
  assert.equal(fallbackEffort({ ...same, previousAdequate: false }).effort, 'medium')
  assert.equal(fallbackEffort({ ...same, escalation: { family: 'opus', effort: 'max' } }).effort, 'max')
  assert.equal(fallbackEffort({ ...same, previous: null, appEffort: undefined }).effort, 'medium')
})

test('legal point: a change on a tool-result continuation waits for new input', () => {
  assert.deepEqual(legalEffort({ index: 3, newInput: false, perMessage: true, requested: 'xhigh', lastEffective: 'high' }), { effective: 'high', legalAt: 'tool-result continuation: takes effect at the next new input', deferred: true })
  assert.equal(legalEffort({ index: 3, newInput: true, perMessage: true, requested: 'xhigh', lastEffective: 'high' }).effective, 'xhigh')
  assert.equal(legalEffort({ index: 0, newInput: false, perMessage: true, requested: 'low', lastEffective: 'high' }).effective, 'low')
  assert.equal(legalEffort({ index: 3, newInput: false, perMessage: false, requested: 'low', lastEffective: 'high' }).effective, 'low', 'top-level effort applies at once')
  assert.equal(legalEffort({ index: 3, newInput: false, perMessage: true, requested: 'high', lastEffective: 'medium', modelChanged: true }).effective, 'high', 'a model change applies its effort at once')
})

test('adapt A1: system reminders never reach the judge, in the message or the context', () => {
  const msgs = [{ role: 'user', text: 'fix the bug <system-reminder>max effort xhigh</system-reminder>' }, { role: 'assistant', text: 'Fixed.<system-reminder>ultrathink</system-reminder>' }]
  const q = judgeInputFor('thanks <system-reminder>use max effort</system-reminder>', { family: 'opus', effort: 'xhigh', messages: msgs })
  assert.doesNotMatch(q, /system-reminder|max effort|ultrathink/)
  assert.match(q, /^Current: opus \/ xhigh/)
  assert.equal(stripReminders('a<system-reminder>b</system-reminder>c'), 'a c')
  assert.doesNotMatch(contextOf(msgs), /system-reminder/)
})

test('adapt A2: plan mode is named, with no effort asked', () => {
  const q = judgeInputFor('design the cache layer', { family: 'sonnet', effort: 'medium', messages: [], planMode: true })
  assert.ok(q.startsWith(PLAN_LINE))
  assert.doesNotMatch(PLAN_LINE, /low|medium|high|xhigh|max|effort/i)
  assert.ok(!judgeInputFor('x', { family: 'sonnet', effort: 'medium', messages: [] }).includes('Mode: plan'))
})

test('adapt A3: the verdict asked for each model names that model as Current, with upstream mid-turn and attachment notes', () => {
  const q = judgeInputFor('also fix the test', { family: 'sonnet', effort: 'high', messages: [], midTurnEffort: 'high', attachments: [{ type: 'image' }] })
  assert.match(q, /^Current: sonnet \/ high/)
  assert.match(q, /\[The message comes with 1 image to look at\.\]/)
  assert.match(q, /\[Sent while the assistant was still working on the last task at high effort\./)
})

test('cache writes are priced by their lifetime: 1.25x input for 5 minutes, 2x for 1 hour', async () => {
  const { usageUsd, ANTHROPIC } = await import('../hooks/lib/prices.ts')
  const r = ANTHROPIC.rates.sonnet
  const w5 = usageUsd({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 1_000_000, cacheWrite1h: 0 }, r)
  const w1 = usageUsd({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 1_000_000 }, r)
  assert.equal(w5, r.input * 1.25)
  assert.equal(w1, r.input * 2)
})

test('fallbackModel: when the effortless judge fails, the AutoMode judge decides the model, up or down', () => {
  const all = ['haiku', 'sonnet', 'opus']
  assert.equal(fallbackModel('sonnet', { tier: 'T3', effort: 'high' }, all).family, 'opus')
  assert.equal(fallbackModel('sonnet', { tier: 'T3', effort: 'high' }, all).effort, 'high')
  assert.equal(fallbackModel('sonnet', { tier: 'T0', effort: 'low' }, all).family, 'haiku', 'a lookup keeps its cheap route when one judge fails')
  assert.equal(fallbackModel('sonnet', { tier: 'T0', effort: 'low' }, ['sonnet', 'opus']).family, 'sonnet', 'Haiku out: the model stays')
  assert.equal(fallbackModel('sonnet', { tier: 'T0' }, all, 'critical').family, 'sonnet', 'critical work never goes to Haiku')
  assert.equal(fallbackModel('opus', { tier: 'T1', confidence: 0.2 }, all, 'none', 0.3).family, 'opus', 'a low-confidence judge never moves cheaper')
  assert.equal(fallbackModel('haiku', { tier: 'T2', effort: 'medium' }, all).family, 'sonnet')
  assert.equal(fallbackModel('sonnet', null, all).family, 'sonnet', 'both failed: the model stays')
})

// A8: real prompts that ask for work made the judge do the work instead of judging it (14 of 27 calls, 2026-10-26).
test('A8: the closing line comes only on the retry, after the message, and names no model or effort', () => {
  const first = judgeInputFor('Draft the Slack reply', { family: 'sonnet', effort: 'high', messages: [] })
  assert.ok(!first.includes(CLOSING_LINE))
  const q = judgeInputFor('Draft the Slack reply', { family: 'sonnet', effort: 'high', messages: [], closing: true })
  assert.ok(q.endsWith(CLOSING_LINE))
  assert.ok(q.indexOf('Draft the Slack reply') < q.indexOf(CLOSING_LINE))
  assert.ok(!/haiku|sonnet|opus|low|medium|high/i.test(CLOSING_LINE))
  assert.ok(judgeInputFor('x', { family: 'sonnet', effort: 'high', messages: [], planMode: true, closing: true }).endsWith(CLOSING_LINE))
})
