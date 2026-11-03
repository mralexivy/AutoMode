// The shadow lifecycle model (lib/guardian.ts expectedLifecycle). Every scenario names its pricing and cache state, so
// no test states a blanket rule such as "a large context always compacts".
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GUARDIAN_DEFAULTS as C, LIFECYCLE_PRIORS, expectedLifecycle } from '../hooks/lib/guardian.ts'

// Sonnet at $2 input: a cache read is $0.1 and a 1h write $4 per million tokens. 200k of context, 150k of it older
// than the task, 8 requests ahead, a 9% chance the cache lapses before the next prompt.
const base = { family: 'sonnet' as const, contextTokens: 200_000, baseTokens: 40_000, staleTokens: 150_000, idleMs: 0, pCold: 0.09, ttlMs: 3_600_000, horizon: 8, taskClosed: false, openFailures: 0 }

test('expectedLifecycle: a fully specified scenario, part by part', () => {
  const e = expectedLifecycle(base, C)
  // recovery: 20% of a 20k rebuild, written once and read on 6 later requests: 0.2 × 20k × ($4 + 6 × $0.1) / 1M
  assert.equal(e.parts.recovery, 0.0184)
  // the first request keeps 200k: 91% read at $0.1, 9% written at $4 per million
  assert.equal(e.parts.firstKeep, 0.0902)
  assert.equal(e.delta, Math.round((e.keep - e.compact) * 1e6) / 1e6)
  assert.equal(e.basis, 'prior')
})

test('expectedLifecycle: regrowth moves both totals and leaves the difference', () => {
  const a = expectedLifecycle(base, C, { ...LIFECYCLE_PRIORS, regrowthTokens: 0 })
  const b = expectedLifecycle(base, C, { ...LIFECYCLE_PRIORS, regrowthTokens: 20_000 })
  assert.ok(b.keep > a.keep && b.compact > a.compact)
  assert.ok(Math.abs(a.delta - b.delta) < 1e-6)
})

test('expectedLifecycle: a longer horizon favors the compaction, a likelier loss favors keeping', () => {
  const at = (o: Record<string, unknown>, p = LIFECYCLE_PRIORS) => expectedLifecycle({ ...base, ...o }, C, p).delta
  assert.ok(at({ horizon: 30 }) > at({ horizon: 8 }))
  assert.ok(at({ horizon: 8 }) > at({ horizon: 2 }))
  assert.ok(at({}, { ...LIFECYCLE_PRIORS, pLoss: 0.9 }) < at({}, { ...LIFECYCLE_PRIORS, pLoss: 0 }))
})
