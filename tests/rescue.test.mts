import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cacheNote, influence, planFiles } from '../hooks/lib/rescue.ts'

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
