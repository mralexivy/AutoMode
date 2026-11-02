import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ARMS, RESCUE_BASELINE } from './arms.mts'

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
