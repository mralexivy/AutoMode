import test from 'node:test'
import assert from 'node:assert/strict'
import { replay, tasksOf } from './learn-replay.mts'

const route = (taskId: string, model: string, at: number) => ({ kind: 'decision', taskId, at, effective: { model }, auto: { hm: { tier: 'T2' }, need: { verdict: 'sonnet/high' } } })

test('tasksOf reads a move to Opus and a correction as bad, and a passing check as ok', () => {
  const t = tasksOf([route('a', 'claude-sonnet-5-5', 1), route('a', 'claude-opus-5-5', 2), route('b', 'claude-sonnet-5-5', 3), { kind: 'signal', taskId: 'b', next: 'corrected' }, route('c', 'claude-sonnet-5-5', 4), { kind: 'outcome', taskId: 'c', checks: { pass: 1 } } as never])
  assert.deepEqual(t.map((x) => [x.id, x.outcome]), [['a', 'bad'], ['b', 'bad'], ['c', 'ok']])
  assert.equal(t[0].bucket, 'T2/sonnet')
})

test('replay counts tasks after the bucket was learned', () => {
  const t = tasksOf(['a', 'b', 'c'].flatMap((id, i) => [route(id, 'claude-sonnet-5-5', i + 1), { kind: 'signal', taskId: id, next: 'retried' }]))
  const r = replay(t)
  assert.equal(r.changed, 1)
  assert.deepEqual(r.learned, ['T2/sonnet'])
})
