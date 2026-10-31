// @ts-nocheck TODO(types): 44 errors with strict off. Fix them and delete this line to turn checking on for this file.
// Unit tests for the AutoMode Auto pure modules: lib/auto.ts (joint optimizer, escalation step, resolution helpers,
// judge-failure table, legal effort point) and lib/effortless-adapt.ts (documented judge-input changes).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { optimizeAuto, eligibilityOf, effortlessFloor, secondCall, fallbackModel, escalationTarget, decisionRequired, shortcutApplies, fallbackEffort, legalEffort } from '../hooks/lib/auto.ts'
import { judgeInputFor, contextOf, PLAN_LINE, CLOSING_LINE, stripReminders } from '../hooks/lib/effortless-adapt.ts'
import { keepsEffort } from '../hooks/lib/effortless.ts'

// A cost that scales with the model price (Opus 2x Sonnet, Haiku 0.05x) and the effort output prior.
const PRICE = { haiku: 0.05, sonnet: 1, opus: 2 }
const OUT = { low: 0.6, medium: 1, high: 1.36, xhigh: 1.5, max: 1.8 }
const cost = (f, e) => PRICE[f] * OUT[e]
const v = (model, effort, why = '') => ({ model, effort, why })
const base = (over = {}) => ({ allowed: ['haiku', 'sonnet', 'opus'], verdicts: {}, hm: { tier: 'T1', complexity: 'standard' }, floors: { because: [] }, current: null, cost, ...over })

const hmOf = (tier, complexity = 'standard') => ({ tier, complexity })

test('eligibility: Haiku needs both judges; an effort verdict alone never makes Haiku eligible', () => {
  assert.equal(eligibilityOf('haiku', { verdicts: { haiku: v('haiku', 'high') }, hm: hmOf('T2') }).eligibility, 'ineligible')
  assert.equal(eligibilityOf('haiku', { verdicts: { sonnet: v('haiku', 'low') }, hm: hmOf('T0') }).eligibility, 'eligible')
  assert.equal(eligibilityOf('haiku', { verdicts: { sonnet: v('sonnet', 'low') }, hm: hmOf('T0') }).eligibility, 'ineligible', 'effortless says sonnet is the cheapest adequate model')
  assert.equal(eligibilityOf('haiku', { verdicts: { sonnet: v('haiku', 'low') }, hm: null }).eligibility, 'ineligible', 'no AutoMode answer: no Haiku')
})

test('eligibility: T3 does not force Opus; Sonnet at high or above stays eligible when effortless says Sonnet suffices', () => {
  const t3 = hmOf('T3', 'complex')
  assert.equal(eligibilityOf('sonnet', { verdicts: { sonnet: v('sonnet', 'high') }, hm: t3 }).eligibility, 'eligible')
  assert.equal(eligibilityOf('sonnet', { verdicts: { sonnet: v('sonnet', 'xhigh') }, hm: t3 }).eligibility, 'eligible')
  assert.equal(eligibilityOf('sonnet', { verdicts: { sonnet: v('sonnet', 'medium') }, hm: t3 }).eligibility, 'ineligible', 'Sonnet at medium does not take Opus-tier work')
  assert.equal(eligibilityOf('sonnet', { verdicts: { opus: v('sonnet', 'medium') }, hm: t3 }).eligibility, 'needs-verdict', 'Sonnet needs its own effort verdict first')
  assert.equal(eligibilityOf('sonnet', { verdicts: { sonnet: v('opus', 'high') }, hm: t3 }).eligibility, 'ineligible', 'effortless itself says Opus')
  assert.equal(eligibilityOf('sonnet', { verdicts: { sonnet: v('sonnet', 'high') }, hm: t3, consequence: 'critical' }).eligibility, 'ineligible', 'a critical task under disagreement takes the stronger model')
  assert.equal(eligibilityOf('sonnet', { verdicts: { sonnet: v('sonnet', 'xhigh') }, hm: hmOf('T4') }).eligibility, 'ineligible')
  assert.equal(eligibilityOf('opus', { verdicts: { sonnet: v('sonnet', 'low') }, hm: hmOf('T1') }).eligibility, 'eligible', 'Opus is always eligible')
})

