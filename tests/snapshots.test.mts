import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SNAPSHOTS_KEPT, snapshotsToDrop } from '../hooks/lib/snapshots.ts'

test('snapshots: only the newest sessions keep one, so the 4 MiB store never fills', () => {
  // Found in W1: 376 snapshots, 5.2 MB; every save was refused, and no resumed session could restore.
  const keys = ['tips', ...Array.from({ length: 376 }, (_, i) => `hm4:s${i}`)]
  const drop = snapshotsToDrop(keys, 'hm4:s375')
  assert.equal(drop.length, 375 - (SNAPSHOTS_KEPT - 1))
  assert.ok(!drop.includes('tips'), 'other keys stay')
  assert.ok(!drop.includes('hm4:s375'), 'the session being saved stays')
  assert.deepEqual(drop.slice(0, 2), ['hm4:s0', 'hm4:s1'], 'the oldest go first')
  assert.deepEqual(snapshotsToDrop(['hm4:a', 'hm4:b'], 'hm4:c'), [])
})
