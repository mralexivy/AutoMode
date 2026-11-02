// The explicit completion claim (bench/lib/claim.mts) and the completion field a result row records.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { asksForClaim, claimOf, completionField } from './lib/claim.mts'
import { loadTemplate } from './lib/prompt.mts'

test('the last status line decides; no line is null', () => {
  assert.equal(claimOf('Implemented it.\n\nStatus: done'), true)
  assert.equal(claimOf('Tried.\nStatus: not done\n'), false)
  assert.equal(claimOf('Status: not done\n...\nfixed it after all\n**Status: done**'), true)
  assert.equal(claimOf('`Status: Done.`'), true)
  assert.equal(claimOf('I think the status is done'), null)
  assert.equal(claimOf('Status: mostly done'), null)
  assert.equal(claimOf(null), null)
})

test('only repo-change-v2 asks for the status line', () => {
  assert.equal(asksForClaim(loadTemplate('repo-change-v1').text), false)
  assert.equal(asksForClaim(loadTemplate('repo-change-v2').text), true)
})

test('the row field: a claim only when asked and answered, the gate whenever it ran', () => {
  const v1 = loadTemplate('repo-change-v1').text, v2 = loadTemplate('repo-change-v2').text
  assert.equal(completionField(v1, true, null), undefined)
  assert.deepEqual(completionField(v1, true, { state: 'verified', blocked: false }), { claim_asked: false, gate_state: 'verified', gate_blocked: false })
  assert.deepEqual(completionField(v2, false, null), { claim_asked: true, claimed: false })
  assert.deepEqual(completionField(v2, null, null), { claim_asked: true })
})
