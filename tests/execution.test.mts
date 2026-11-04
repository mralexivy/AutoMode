import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ANTHROPIC } from '../hooks/lib/prices.ts'
import { builderNote, haikuPriceStep, priceRecovery, recovery, rescueMode, rescueNote, resolveExecution, unproductive, v6HaikuStart, v6RaiseAllowed, v6SonnetFloor } from '../hooks/lib/execution.ts'

test('execution: strategy is a preset; each switch overrides it on its own', () => {
  assert.deepEqual(resolveExecution({}), { start: 'legacy', recovery: 'legacy', review: 'prospective' })
  assert.deepEqual(resolveExecution({ strategy: 'v6c' }), { start: 'v6b', recovery: 'rescue', review: 'observed' })
  assert.deepEqual(resolveExecution({ strategy: 'legacy', recovery: 'rescue' }), { start: 'legacy', recovery: 'rescue', review: 'prospective' }, 'E1: the v5 start with fresh rescue')
  assert.deepEqual(resolveExecution({ strategy: 'v6a', start: 'default', review: 'prospective' }), { start: 'v6a', recovery: 'hold', review: 'prospective' })
})

test('v6 Haiku start: T0, or T1 with no risk and no complex work', () => {
  assert.equal(v6HaikuStart('T0', 'trivial', 'none'), true)
  assert.equal(v6HaikuStart('T0', 'standard', 'critical'), false)
  assert.equal(v6HaikuStart('T1', 'standard', 'none'), true)
  assert.equal(v6HaikuStart('T1', 'standard', 'elevated'), false)
  assert.equal(v6HaikuStart('T1', 'complex', 'none'), false)
  assert.equal(v6HaikuStart('T2', 'trivial', 'none'), false)
})

test('v6 Sonnet effort floor: high under v6a; medium under v6b unless the work is complex, T3 or critical', () => {
  assert.equal(v6SonnetFloor('v6a', 'T2', 'standard', 'none'), 'high')
  assert.equal(v6SonnetFloor('v6b', 'T2', 'standard', 'elevated'), 'medium')
  assert.equal(v6SonnetFloor('v6b', 'T2', 'complex', 'none'), 'high')
  assert.equal(v6SonnetFloor('v6b', 'T3', 'standard', 'none'), 'high')
  assert.equal(v6SonnetFloor('v6b', 'T2', 'standard', 'critical'), 'high')
})

test('recovery prices: a switch at 150k on Opus costs far more than a fresh Opus builder', () => {
  const p = priceRecovery({ current: 'sonnet', to: 'opus', prefixTokens: 150_000, remainingRequests: 6, outPerRequest: 1_500, packetTokens: 6_000, ttlMs: 3_600_000, rates: ANTHROPIC.rates })
  assert.ok(p.switchUsd > p.freshUpUsd, JSON.stringify(p))
  const small = priceRecovery({ current: 'sonnet', to: 'opus', prefixTokens: 8_000, remainingRequests: 2, outPerRequest: 1_000, packetTokens: 6_000, ttlMs: 3_600_000, rates: ANTHROPIC.rates })
  assert.ok(small.switchUsd < small.freshUpUsd, 'at 8k a switch is cheaper than a fresh run')
})

test('recovery: pin, cold or small context first; then same-model rescue, stronger rescue, hold', () => {
  const prices = { switchUsd: 2, freshSameUsd: 0.3, freshUpUsd: 0.6, basis: 'estimate' as const }
  const base = { rule: 'rescue' as const, current: 'sonnet' as const, to: 'opus' as const, pinned: false, warm: true, prefixTokens: 150_000, smallContext: 30_000, effortCapped: false, observedCritical: false, rescued: {}, prices }
  assert.equal(recovery({ ...base, pinned: true }).action, 'rescue-same', 'a pin allows a fresh builder on the pinned model')
  assert.equal(recovery({ ...base, pinned: true, effortCapped: true, rescued: { sonnet: 1 } }).action, 'hold', 'and never moves up')
  assert.equal(recovery({ ...base, pinned: true, warm: false }).action, 'rescue-same', 'a pin outranks a cheap switch')
  assert.equal(recovery({ ...base, warm: false }).action, 'switch', 'a cold cache loses nothing')
  assert.equal(recovery({ ...base, prefixTokens: 20_000 }).action, 'switch')
  assert.equal(recovery(base).action, 'rescue-same', 'not at top effort: the attempt, not the model, is the likely fault')
  assert.equal(recovery({ ...base, effortCapped: true }).action, 'rescue-up')
  assert.equal(recovery({ ...base, rescued: { sonnet: 1 } }).action, 'rescue-up')
  assert.equal(recovery({ ...base, rescued: { sonnet: 1 }, prices: { ...prices, switchUsd: 0.4 } }).action, 'switch', 'priced: a switch under the fresh builder wins')
  assert.equal(recovery({ ...base, rescued: { sonnet: 1, opus: 1 } }).action, 'hold', 'one rescue per model')
  assert.equal(recovery({ ...base, rule: 'hold' }).action, 'hold')
  assert.equal(recovery({ ...base, rule: 'hold', observedCritical: true }).action, 'switch', 'quality first on observed critical risk')
})

