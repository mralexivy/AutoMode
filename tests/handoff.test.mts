import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_CHARS, buildHandoff, completeness, forkWorth, parseForkFacts, renderHandoff, withFork } from '../hooks/lib/handoff.ts'

const failure = (o: Record<string, unknown> = {}) => ({ fingerprint: 'fp1', class: 'defect', command: 'go test ./...', exitCode: 1, at: 1, editedSince: true, evidence: Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n'), ...o }) as never
const input = (o: Record<string, unknown> = {}) => ({ spec: 'fix the parser alias bug', prompts: [], acceptance: [{ text: 'go test passes', source: 'user' }], failures: [failure(), failure({ at: 2 })], edited: ['parser.go'], editsSinceOpen: ['parser.go', 'parser.go'], diffStat: ' parser.go | 2 +-', diffHunks: '@@ -1 +1 @@\n-a\n+b', because: 'the same check failed after an edit', ...o })
const prices = { provider: 'anthropic', source: 's', checkedAt: 'd', rates: { opus: { input: 4, output: 20, cacheReadX: 0.05 }, sonnet: { input: 2, output: 10, cacheReadX: 0.05 }, haiku: { input: 0.1, output: 0.5, cacheReadX: 0.1 } } }

test('buildHandoff: every fact has its source, the tail is 40 lines, the attempts are deduplicated', () => {
  const h = buildHandoff(input())
  assert.equal(h.objective.from, 'spec')
  assert.deepEqual(h.acceptance, [{ text: 'go test passes', from: 'user-prompt' }])
  assert.equal(h.failures.length, 1)
  assert.equal(h.failures[0].attempts, 2)
  assert.equal(h.failures[0].tail.split('\n').length, 40)
  assert.equal(h.failures[0].from, 'command:go test ./...')
  assert.deepEqual(h.attempts, [{ text: 'edited parser.go', from: 'edit-log' }])
  const text = renderHandoff(h)
  assert.match(text, /\[git-diff\]/)
  assert.match(text, /missing_evidence/)
})

test('renderHandoff stays under its cap', () => {
  const h = buildHandoff(input({ spec: 'x'.repeat(5000), diffHunks: 'y'.repeat(50_000), prompts: Array(10).fill('z'.repeat(2000)) }))
  assert.ok(renderHandoff(h).length <= MAX_CHARS + 40)
})

test('completeness: later messages and missing criteria are conversational gaps, an empty diff is not', () => {
  assert.deepEqual(completeness(buildHandoff(input()), ['parser.go']).gaps, [])
  const later = completeness(buildHandoff(input({ prompts: ['no, keep the old flag name'] })), ['parser.go'])
  assert.equal(later.conversational.length, 1)
  const empty = completeness(buildHandoff(input({ diffStat: '', acceptance: [] })), ['parser.go'])
  assert.deepEqual(empty.conversational, ['no acceptance criteria'])
  assert.ok(empty.gaps.includes('edits were made but the diff is empty'))
})

test('forkWorth: only for a conversational gap, and only while cheap next to the consult', () => {
  const x = { conversational: 1, prefixTokens: 150_000, warm: true, main: 'sonnet' as const, prices, ttlMs: 3_600_000, advisorUsd: 0.14 }
  // warm: 150k at the cache read (0.015) plus a 1k reply (0.01) is 0.025, under a quarter of 0.14
  assert.deepEqual(forkWorth(x), { run: true, forkUsd: 0.025, why: 'a fork ($0.025) fills: conversation decisions' })
  // cold: the prefix is written afresh (0.6 at the 1h write), far over the limit
  assert.equal(forkWorth({ ...x, warm: false }).run, false)
  assert.equal(forkWorth({ ...x, conversational: 0 }).run, false)
})

test('parseForkFacts: the JSON asked for, marked as from the conversation, or null', () => {
  const f = parseForkFacts('Here: {"constraints": ["keep the old flag name"], "unknowns": []}')
  assert.deepEqual(f, { constraints: [{ text: 'keep the old flag name', from: 'conversation' }], unknowns: [] })
  assert.equal(parseForkFacts('no json'), null)
  assert.equal(parseForkFacts('{"constraints": "x"}'), null)
  const h = withFork(buildHandoff(input()), f!)
  assert.match(renderHandoff(h), /keep the old flag name \[conversation\]/)
})
