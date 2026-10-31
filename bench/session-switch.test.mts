import { test } from 'node:test'
import assert from 'node:assert/strict'
import { followUpSummary, stepBetween, type Reading } from './lib/session-steps.mts'

const reading = (o: Partial<Reading>): Reading => ({ requests: {}, usd: 0, cacheRead: 0, cacheWrite: 0, output: 0, peak: 0, ...o })

test('a step is the difference between two readings, and names only the models it added requests to', () => {
  const s = stepBetween(reading({ requests: { opus: 10 }, usd: 1, cacheRead: 500, cacheWrite: 100, output: 7, peak: 100_000 }), reading({ requests: { opus: 10, sonnet: 2 }, usd: 1.5, cacheRead: 600, cacheWrite: 90_100, output: 9, peak: 101_000 }))
  assert.deepEqual(s.models, ['sonnet'])
  assert.equal(s.requests, 2)
  assert.equal(s.usd, 0.5)
  assert.equal(s.cache_write, 90_000)
  assert.equal(s.rewrite_share, 0.9, 'a model switch writes the context again')
})

test('rewrite share is null for the first step, and stays at or below 1', () => {
  assert.equal(stepBetween(reading({}), reading({ cacheWrite: 50 })).rewrite_share, null)
  assert.equal(stepBetween(reading({ peak: 10 }), reading({ peak: 10, cacheWrite: 50 })).rewrite_share, 1)
})

test('the summary averages what the arm did after the first prompt', () => {
  const step = (usd: number, cache_write: number, rewrite_share: number | null, models = ['m']) => ({ models, requests: 1, usd, cache_read: 0, cache_write, output: 0, rewrite_share })
  const rows = [{ arm: 'a', accepted: true, steps: [step(1, 10, null), step(0.5, 100, 0.5), step(0.25, 0, 0)] }, { arm: 'a', accepted: false, steps: [step(1, 10, null), step(0.25, 0, 0.1), step(0, 0, 0)] }, { arm: 'b', accepted: true, steps: [step(9, 9, null)] }]
  const s = followUpSummary(rows, 'a')
  assert.equal(s.sessions, 2)
  assert.equal(s.accepted, 1)
  assert.equal(s.follow_up_usd, 0.5)
  assert.equal(s.total_usd, 1.5)
  assert.equal(s.follow_up_cache_write, 50)
  assert.ok(Math.abs(s.first_follow_up_rewrite - 0.3) < 1e-9)
})
