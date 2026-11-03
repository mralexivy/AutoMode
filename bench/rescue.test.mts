import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ARMS, RESCUE_BASELINE } from './arms.mts'
import { workspaceEnv } from './runners/claude-code.mts'

const config = (id: string) => (ARMS[id].plugin as { config: Record<string, unknown> }).config

// The rescue arms are a controlled set: `baseline` holds every rescue setting at its old value, and each other rescue
// arm changes exactly one of them, so a difference in a run has one cause.
test('rescue arms: baseline is explicit, and each arm changes one setting', () => {
  const base = config('baseline')
  for (const [k, v] of Object.entries(RESCUE_BASELINE)) assert.equal(base[k], v, k)
  for (const id of Object.keys(ARMS).filter((a) => a.startsWith('rescue-') && a !== 'rescue-all')) {
    const c = config(id)
    const changed = Object.keys(RESCUE_BASELINE).filter((k) => c[k] !== RESCUE_BASELINE[k])
    assert.equal(changed.length, 1, `${id} changes ${changed.join(', ') || 'nothing'}`)
  }
})

test('rescue-all changes every rescue setting', () => {
  const c = config('rescue-all')
  for (const [k, v] of Object.entries(RESCUE_BASELINE)) assert.notEqual(c[k], v, k)
})

test('workspaceEnv: the agent gets the Python path the grader uses, and only where the task has one', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'))
  assert.equal(workspaceEnv(ws, { A: '1' }).PYTHONPATH, undefined)
  fs.mkdirSync(path.join(ws, '.bench-deps'))
  assert.equal(workspaceEnv(ws, {}).PYTHONPATH, path.join(ws, '.bench-deps'))
  assert.equal(workspaceEnv(ws, { PYTHONPATH: '/x' }).PYTHONPATH, `${path.join(ws, '.bench-deps')}${path.delimiter}/x`)
})