test('watchdog: no pass, failures and context growth since the first edit fire it early', () => {
  assert.equal(unproductive({ failuresSinceFirstEdit: 2, passesSinceFirstEdit: 0, growthSinceFirstEdit: 45_000, prefixTokens: 70_000 }), true)
  assert.equal(unproductive({ failuresSinceFirstEdit: 2, passesSinceFirstEdit: 1, growthSinceFirstEdit: 90_000, prefixTokens: 120_000 }), false, 'a pass is progress')
  assert.equal(unproductive({ failuresSinceFirstEdit: 2, passesSinceFirstEdit: 0, growthSinceFirstEdit: 10_000, prefixTokens: 105_000 }), true)
  assert.equal(unproductive({ failuresSinceFirstEdit: 1, passesSinceFirstEdit: 0, growthSinceFirstEdit: 90_000, prefixTokens: 140_000 }), false, 'one failure is ordinary work in a large repository')
  assert.equal(unproductive({ failuresSinceFirstEdit: 1, passesSinceFirstEdit: 0, growthSinceFirstEdit: 30_000, prefixTokens: 60_000 }), false, 'one failure is ordinary work')
})

test('Haiku price step: past 100k Haiku still costs about half of Sonnet per request, so it stays', () => {
  const below = haikuPriceStep(ANTHROPIC.rates, 90_000, 1_500)
  assert.equal(below.crossed, false)
  const above = haikuPriceStep(ANTHROPIC.rates, 140_000, 1_500)
  assert.equal(above.crossed, true)
  assert.equal(above.verdict, 'stay')
  assert.ok(above.haikuUsd < above.sonnetUsd && above.haikuUsd > above.sonnetUsd / 3, JSON.stringify(above))
})

test('rescue mode: repair only when a check passed after the first edit', () => {
  assert.equal(rescueMode(100, [150]), 'repair')
  assert.equal(rescueMode(100, [50]), 'restart', 'a pass before the edits says nothing about them')
  assert.equal(rescueMode(null, [150]), 'restart')
})

test('the rescue brief: a restart runs in its own worktree and folds back only on a pass; repair keeps the work', () => {
  const restart = rescueNote({ family: 'sonnet', mode: 'restart', because: 'the same check failed 3 times after edits', packet: 'Goal: fix it\nThe person later said: keep the old flag name', passedChecks: [], failedApproaches: ['`pytest -q` failed 3 times'], remainingUsd: 1.5, worktree: '/w/repo-automode-rescue-1' })
  assert.match(restart, /git worktree add -q \/w\/repo-automode-rescue-1 HEAD/)
  assert.match(restart, /subagent_type "automode:builder" and model "sonnet"/)
  assert.match(restart, /Work only in \/w\/repo-automode-rescue-1/)
  assert.match(restart, /If its checks pass there, fold it back/)
  assert.match(restart, /keep the old flag name/, 'the person\'s correction travels with the brief')
  assert.match(restart, /Already tried, do not repeat: `pytest -q` failed 3 times/)
  assert.match(restart, /\$1\.50 of its budget left/)
  const repair = rescueNote({ family: 'opus', mode: 'repair', because: 'x', packet: 'p', passedChecks: ['pytest -q tests/a.py'], failedApproaches: [], remainingUsd: null, worktree: '/w/r-2' })
  assert.match(repair, /Mode: repair\. Keep the current changes: these checks passed after the first edit: pytest -q tests\/a\.py/)
  assert.doesNotMatch(repair, /worktree/)
  assert.match(builderNote('sonnet'), /subagent_type "automode:builder" and model "sonnet"/)
})

test('v6 effort steps stop at high', () => {
  assert.equal(v6RaiseAllowed('medium'), true)
  assert.equal(v6RaiseAllowed('high'), true)
  assert.equal(v6RaiseAllowed('xhigh'), false)
  assert.equal(v6RaiseAllowed('max'), false)
})
