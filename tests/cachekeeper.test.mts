// The pure cache-keeper modules: measured lifetime, cold-send guard, and the config reader.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inferTtl, FIVE_MIN, ONE_HOUR } from '../hooks/lib/ttl.ts'
import { shouldAsk, quote, choiceOf, askText, CHOICES } from '../hooks/lib/coldguard.ts'
import { ckConfig, CK_DEFAULTS } from '../hooks/lib/cachecfg.ts'
import { ANTHROPIC } from '../hooks/lib/prices.ts'

const MIN = 60_000
const opus = ANTHROPIC.rates.opus

test('ttl: a rewrite after 10 idle minutes proves the 5-minute cache', () => {
  assert.equal(inferTtl({ input: 100, cacheRead: 1000, cacheWrite: 90_000, gapMs: 10 * MIN, assumedMs: ONE_HOUR, compacted: false }), FIVE_MIN)
})
test('ttl: a read after 10 idle minutes proves the 1-hour cache', () => {
  assert.equal(inferTtl({ input: 100, cacheRead: 90_000, cacheWrite: 500, gapMs: 10 * MIN, assumedMs: FIVE_MIN, compacted: false }), ONE_HOUR)
})
test('ttl: proves nothing when idle is short, the prompt is small, a compaction came between, or the rewrite is past the lifetime', () => {
  const base = { input: 100, cacheRead: 1000, cacheWrite: 90_000, gapMs: 10 * MIN, assumedMs: ONE_HOUR, compacted: false }
  assert.equal(inferTtl({ ...base, gapMs: 3 * MIN }), null)
  assert.equal(inferTtl({ ...base, cacheWrite: 9_000, cacheRead: 100 }), null)
  assert.equal(inferTtl({ ...base, compacted: true }), null)
  assert.equal(inferTtl({ ...base, gapMs: 90 * MIN }), null) // expired on a 1h cache: expected, not evidence of 5m
  assert.equal(inferTtl({ ...base, gapMs: null }), null)
})

test('cold guard: asks only a person, on a big cold context, not mid-turn', () => {
  const base = { guard: true, fromPerson: true, midTurn: false, prefixTokens: 200_000, lastRequestAt: 0, ttlMs: ONE_HOUR, now: ONE_HOUR + 1, bigTokens: 150_000 }
  assert.equal(shouldAsk(base), true)
  assert.equal(shouldAsk({ ...base, guard: false }), false)
  assert.equal(shouldAsk({ ...base, fromPerson: false }), false)
  assert.equal(shouldAsk({ ...base, midTurn: true }), false)
  assert.equal(shouldAsk({ ...base, prefixTokens: 100_000 }), false)
  assert.equal(shouldAsk({ ...base, now: ONE_HOUR - 1 }), false) // still warm
  assert.equal(shouldAsk({ ...base, lastRequestAt: null }), false) // first request of a session
})
test('cold guard: prices the rewrite at 2x input on 1h and 1.25x on 5m, and maps answers', () => {
  const q1 = quote(200_000, 2 * 3_600_000, ONE_HOUR, opus)
  assert.ok(Math.abs(q1.rewriteUsd - (200_000 * 4 * 2) / 1e6) < 1e-9)
  const q5 = quote(200_000, 20 * MIN, FIVE_MIN, opus)
  assert.ok(Math.abs(q5.rewriteUsd - (200_000 * 4 * 1.25) / 1e6) < 1e-9)
  // Live, 2026-11-20: a 231,262-token cold rewrite on Sonnet (5m cache) billed $0.578 = 231262 x $2/M x 1.25.
  assert.ok(Math.abs(quote(231_262, 6 * MIN, FIVE_MIN, ANTHROPIC.rates.sonnet).rewriteUsd - 0.578) < 0.001)
  // Haiku costs 5x above 100k tokens.
  assert.ok(Math.abs(quote(200_000, 6 * MIN, FIVE_MIN, ANTHROPIC.rates.haiku).rewriteUsd - (200_000 * 0.1 * 5 * 1.25) / 1e6) < 1e-9)
  assert.equal(choiceOf(CHOICES[0]), 'send')
  assert.equal(choiceOf(CHOICES[1]), 'compact')
  assert.equal(choiceOf(CHOICES[2]), 'cancel')
  assert.equal(choiceOf(undefined), 'cancel')
  assert.match(askText(q1, 200_000), /200k tokens.*\$1\.60/)
})

test('config: defaults, valid values and junk', () => {
  assert.deepEqual(ckConfig({}), CK_DEFAULTS)
  assert.deepEqual(ckConfig(null), CK_DEFAULTS)
  assert.deepEqual(ckConfig({ cacheKeeper: { ttl: '5', guard: false, guardTokens: 90000 } }), { ttl: '5', guard: false, guardTokens: 90000 })
  assert.deepEqual(ckConfig({ cacheKeeper: { ttl: 'x', guardTokens: 'big' } }), CK_DEFAULTS)
})
