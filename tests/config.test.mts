// The shipped config.json is the production profile. Each scope has its own switch, and this file pins the intent so
// that a later edit cannot quietly widen or narrow a scope.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const cfg = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'))

test('main-thread routing: V4 in auto mode with policy auto (model and effort together)', () => {
  assert.equal(cfg.router, 'v4')
  assert.equal(cfg.mode, 'auto')
  assert.equal(cfg.policy, 'auto')
})

test('automatic workflow entry ships off: no benchmark shows its value yet', () => {
  assert.equal(cfg.autoWorkflow, false)
})

test('subagent routing runs in every session, as its own switch', () => {
  assert.equal(cfg.subagentsEverySession, true)
})

test('the guardian runs in every session, and its features have their own switches', () => {
  assert.equal(cfg.guardian.mode, 'auto')
  assert.equal(cfg.guardian.everySession, true)
  assert.equal(cfg.guardian.autoCompact, true)
  assert.equal(cfg.guardian.reduceOutputs, true)
})

test('hard pause ships on: it ends a turn only between requests, never right after a write', () => {
  assert.equal(cfg.guardian.hardPause, true)
})
