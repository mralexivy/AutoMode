import { test } from 'node:test'
import assert from 'node:assert/strict'
import { budgetState, recordUsd } from '../hooks/lib/budget.ts'
import { assessCompletion } from '../hooks/lib/completion.ts'

test('task budget: requests and judges count, a turn outcome never does', () => {
  assert.equal(recordUsd({ kind: 'request', usd: { value: 0.25 } }), 0.25)
  assert.equal(recordUsd({ kind: 'model-call', usd: { value: 0.001 } }), 0.001)
  assert.equal(recordUsd({ kind: 'outcome', usd: { value: 0.25 } }), 0, 'an outcome repeats its requests')
  assert.equal(recordUsd({ kind: 'request', usd: null }), 0)
  assert.equal(budgetState(5, 0), 'off')
  assert.equal(budgetState(0.5, 1), 'ok')
  assert.equal(budgetState(0.8, 1), 'low')
  assert.equal(budgetState(1, 1), 'exhausted')
})

test('a spent budget ends the task as budget_exhausted, never as done, unless the evidence already showed it done', () => {
  const base = { edited: true, editedSinceCheck: false, obligations: [] }
  assert.equal(assessCompletion({ ...base, lastCheckPassed: false, budgetExhausted: true }), 'budget_exhausted')
  assert.equal(assessCompletion({ ...base, lastCheckPassed: true, budgetExhausted: true }), 'verified')
  assert.equal(assessCompletion({ ...base, edited: false, lastCheckPassed: null, budgetExhausted: true }), 'none')
  assert.equal(assessCompletion({ ...base, lastCheckPassed: false }), 'failed')
})
