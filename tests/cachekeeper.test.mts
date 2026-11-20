// The pure cache-keeper modules: measured lifetime, cold-send guard, keepalive rules, and the config reader.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inferTtl, FIVE_MIN, ONE_HOUR } from '../hooks/lib/ttl.ts'
import { shouldAsk, quote, choiceOf, askText, CHOICES } from '../hooks/lib/coldguard.ts'
import { KEEP_OFF, startKeepWarm, tick, afterPing, marginMs, rewriteUsd, pingCostUsd, clampHours } from '../hooks/lib/keepwarm.ts'
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
  assert.equal(choiceOf(CHOICES[3]), 'keep')
  assert.equal(choiceOf(undefined), 'cancel')
  assert.match(askText(q1, 200_000), /200k tokens.*\$1\.60/)
})

const tickIn = (over = {}) => ({ mainRequests: 5, now: 0, lastActivityAt: 0, ttlMs: ONE_HOUR, busy: false, prefixTokens: 300_000, rate: opus, ...over })
test('keepwarm: pings 8 minutes before a 1h cache expires and 90 s before a 5m one', () => {
  const s = startKeepWarm(0, 4)
  assert.equal(tick(s, tickIn({ now: ONE_HOUR - marginMs(ONE_HOUR) - 1 })).action, 'wait')
  assert.equal(tick(s, tickIn({ now: ONE_HOUR - marginMs(ONE_HOUR) })).action, 'ping')
  assert.equal(tick(s, tickIn({ now: FIVE_MIN - 90_000, ttlMs: FIVE_MIN })).action, 'ping')
})
test('keepwarm: a cache that already expired is never pinged: that ping would write the prefix again', () => {
  const s = startKeepWarm(0, 4)
  assert.deepEqual(tick(s, tickIn({ now: ONE_HOUR + 1 })), { action: 'stop', reason: 'the cache already expired' })
})
test('keepwarm: waits while a turn runs or with no prefix, stops at the time limit', () => {
  const s = startKeepWarm(0, 1)
  assert.equal(tick(s, tickIn({ now: 55 * MIN, busy: true })).action, 'wait')
  assert.equal(tick(s, tickIn({ now: 55 * MIN, prefixTokens: 0 })).action, 'wait')
  assert.deepEqual(tick(s, tickIn({ now: 61 * MIN })), { action: 'stop', reason: 'the keep-warm time ran out' })
  assert.equal(tick(KEEP_OFF, tickIn({ now: 55 * MIN })).action, 'wait')
})
test('keepwarm: stops when the pings so far would cost more than one rewrite', () => {
  const rw = rewriteUsd(300_000, opus, ONE_HOUR)
  const per = pingCostUsd(300_000, opus)
  assert.ok(per < rw / 15) // a 1h-cache ping is about a twentieth of a rewrite
  const spent = { ...startKeepWarm(0, 24), pingUsd: rw - per / 2 }
  assert.equal(tick(spent, tickIn({ now: 55 * MIN })).action, 'stop')
})
test('keepwarm: waits until the chat has three requests', () => {
  const s = startKeepWarm(0, 4)
  assert.equal(tick(s, tickIn({ now: 55 * MIN, mainRequests: 2 })).action, 'wait')
  assert.equal(tick(s, tickIn({ now: 55 * MIN, mainRequests: 3 })).action, 'ping')
})
test('keepwarm: one ping that wrote is forgiven, two in a row stop it, a read resets the count, no answer stops at once', () => {
  const s = startKeepWarm(0, 4)
  const wrote = { cacheRead: 1000, cacheWrite: 300_000 }
  const read = { cacheRead: 300_000, cacheWrite: 100 }
  const one = afterPing(s, 1, 0.1, wrote)
  assert.equal(one.on, true)
  assert.equal(one.writeStreak, 1)
  assert.match(afterPing(one, 2, 0.1, wrote).stopped ?? '', /wrote the cache/)
  assert.equal(afterPing(one, 2, 0.1, read).writeStreak, 0)
  assert.match(afterPing(s, 1, 0.1, null).stopped ?? '', /no answer/)
  assert.equal(afterPing(s, 5, 0.25, { cacheRead: 9, cacheWrite: 0 }).pingUsd, 0.25)
})
test('keepwarm: hours are clamped to 24, and junk is zero', () => {
  assert.equal(clampHours(99), 24)
  assert.equal(clampHours(-1), 0)
  assert.equal(clampHours(NaN), 0)
  assert.equal(startKeepWarm(0, 0).on, false)
})

test('config: defaults, valid values and junk', () => {
  assert.deepEqual(ckConfig({}), CK_DEFAULTS)
  assert.deepEqual(ckConfig(null), CK_DEFAULTS)
  assert.deepEqual(ckConfig({ cacheKeeper: { ttl: '5', guard: false, guardTokens: 90000, keepWarmHours: 99, keepWarm: 'auto', budgetUsd: 2, minRewriteUsd: 1, learnFromHistory: false } }),
    { ttl: '5', guard: false, guardTokens: 90000, keepWarmHours: 24, keepWarm: 'auto', budgetUsd: 2, minRewriteUsd: 1, learnFromHistory: false })
  assert.deepEqual(ckConfig({ cacheKeeper: { ttl: 'x', guardTokens: 'big', keepWarmHours: -3, keepWarm: 'sometimes', budgetUsd: -1 } }), CK_DEFAULTS)
  assert.equal(CK_DEFAULTS.keepWarm, 'ask')
})
