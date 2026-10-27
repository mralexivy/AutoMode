// @ts-nocheck TODO(types): 2 errors with strict off. Fix them and delete this line to turn checking on for this file.
// Ordinal bands, kept from policy v4.1 for ordering only: defect-escalation steps, the challenge floor, the
// mid-turn comparison, and the demand band in legacy records. They never choose an effort (policy auto: lib/auto.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { tierOf } from '../hooks/lib/optimizer.ts'
import { BAND_OF, demandBand, TIER_BAND } from '../hooks/lib/bands.ts'
import { escalationTarget } from '../hooks/lib/auto.ts'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

test('bands never fall as effort rises on one model', () => {
  for (const f of ['haiku', 'sonnet', 'opus']) for (let i = 1; i < EFFORTS.length; i++) assert.ok(BAND_OF[f][EFFORTS[i]] >= BAND_OF[f][EFFORTS[i - 1]], `${f} ${EFFORTS[i]}`)
})

test('escalation walks the band order one step at a time and stops at the tier it was given', () => {
  const walk = []
  let cur = { family: 'sonnet', effort: 'medium' }
  for (let i = 0; i < 6; i++) { cur = escalationTarget(cur, 'T4', ['sonnet', 'opus']); walk.push(`${cur.family}/${cur.effort}`) }
  assert.deepEqual(walk, ['sonnet/high', 'opus/high', 'opus/xhigh', 'opus/max', 'opus/max', 'opus/max'])
  assert.equal(escalationTarget({ family: 'sonnet', effort: 'high' }, 'T2', ['sonnet', 'opus']).family, 'sonnet', 'a T2 floor never moves Sonnet high to Opus')
  assert.equal(escalationTarget({ family: 'sonnet', effort: 'high' }, 'T3', ['sonnet']).family, 'sonnet', 'with Opus out, the step stays on what is available')
})

test('demandBand records every raise, and an unsure judge raises hard work only (legacy records)', () => {
  assert.deepEqual(demandBand({ tier: 'T3' }), { band: 3, unsure: false, why: ['judge T3'] })
  assert.deepEqual(demandBand({ tier: 'T1', planning: true, unsure: true }).why, ['judge T1', 'plan mode', 'judge unsure'])
  for (const tier of ['T0', 'T1']) {
    const d = demandBand({ tier, unsure: true })
    assert.equal(d.band, TIER_BAND[tier])
    assert.ok(d.unsure && d.why[1].startsWith('judge unsure (no raise'))
  }
  assert.equal(demandBand({ tier: 'T2', unsure: true }).band, 3)
  assert.equal(demandBand({ tier: 'T4', unsure: true, failures: 3 }).band, 5, 'the band stops at the max band')
  assert.equal(tierOf('opus', 'low'), 'T3', 'a tier label names the model family; effort sits beside it')
})
