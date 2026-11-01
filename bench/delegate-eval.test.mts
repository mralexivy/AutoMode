import test from 'node:test'
import assert from 'node:assert/strict'
import { CASES, scoreCase } from './delegate-eval.mts'

const files = { 'a.ts': 'one\nif (w.stop && x) return\nthree' }
const stop = { id: 's', paths: ['a.ts'], question: 'q', want: /w\.stop &&/ }
const hit = { claim: 'c', path: 'a.ts', lines: [2, 2] as [number, number], quote: 'if (w.stop && x) return' }

test('a case passes only on a finding that cites the wanted line', () => {
  assert.equal(scoreCase(stop, [hit], files), true)
  assert.equal(scoreCase(stop, [{ ...hit, lines: [1, 1] }], files), false)
  assert.equal(scoreCase(stop, [], files), false)
})

test('the absent case passes only when nothing survives', () => {
  const absent = { ...stop, want: null }
  assert.equal(scoreCase(absent, [], files), true)
  assert.equal(scoreCase(absent, [hit], files), false)
})

test('the case list has one absent case and unique ids', () => {
  assert.equal(CASES.filter((c) => !c.want).length, 1)
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length)
})
