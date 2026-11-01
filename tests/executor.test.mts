import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executorEffort } from '../hooks/lib/executor.ts'

test('medium by default, and a low verdict does not go below it', () => {
  assert.equal(executorEffort(undefined, undefined), 'medium')
  assert.equal(executorEffort('low', undefined), 'medium')
  assert.equal(executorEffort('medium', undefined), 'medium')
})

test('the judge can ask for high and no more', () => {
  assert.equal(executorEffort('high', undefined), 'high')
  assert.equal(executorEffort('xhigh', undefined), 'high')
  assert.equal(executorEffort('max', undefined), 'high')
})

test('a warm task never drops', () => {
  assert.equal(executorEffort('medium', 'high'), 'high')
  assert.equal(executorEffort('low', 'xhigh'), 'xhigh')
  assert.equal(executorEffort('high', 'medium'), 'high')
})
