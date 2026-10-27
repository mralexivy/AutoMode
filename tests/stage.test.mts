// Task stages: what the agent is doing now (lib/stage.ts). The stage is recorded for every prompt; it changes the route
// only for a plan (bands.ts) and for a challenge (stageMinBand).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isChallenge, stageOf } from '../hooks/lib/stage.ts'

const base = { planMode: false, planJustExited: false, text: 'x', previous: 'implement', repeatedFailure: false, hasEdits: true }
const st = (o) => stageOf({ ...base, ...o })

test('stage: the first rule that holds wins, in a fixed order', () => {
  assert.equal(st({ planMode: true, text: 'commit' }), 'plan', 'plan mode wins over a short message')
  assert.equal(st({ planJustExited: true, text: 'implement it' }), 'plan-approved')
  assert.equal(st({ transition: 'repository' }), 'repo-op')
  assert.equal(st({ transition: 'verification' }), 'verify')
  assert.equal(st({ transition: 'acknowledgment' }), 'complete')
  assert.equal(st({ repeatedFailure: true, text: 'fix the test' }), 'debug')
  assert.equal(st({ strategy: 'isolated-worker', text: 'find every caller' }), 'explore')
  assert.equal(st({ tier: 'T0', hasEdits: false, text: 'where is the output folder written?' }), 'lookup')
  assert.equal(st({ tier: 'T3', hasEdits: false, text: 'why does the setup fail on some machines' }), 'analyze')
  assert.equal(st({ tier: 'T1', text: 'add retries to the uploader' }), 'implement')
  assert.equal(st({ text: 'run the final review please' }), 'review')
})

test('stage: a challenge after finished work is reconsideration, and keeps the work\'s band', () => {
  for (const t of ['are you sure this fixes it?', 'are you really sure?', 'you missed the error path', "that's wrong", 'will that really fix the issue', 'it still fails']) {
    assert.equal(isChallenge(t), true, t)
    assert.equal(st({ text: t, previous: 'implement' }), 'reconsider', t)
  }
  assert.equal(st({ text: 'are you sure?', previous: 'plan' }), 'implement', 'a doubt about a plan is not a doubt about finished work')
  assert.equal(isChallenge('add a flag for verbose output'), false)
})
