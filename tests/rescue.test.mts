import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONSULT_MS_PRIOR, cacheNote, closeEpisodes, consultOutcome, durationsFrom, effortFirst, episodeBase, expireChance, influence, openEpisode, planFiles, priceConsult } from '../hooks/lib/rescue.ts'
import { EMPTY_LADDER } from '../hooks/lib/failures.ts'
import { newEnvelope, requireReview } from '../hooks/lib/envelope.ts'

test('cacheNote: what is left of a warm cache, and a cold one', () => {
  const c = { model: 'm', effort: null, prefixTokens: 150_000, lastRequestAt: 1_000, ttlMs: 300_000, effortSharesCache: true }
  assert.deepEqual(cacheNote(c, 241_000), { prefixTokens: 150_000, sinceRefreshMs: 240_000, ttlMs: 300_000, warm: true, remainingMs: 60_000 })
  assert.equal(cacheNote(c, 400_000).warm, false)
  assert.equal(cacheNote(c, 400_000).remainingMs, 0)
  assert.equal(cacheNote({ ...c, lastRequestAt: null }, 5).sinceRefreshMs, null)
})

test('planFiles: the paths an answer names, not versions or links', () => {
  const answer = 'Cause: `src/parse.py:42` drops the alias.\nFix: edit src/parse.py and tests/test_parse.py. Needs 1.2.3, see https://x.io/a.html.'
  assert.deepEqual(planFiles(answer), ['src/parse.py', 'tests/test_parse.py'])
  assert.deepEqual(planFiles('no files here.'), [])
})

test('influence: plan against later edits, matched on the path tail', () => {
  assert.equal(influence([], ['a.ts']), 'unknown')
  assert.equal(influence(['src/a.ts'], []), 'ignored')
  assert.equal(influence(['src/a.ts'], ['/repo/src/a.ts']), 'followed')
  assert.equal(influence(['src/a.ts', 'src/b.ts', 'src/c.ts'], ['src/a.ts']), 'partial')
  assert.equal(influence(['src/a.ts'], ['src/z.ts']), 'ignored')
})

const esc = (o: Record<string, unknown>) => ({ level: 'strong', because: 'x', key: 'k', cause: 'c', check: false, ...o }) as never

test('episodes: one per failure, and a failure after its pass opens the next', () => {
  assert.equal(episodeBase(esc({ fingerprint: 'abc', cause: 'abc', check: true }), EMPTY_LADDER), 'check:abc')
  assert.equal(episodeBase(esc({ cause: 'revert' }), { ...EMPTY_LADDER, reverts: 2 }), 'revert:2')
  assert.equal(episodeBase(esc({ cause: 'reviewer' }), EMPTY_LADDER), 'reviewer')
  const a = openEpisode({}, 'check:abc', 1)
  assert.equal(a.id, 'check:abc#0')
  assert.equal(openEpisode(a.episodes, 'check:abc', 2).id, 'check:abc#0')
  assert.equal(openEpisode(a.episodes, 'check:def', 2).id, 'check:def#0')
  const closed = closeEpisodes(a.episodes, (e) => e.base === 'check:abc', 3)
  assert.deepEqual(closed.closed, ['check:abc#0'])
  assert.equal(openEpisode(closed.episodes, 'check:abc', 4).id, 'check:abc#1')
})

test('effortFirst: once per episode, never on critical work or under a floor that needs the model', () => {
  const ep = { base: 'b', raised: 0, consulted: false, switched: false, openedAt: 0 }
  const x = { enabled: true, level: 'strong', episode: ep, critical: false, modelBand: 3 }
  assert.equal(effortFirst(x).use, true)
  assert.equal(effortFirst({ ...x, enabled: false }).use, false)
  assert.equal(effortFirst({ ...x, level: 'weak' }).use, false)
  assert.equal(effortFirst({ ...x, episode: { ...ep, raised: 1 } }).use, false)
  assert.equal(effortFirst({ ...x, critical: true }).use, false)
  assert.equal(effortFirst({ ...x, floorBand: 3 }).use, false)
  assert.equal(effortFirst({ ...x, floorBand: 2 }).use, true)
})

