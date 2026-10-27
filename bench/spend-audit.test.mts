// @ts-nocheck TODO(types): 1 errors with strict off. Fix them and delete this line to turn checking on for this file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { costOf, sum, rateOf, workloadOf, expiryRewrites, activityOf } from './spend-audit.mts'

const tok = (o) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...o })

test('price rows reproduce the CLI cost-state totals', () => {
  // One real session, one process: the CLI recorded a cost for these claude-opus-5 tokens.
  // At the Opus 5.5 row ($4/$20, read 0.05x) the same tokens price lower, so Opus 5 needs its own row.
  const t = tok({ cacheRead: 320_254_585, cacheWrite5m: 14_479_161, output: 478_968 })
  assert.ok(Math.abs(sum(costOf(t, 'claude-opus-5')) - 262.60) < 0.05)
  assert.ok(Math.abs(sum(costOf(t, 'claude-opus-5-5')) - 262.60) > 50)
})

test('each model id finds its own row, and an unknown id finds none', () => {
  const cases = [['claude-opus-5-5', 4, 0.05], ['claude-opus-5', 5, 0.1], ['claude-sonnet-5-5', 2, 0.05], ['claude-sonnet-4-6', 3, 0.1], ['claude-haiku-5-5', 0.1, 0.1]]
  for (const [m, input, readX] of cases) assert.deepEqual([rateOf(m).input, rateOf(m).readX], [input, readX], m)
  assert.equal(rateOf('<synthetic>'), null)
  assert.equal(costOf(tok({ output: 10 }), '<synthetic>'), null)
})

test('Haiku 5.5 is priced at 5x above 100k prompt tokens', () => {
  assert.ok(Math.abs(sum(costOf(tok({ input: 100_001 }), 'claude-haiku-5-5')) - 0.0500005) < 1e-6)
  assert.ok(Math.abs(sum(costOf(tok({ input: 100_000 }), 'claude-haiku-5-5')) - 0.01) < 1e-9)
})

test('workloads: benchmark sandboxes and AutoMode work are kept apart from engineering', () => {
  assert.equal(workloadOf('/u/.claude-ectest/projects', '-x'), 'benchmark')
  assert.equal(workloadOf('/u/.claude/projects', '-private-tmp-claude-502-scratchpad-wt'), 'benchmark')
  assert.equal(workloadOf('/u/.claude/projects', '-Users-a-code-automode'), 'automode-dev')
  assert.equal(workloadOf('/u/.claude/projects', '-Users-a-code-shop'), 'engineering')
})

test('an expiry rewrite is a large write after an idle gap longer than the cache lifetime', () => {
  const at = (min) => min * 60_000
  const req = (min, t) => ({ at: at(min), tokens: tok(t), cost: costOf(tok(t), 'claude-opus-5'), model: 'claude-opus-5' })
  const main = [req(0, { cacheRead: 100_000 }), req(2, { cacheRead: 100_000 }), req(10, { cacheWrite5m: 100_000 }), req(11, { cacheRead: 100_000, cacheWrite5m: 1_000 })]
  const r = expiryRewrites(main)
  assert.equal(r.length, 1)
  assert.equal(r[0].gapMin, 8)
  // A 1h write after a 10 minute gap is not an expiry.
  assert.equal(expiryRewrites([req(0, { cacheRead: 100_000 }), { ...req(10, { cacheWrite1h: 100_000 }) }]).length, 0)
})

test('activity comes from the tools a request called', () => {
  assert.equal(activityOf(['Read', 'Edit'], false), 'implementation')
  assert.equal(activityOf(['Bash:test'], false), 'testing')
  assert.equal(activityOf(['Grep'], false), 'exploration')
  assert.equal(activityOf(['Read'], true), 'planning')
  assert.equal(activityOf([], false), 'answer')
})
