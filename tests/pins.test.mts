// Pins (lib/pins.ts): what reads as the person's choice, what does not, and who wins.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPins, commandChoice, readAppChoice, turnAxes } from '../hooks/lib/pins.ts'
import { DEFAULT_LADDER, routeFor } from '../hooks/lib/authority.ts'

const SONNET = 'claude-sonnet-5-5', OPUS = 'claude-opus-5-5', FABLE = 'claude-fable-5-5'
const route = (tier): any => ({ ...routeFor(tier), owner: 'judge' })

test('a change in the app value is a pin, whatever the route runs: no echo guard', () => {
  assert.equal(readAppChoice({ model: SONNET, effort: 'medium' }, { model: OPUS, effort: 'medium' }, {}, false).family, 'opus')
  assert.equal(readAppChoice({ model: SONNET, effort: 'medium' }, { model: SONNET, effort: 'high' }, {}, false).effort, 'high')
})

test('no change, a first request, a value already pinned: no pin', () => {
  assert.deepEqual(readAppChoice({ model: SONNET, effort: 'medium' }, { model: SONNET, effort: 'medium' }, {}, false), { unroutable: false, skipped: [] })
  assert.deepEqual(readAppChoice({}, { model: OPUS, effort: 'xhigh' }, {}, false), { unroutable: false, skipped: [] })
  assert.equal(readAppChoice({ model: SONNET }, { model: OPUS }, { family: 'opus' }, false).family, undefined)
  assert.equal(readAppChoice({ effort: 'low' }, { model: SONNET, effort: 'high' }, { effort: 'high' }, false).effort, undefined)
})

test('plan mode: the engine moves the model, so nothing pins, and the skip is reported', () => {
  const c = readAppChoice({ model: SONNET, effort: 'medium' }, { model: OPUS, effort: 'high' }, {}, true)
  assert.deepEqual([c.family, c.effort], [undefined, undefined])
  assert.deepEqual(c.skipped, ['model: plan mode', 'effort: moved with the model'])
  assert.deepEqual(readAppChoice({ model: SONNET, effort: 'medium' }, { model: SONNET, effort: 'high' }, {}, true).skipped, ['effort: plan mode'])
})

test('a model change carries its default effort: that is not an effort pin', () => {
  const c = readAppChoice({ model: SONNET, effort: 'high' }, { model: OPUS, effort: 'medium' }, {}, false)
  assert.equal(c.family, 'opus')
  assert.equal(c.effort, undefined)
})

test('an unknown or Fable model turns routing off and pins nothing', () => {
  for (const seen of [{}, { model: SONNET }]) {
    const c = readAppChoice(seen, { model: FABLE }, {}, false)
    assert.equal(c.unroutable, true)
    assert.equal(c.family, undefined)
  }
  assert.equal(readAppChoice({}, { model: 'my-gateway-model' }, {}, false).unroutable, true)
  assert.equal(readAppChoice({ model: FABLE }, { model: SONNET }, {}, false).unroutable, false)
  assert.equal(readAppChoice({}, {}, {}, false).unroutable, false, 'a request with no model says nothing')
})

test('commands: a named value pins, a picker or opusplan does not, default and auto hand back', () => {
  assert.deepEqual(commandChoice('model', 'opus'), { family: 'opus' })
  assert.deepEqual(commandChoice('model', ' claude-sonnet-5-5[1m] '), { family: 'sonnet' })
  assert.deepEqual(commandChoice('effort', 'XHIGH'), { effort: 'xhigh' })
  assert.deepEqual(commandChoice('model', 'default'), { release: true })
  assert.deepEqual(commandChoice('effort', 'auto'), { release: true })
  for (const [c, a] of [['model', ''], ['effort', ''], ['model', 'opusplan'], ['model', 'fable'], ['effort', 'hard']]) assert.equal(commandChoice(c, a), null, `${c} ${a}`)
})

test('applyPins: an am: command beats a pin, on the axis it names', () => {
  const opus = route('T3')
  assert.equal(applyPins(route('T1'), { family: 'haiku' }, { family: 'sonnet' }, SONNET, DEFAULT_LADDER.models).family, 'sonnet')
  const r = applyPins(opus, { family: 'sonnet', effort: 'low' }, { effort: 'xhigh' }, SONNET, DEFAULT_LADDER.models)
  assert.deepEqual([r.family, r.effort, r.owner], ['sonnet', 'xhigh', 'user-override'])
})

test('applyPins: nothing to change keeps the route and its owner; the model id matches the pin', () => {
  const opus = route('T3')
  assert.equal(applyPins(opus, {}, {}, SONNET, DEFAULT_LADDER.models), opus)
  assert.equal(applyPins(opus, { family: 'opus', effort: 'high' }, {}, SONNET, DEFAULT_LADDER.models), opus)
  assert.equal(applyPins(opus, { family: 'sonnet' }, {}, `${SONNET}[1m]`, DEFAULT_LADDER.models).model, `${SONNET}[1m]`)
  assert.equal(applyPins(opus, { family: 'haiku' }, {}, SONNET, DEFAULT_LADDER.models).model, DEFAULT_LADDER.models.haiku, 'a pin ahead of the app names the pinned model')
})

test('turnAxes: what a command fixes for its turn', () => {
  assert.deepEqual(turnAxes({ tier: 'T3' }, routeFor('T3')), { family: 'opus' })
  assert.deepEqual(turnAxes({ tier: 'T4' }, routeFor('T4')), { family: 'opus', effort: 'max' })
  assert.deepEqual(turnAxes({ effort: 'high' }, routeFor('T1', DEFAULT_LADDER, 'high')), { effort: 'high' })
  assert.equal(turnAxes({ reset: true } as never, routeFor('T1')), null)
  assert.equal(turnAxes(null, routeFor('T1')), null)
})