const prices = { provider: 'anthropic', source: 's', checkedAt: 'd', rates: { opus: { input: 4, output: 20, cacheReadX: 0.05 }, sonnet: { input: 2, output: 10, cacheReadX: 0.05 }, haiku: { input: 0.1, output: 0.5, cacheReadX: 0.1 } } }
const note = (prefixTokens: number, ttlMs: number, sinceRefreshMs: number) => ({ prefixTokens, sinceRefreshMs, ttlMs, warm: sinceRefreshMs <= ttlMs, remainingMs: Math.max(0, ttlMs - sinceRefreshMs) })
const input = (o: Record<string, unknown> = {}) => ({ cache: note(150_000, 3_600_000, 0), remainingRequests: 10, outPerRequest: 2_000, packetTokens: 2_000, planTokens: 2_000, setupTokens: 18_000, main: 'sonnet' as const, prices, durations: CONSULT_MS_PRIOR, ...o })

test('expireChance: what is left of the cache against the consult durations', () => {
  assert.equal(expireChance(0, CONSULT_MS_PRIOR), 1)
  assert.equal(expireChance(60_000, CONSULT_MS_PRIOR), 0.75)
  assert.equal(expireChance(120_000, CONSULT_MS_PRIOR), 0.5)
  assert.equal(expireChance(3_000_000, CONSULT_MS_PRIOR), 0)
  // A 5-minute cache refreshed 4 minutes ago has 1 minute left: a 2-minute consult likely outlives it.
  const p = priceConsult(input({ cache: note(150_000, 300_000, 240_000) }))
  assert.equal(p.pExpire, 0.75)
})

test('priceConsult: a warm 150k prefix with 10 requests left consults', () => {
  const p = priceConsult(input())
  assert.equal(p.choice, 'consult')
  // switch: rebuild 150k on Opus at the 1h write (1.2) + 10 requests on Opus (0.7) + half a rebuild back on Sonnet (0.3)
  assert.equal(p.switchUsd, 2.2)
  // consult: stay 0.35 + advisor 0.14 + plan back 0.008 + verify 0.035 + half the switch on a recurrence 1.1
  assert.equal(p.consultUsd, 1.633)
  assert.equal(p.pExpire, 0)
  assert.equal(p.basis.durations, 'prior')
})

test('priceConsult: a small prefix with few requests left switches', () => {
  const p = priceConsult(input({ cache: note(10_000, 300_000, 0), remainingRequests: 2 }))
  assert.equal(p.choice, 'switch')
  assert.ok(p.consultUsd > p.switchUsd)
})

test('priceConsult: the quality rules run before the prices', () => {
  assert.match(priceConsult(input(), { recurredBefore: true, floorRequiresSwitch: false }).why, /did not fix it/)
  assert.match(priceConsult(input(), { recurredBefore: false, floorRequiresSwitch: true }).why, /floor/)
  assert.equal(priceConsult(input({ pRecur: 0.8 })).choice, 'switch')
  assert.equal(priceConsult(input({ pRecur: 0.8 })).basis.recur, 'measured')
})

test('durationsFrom: measured quantiles from 10 samples, the prior before', () => {
  assert.equal(durationsFrom([1, 2, 3, 4, 5, 6, 7, 8, 9]).basis, 'prior')
  const d = durationsFrom([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
  assert.deepEqual(d, { p25: 30, p50: 50, p90: 90, basis: 'measured' })
})

test('consultOutcome: a pass waits for an independent check, and the task end settles the rest', () => {
  const none = { switched: false, recurred: false, checkPassed: false, independentlyVerified: false, taskEnded: false }
  assert.equal(consultOutcome(none), null)
  assert.equal(consultOutcome({ ...none, checkPassed: true }), null)
  assert.equal(consultOutcome({ ...none, checkPassed: true, independentlyVerified: true }), 'verified_resolved')
  assert.equal(consultOutcome({ ...none, recurred: true }), 'recurred')
  assert.equal(consultOutcome({ ...none, recurred: true, switched: true }), 'escalated')
  assert.equal(consultOutcome({ ...none, checkPassed: true, taskEnded: true }), 'unverified')
  assert.equal(consultOutcome({ ...none, taskEnded: true }), 'abandoned')
  // An independent check with no pass of the failing check is not a fix.
  assert.equal(consultOutcome({ ...none, independentlyVerified: true }), null)
})

test('requireReview adds a reason once and never removes one', () => {
  const env = newEnvelope('t', 'p', 'fix the parser', 0, 'standard', { level: 'none', reasons: [], source: 'prompt' } as never)
  const once = requireReview(env, 'an Opus consult ran on a failure')
  assert.equal(once.reviewRequired.value, true)
  assert.deepEqual(requireReview(once, 'an Opus consult ran on a failure').reviewRequired.because, once.reviewRequired.because)
})
