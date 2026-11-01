import test from 'node:test'
import assert from 'node:assert/strict'
import { GATE_TOKENS, CHARS_PER_TOKEN, extractPrompt, gateable, gateRead, outlineOf, parseEvidence, renderEvidence, verifyEvidence } from '../hooks/lib/delegation.ts'

const big = GATE_TOKENS * CHARS_PER_TOKEN
const base = { chars: big, tried: false, edited: false, stage: 'implement' as const, risk: 'none' as const }

test('gateRead stops a large full read once', () => {
  assert.equal(gateRead(base).gate, true)
  assert.equal(gateRead({ ...base, tried: true }).gate, false)
})

test('gateRead measures chars, so one minified line still counts', () => {
  assert.equal(gateRead({ ...base, chars: big - 10 }).gate, false)
  assert.equal(gateRead({ ...base, chars: 300_000 }).gate, true)
})

test('gateRead leaves edited files, exact-text stages and risky work alone', () => {
  assert.equal(gateRead({ ...base, edited: true }).gate, false)
  for (const stage of ['debug', 'reconsider', 'review'] as const) assert.equal(gateRead({ ...base, stage }).gate, false)
  for (const risk of ['elevated', 'critical'] as const) assert.equal(gateRead({ ...base, risk }).gate, false)
})

test('gateable skips ranged reads and files that are not text', () => {
  assert.equal(gateable('a.ts', {}), true)
  assert.equal(gateable('a.ts', { offset: 10 }), false)
  assert.equal(gateable('a.ts', { limit: 10 }), false)
  assert.equal(gateable('a.pdf', {}), false)
  assert.equal(gateable('a.ipynb', {}), false)
  assert.equal(gateable('', {}), false)
})

test('outlineOf gives line numbers for declarations and headings', () => {
  const o = outlineOf('import x\n\nexport async function go() {\n}\nclass A:\n    def b(self):\n# Title\nconst f = (a) => a\nlet n = 1')
  assert.match(o, /^9 lines\./)
  assert.match(o, /3: export async function go/)
  assert.match(o, /5: class A/)
  assert.match(o, /6: def b/)
  assert.match(o, /7: # Title/)
  assert.match(o, /8: const f/)
  assert.doesNotMatch(o, /let n/)
})

test('outlineOf stays short on a file with many symbols', () => {
  const o = outlineOf(Array.from({ length: 500 }, (_, i) => `def f${i}():`).join('\n'))
  assert.match(o, /\.\.\. 420 more/)
  assert.equal(o.split('\n').length, 82)
})

test('extractPrompt numbers each line from 1', () => {
  const p = extractPrompt({ 'a.py': 'x\ny' }, 'why?')
  assert.match(p, /<file path="a\.py">\n1\tx\n2\ty\n<\/file>/)
  assert.match(p, /Question: why\?$/)
})

test('parseEvidence takes JSON inside other text and drops malformed findings', () => {
  const e = parseEvidence('Sure:\n{"findings":[{"claim":"c","path":"a","lines":[1,2],"quote":"q"},{"claim":"no quote","path":"a","lines":[1,2]}],"omitted":["b"]}')
  assert.equal(e?.findings.length, 1)
  assert.deepEqual(e?.omitted, ['b'])
  assert.equal(parseEvidence('no json'), null)
  assert.equal(parseEvidence('{"nope":1}'), null)
})

const files = { 'a.py': 'one\ndef retry(self, n):\n    return n + 1\nfour\nfive\nsix\nseven\neight\nnine' }
const finding = (o = {}) => ({ claim: 'c', path: 'a.py', lines: [2, 3] as [number, number], quote: 'def retry(self, n):', ...o })

test('verifyEvidence keeps a quote at its cited lines', () => {
  assert.equal(verifyEvidence({ findings: [finding()], omitted: [] }, files).kept.length, 1)
})

test('verifyEvidence ignores whitespace and allows a small line slip', () => {
  assert.equal(verifyEvidence({ findings: [finding({ quote: 'def   retry(self,\n n):', lines: [4, 4] })], omitted: [] }, files).kept.length, 1)
})

test('verifyEvidence drops invented, misplaced and empty evidence', () => {
  const bad = [finding({ quote: 'def invented(self):' }), finding({ lines: [8, 9] }), finding({ path: 'b.py' }), finding({ quote: 'one' }), finding({ lines: [3, 2] }), finding({ lines: [0, 1] })]
  const r = verifyEvidence({ findings: bad, omitted: [] }, files)
  assert.equal(r.kept.length, 0)
  assert.equal(r.dropped, 6)
})

test('renderEvidence reports what was dropped, and points to a read when nothing held', () => {
  assert.match(renderEvidence([finding()], 2, ['x']), /1 findings have a quote[\s\S]*2 did not match[\s\S]*a\.py:2-3[\s\S]*Not covered: x/)
  assert.match(renderEvidence([], 3, []), /Nothing verified/)
})
