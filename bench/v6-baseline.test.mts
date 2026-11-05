import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseline, routeOf, stateOf } from './v6-baseline.mts'

const row = (o: Record<string, unknown>) => ({ exit_reason: 'done', accepted: true, cost_usd_api_equiv: 1, ...o })

test('v6 baseline: route kinds, row states and the split against Sonnet high', () => {
  assert.equal(routeOf({ evidence: { requests: { 'claude-haiku-5-5': 3 } } }), 'haiku only')
  assert.equal(routeOf({ evidence: { requests: { 'claude-haiku-5-5': 3, 'claude-sonnet-5-5': 1 } } }), 'switched')
  assert.equal(stateOf(row({ task_id: 't' }), 'x'), 'valid')
  assert.equal(stateOf(row({ task_id: 't', exit_reason: 'quota' }), 'x'), 'cut off')
  assert.equal(stateOf(row({ task_id: 'longctx-dnspython-edns-padding' }), 'automode-proof-v5'), 'contaminated')
  assert.equal(stateOf(row({ task_id: 't', contaminated: true }), 'x'), 'contaminated')
  const b = baseline([
    row({ arm: 'auto', task_id: 'a', cost_usd_api_equiv: 0.5, exit_reason: 'quota' }),
    row({ arm: 'auto', task_id: 'a', cost_usd_api_equiv: 1, evidence: { requests: { 'claude-haiku-5-5': 1, 'claude-sonnet-5-5': 1 } } }),
    row({ arm: 'sonnet-high', task_id: 'a', cost_usd_api_equiv: 0.25, evidence: { requests: { 'claude-sonnet-5-5': 1 } } }),
  ], 'x')
  assert.deepEqual(b.routes.switched, { tasks: 1, usd: 1.5, sonnet: 0.25 }, 'a cut-off attempt counts in the cost')
  assert.deepEqual(b.states, { 'cut off': 1, valid: 1 })
})