test('eligibility: several effortless answers count by the most demanding one', () => {
  assert.equal(effortlessFloor({ sonnet: v('haiku', 'low'), opus: v('sonnet', 'medium') }), 1)
  assert.equal(eligibilityOf('haiku', { verdicts: { sonnet: v('haiku', 'low'), opus: v('sonnet', 'medium') }, hm: hmOf('T0') }).eligibility, 'ineligible')
})

test('second call: only for a model that could win, at most one', () => {
  const i = (verdicts, hm, allowed = ['haiku', 'sonnet', 'opus'], floors = { because: [] }) => ({ allowed, verdicts, hm, floors, current: null, cost })
  assert.equal(secondCall(i({ sonnet: v('sonnet', 'medium') }, hmOf('T1')), 'sonnet'), null, 'the anchor is eligible and nothing cheaper is')
  assert.equal(secondCall(i({ sonnet: v('haiku', 'low') }, hmOf('T0')), 'sonnet'), 'haiku', 'both judges name Haiku: ask Haiku for its own effort')
  assert.equal(secondCall(i({ sonnet: v('haiku', 'low') }, hmOf('T0'), ['sonnet', 'opus']), 'sonnet'), null, 'Haiku is out')
  assert.equal(secondCall(i({ sonnet: v('opus', 'high') }, hmOf('T3')), 'sonnet'), 'opus', 'the anchor is out: ask the model that can win')
  assert.equal(secondCall(i({ opus: v('sonnet', 'medium') }, hmOf('T2')), 'opus'), 'sonnet', 'a cheaper eligible model')
  assert.equal(secondCall(i({ sonnet: v('haiku', 'low') }, hmOf('T0'), undefined, { fixedFamily: 'sonnet', because: [] }), 'sonnet'), null, 'a fixed model needs no second call')
})

test('selection: the cheapest eligible pair; no retry charge, no score', () => {
  const t3 = hmOf('T3', 'complex')
  const c = optimizeAuto(base({ hm: t3, verdicts: { sonnet: v('sonnet', 'high'), opus: v('sonnet', 'medium') } }))
  assert.equal(c.best.family, 'sonnet', 'Sonnet high costs less than Opus medium here')
  const o = optimizeAuto(base({ hm: t3, verdicts: { sonnet: v('sonnet', 'high'), opus: v('opus', 'medium') } }))
  assert.equal(o.best.family, 'opus', 'one effortless answer naming Opus makes Sonnet ineligible: the most demanding answer counts')
  assert.equal(c.rule, 'cheapest eligible pair')
  const d = optimizeAuto(base({ hm: t3, verdicts: { sonnet: v('sonnet', 'medium'), opus: v('opus', 'medium') } }))
  assert.equal(d.best.family, 'opus', 'Sonnet at medium is not eligible for T3')
  for (const x of [...c.candidates, ...d.candidates]) assert.equal('robustUsd' in x, false)
})

test('hard work never runs Opus below high: T4 and a Fable verdict, whatever the verdict effort', () => {
  const t4 = optimizeAuto(base({ hm: hmOf('T4', 'complex'), verdicts: { opus: v('sonnet', 'medium') } }))
  assert.equal(`${t4.best.family}/${t4.best.effort}`, 'opus/high')
  assert.ok(t4.best.why.includes('floor high'), 'the floor is recorded')
  const fable = optimizeAuto(base({ hm: hmOf('T3', 'complex'), verdicts: { opus: v('fable', 'medium') } }))
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
  const c = optimizeAuto(base({ allowed: ['sonnet'], hm: hmOf('T3', 'complex'), verdicts: { sonnet: v('sonnet', 'low') } }))
  assert.equal(`${c.best.family}/${c.best.effort}`, 'sonnet/medium')
  assert.equal(c.inadequate, true, 'still labeled inadequate')
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
  const c = optimizeAuto(base({ current: { family: 'opus', effort: 'medium' }, cost: () => 1, verdicts: { sonnet: v('sonnet', 'medium'), opus: v('opus', 'medium') } }))
  assert.equal(c.best.family, 'opus')
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
