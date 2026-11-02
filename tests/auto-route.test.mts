// The pure policy-auto route (hooks/lib/auto-route.ts): the golden cases in tests/golden/decisions.json `auto`, and
// the contract. The input holds no functions, routeAuto never changes its input, and the second verdict never
// changes the plan. tests/auto-route-equivalence.test.ts checks the same route through the engine.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { planAuto, routeAuto } from '../hooks/lib/auto-route.ts'
import { input, outcome, type Given } from './auto-route-fixture.mts'

const here = path.dirname(fileURLToPath(import.meta.url))
const golden = JSON.parse(fs.readFileSync(path.join(here, 'golden', 'decisions.json'), 'utf8'))

for (const g of golden.auto) {
  test(`golden auto: ${g.name}`, () => {
    assert.deepEqual(outcome(input(g.given)), g.expect)
  })
}

test('the input is plain data: a JSON round trip gives the same route', () => {
  for (const g of golden.auto) {
    const i = input(g.given)
    const copy = JSON.parse(JSON.stringify(i))
    assert.deepEqual(JSON.parse(JSON.stringify(routeAuto(copy))), JSON.parse(JSON.stringify(routeAuto(i))), g.name)
  }
})

test('routeAuto never changes its input', () => {
  const freeze = (o: any): any => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) freeze(v) } return o }
  for (const g of golden.auto) assert.doesNotThrow(() => routeAuto(freeze(input(g.given))), g.name)
})

test('the second verdict never changes the plan', () => {
  for (const g of golden.auto.filter((x: any) => x.given.second)) {
    const full = input(g.given)
    const first = { ...full, verdicts: Object.fromEntries(Object.entries(full.verdicts).filter(([f]) => f !== g.given.second)) }
    const a = planAuto(first)
    const b = planAuto(full)
    assert.equal(a.secondJudge, g.given.second, g.name)
    assert.deepEqual([b.floors, b.tier, b.fallback, b.ownFallback, b.reasons], [a.floors, a.tier, a.fallback, a.ownFallback, a.reasons], g.name)
  }
})

test('no second call after a fallback, a cached verdict or under the executor', () => {
  const g: Given = { judge: { tier: 'T3', complexity: 'complex' }, verdicts: { sonnet: ['opus', 'high'] } }
  assert.equal(planAuto(input(g)).secondJudge, 'opus')
  assert.equal(planAuto({ ...input(g), judgeCached: true }).secondJudge, null)
  assert.equal(planAuto(input({ ...g, executor: true })).secondJudge, null)
  assert.equal(planAuto(input({ ...g, judge: null })).secondJudge, null)
})
