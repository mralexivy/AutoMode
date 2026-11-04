import { test } from 'node:test'
import assert from 'node:assert/strict'
import { builderNote, recovery, rescueMode, rescueNote, v6HaikuStart, v6SonnetFloor } from '../hooks/lib/execution.ts'

test('v6 Haiku start: T0, or T1 with no risk and no complex work', () => {
  assert.equal(v6HaikuStart('T0', 'trivial', 'none'), true)
  assert.equal(v6HaikuStart('T0', 'standard', 'critical'), false)
  assert.equal(v6HaikuStart('T1', 'standard', 'none'), true)
  assert.equal(v6HaikuStart('T1', 'standard', 'elevated'), false)
  assert.equal(v6HaikuStart('T1', 'complex', 'none'), false)
  assert.equal(v6HaikuStart('T2', 'trivial', 'none'), false)
})

test('v6 Sonnet effort floor: high under v6a; medium under v6b and v6c unless the work is complex, T3 or critical', () => {
  assert.equal(v6SonnetFloor('v6a', 'T2', 'standard', 'none'), 'high')
  assert.equal(v6SonnetFloor('v6b', 'T2', 'standard', 'elevated'), 'medium')
  assert.equal(v6SonnetFloor('v6c', 'T2', 'complex', 'none'), 'high')
  assert.equal(v6SonnetFloor('v6b', 'T3', 'standard', 'none'), 'high')
  assert.equal(v6SonnetFloor('v6b', 'T2', 'standard', 'critical'), 'high')
})

test('v6 recovery: a small context switches; v6c rescues once per model; else the route holds', () => {
  const base = { strategy: 'v6c' as const, to: 'sonnet' as const, prefixTokens: 150_000, smallContext: 30_000, observedCritical: false, rescued: 0 }
  assert.equal(recovery({ ...base, prefixTokens: 20_000 }), 'switch', 'a rebuild at 20k costs cents')
  assert.equal(recovery(base), 'rescue')
  assert.equal(recovery({ ...base, rescued: 1 }), 'hold', 'one rescue per model')
  assert.equal(recovery({ ...base, strategy: 'v6a' }), 'hold')
  assert.equal(recovery({ ...base, strategy: 'v6b', to: 'opus', observedCritical: true }), 'switch', 'quality first on observed critical risk')
  assert.equal(recovery({ ...base, strategy: 'v6b', to: 'opus' }), 'hold')
})

test('rescue mode: repair only when a check passed after the first edit', () => {
  assert.equal(rescueMode(100, [150]), 'repair')
  assert.equal(rescueMode(100, [50]), 'restart', 'a pass before the edits says nothing about them')
  assert.equal(rescueMode(null, [150]), 'restart')
})

test('the rescue note hands over a brief, never the conversation, and sets a restart aside in the main session', () => {
  const restart = rescueNote({ family: 'sonnet', mode: 'restart', because: 'the same check failed 3 times after edits', packet: 'Goal: fix it', passedChecks: [], remainingUsd: 1.5 })
  assert.match(restart, /subagent_type "automode:builder" and model "sonnet"/)
  assert.match(restart, /git stash push -u -m automode-failed-attempt` yourself/)
  assert.match(restart, /Goal: fix it/)
  assert.match(restart, /\$1\.50 of its budget left/)
  const repair = rescueNote({ family: 'opus', mode: 'repair', because: 'x', packet: 'p', passedChecks: ['pytest -q tests/a.py'], remainingUsd: null })
  assert.match(repair, /Mode: repair\. Keep the current changes: these checks passed after the first edit: pytest -q tests\/a\.py/)
  assert.doesNotMatch(repair, /git stash/)
  assert.match(builderNote('sonnet'), /model "sonnet"/)
})
