import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cacheNote, closeEpisodes, effortFirst, episodeBase, influence, openEpisode, planFiles } from '../hooks/lib/rescue.ts'
import { EMPTY_LADDER } from '../hooks/lib/failures.ts'

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
