// Tests for the KPI script (scripts/am-kpi.mjs): its definitions, and its price table kept equal to hooks/lib/prices.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kpi, RATES, usdAt } from '../scripts/am-kpi.mjs'
import { ANTHROPIC, usageUsd } from '../hooks/lib/prices.ts'

test('kpi: the price table is the Anthropic row of prices.ts', () => {
  for (const f of ['haiku', 'sonnet', 'opus']) {
    assert.equal(RATES[f].input, ANTHROPIC.rates[f].input)
    assert.equal(RATES[f].output, ANTHROPIC.rates[f].output)
    assert.equal(RATES[f].cacheReadX, ANTHROPIC.rates[f].cacheReadX)
    const u = { input: 100, output: 2000, cacheRead: 150_000, cacheWrite5m: 1000, cacheWrite1h: 20_000 }
    assert.ok(Math.abs(usdAt(u, f) - usageUsd(u, ANTHROPIC.rates[f])) < 1e-9, f)
  }
})

test('kpi: cost per accepted task counts the failures in the spend, and an unknown outcome in neither', () => {
  const u = { input: 1, output: 100, cacheRead: 10_000, cacheWrite5m: 0, cacheWrite1h: 0 }
  const req = (task, at, usd, extra = {}) => ({ kind: 'request', sessionId: 's', taskId: task, at, sent: { model: 'claude-sonnet-5-5' }, answered: { model: 'claude-sonnet-5-5' }, usage: u, usd: { value: usd }, ...extra })
  const r = [
    { kind: 'decision', sessionId: 's', taskId: 'a', at: 1, point: 'prompt', policy: 'v4.1', stage: 'implement', effective: { model: 'claude-sonnet-5-5', effort: 'medium' } },
    req('a', 2, 1.0), { kind: 'outcome', sessionId: 's', taskId: 'a', at: 3, checks: { pass: 1, fail: 0 }, durationMs: 4000 },
    { kind: 'signal', sessionId: 's', taskId: 'a', at: 4, next: 'moved-on' },
    { kind: 'decision', sessionId: 's', taskId: 'b', at: 5, point: 'prompt', policy: 'v4.1', stage: 'debug', effective: { model: 'claude-opus-5-5', effort: 'high' } },
    req('b', 6, 3.0, { sent: { model: 'claude-opus-5-5' }, answered: { model: 'claude-opus-5-5' } }), { kind: 'outcome', sessionId: 's', taskId: 'b', at: 7, checks: { pass: 0, fail: 1 }, durationMs: 9000 },
    { kind: 'signal', sessionId: 's', taskId: 'b', at: 8, next: 'corrected' },
    { kind: 'model-call', purpose: 'judge', sessionId: 's', at: 5.5, usd: { value: 0.001 }, ms: 1200 },
    { kind: 'decision', sessionId: 's', taskId: 'c', at: 9, point: 'prompt', policy: 'v4.1', stage: 'lookup', effective: { model: 'claude-haiku-5-5', effort: 'medium' } },
    req('c', 10, 0.5),
  ]
  const k = kpi(r).byPolicy['v4.1']
  assert.equal(k.tasks, 3)
  assert.equal(k.known, 2, 'task c has no next prompt: unknown')
  assert.equal(k.accepted, 1)
  assert.equal(k.costPerAcceptedTask, 4.001, 'the failed task b and its judge call are paid by the accepted one')
  assert.equal(k.reworkRate, 0.3333)
  const all = kpi(r)
  assert.equal(all.modelSwitches, 2)
  assert.equal(all.opusUsd.main, 3)
  assert.equal(all.turnLatencyMs.p50, 4000)
  assert.equal(all.stageRoutes['debug opus/high'], 1)
  assert.ok(all.baselines.allOpus > all.baselines.allSonnet)
  assert.equal(all.reviewCompletionKnown, false, 'no agent records: completion is unknown, not zero')
  const withAgent = kpi([...r, { kind: 'agent', sessionId: 's', taskId: 'a', at: 2.5, type: 'automode:reviewer' }])
  assert.equal(withAgent.reviewCompletionKnown, true)
})
