// @ts-nocheck TODO(types): 2 errors with strict off. Fix them and delete this line to turn checking on for this file.
// Ordinal bands, kept from policy v4.1 for ordering only: defect-escalation steps, the challenge floor, the
// mid-turn comparison, and the demand band in legacy records. They never choose an effort (policy auto: lib/auto.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { tierOf } from '../hooks/lib/optimizer.ts'
import { BAND_OF, demandBand, ladderStep, nextEffort, TIER_BAND } from '../hooks/lib/bands.ts'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

test('bands never fall as effort rises on one model', () => {
  for (const f of ['haiku', 'sonnet', 'opus']) for (let i = 1; i < EFFORTS.length; i++) assert.ok(BAND_OF[f][EFFORTS[i]] >= BAND_OF[f][EFFORTS[i - 1]], `${f} ${EFFORTS[i]}`)
})

test('the ladder: weak evidence walks the efforts of the running model, and Sonnet xhigh is a rung', () => {
  const walk = []
  let cur = { family: 'sonnet', effort: 'medium' }
  for (let s; (s = ladderStep(cur, 'weak', ['sonnet', 'opus'])); cur = s) walk.push(`${s.family}/${s.effort}`)
  assert.deepEqual(walk, ['sonnet/high', 'sonnet/xhigh'], 'weak evidence never moves the model')
  assert.ok(BAND_OF.sonnet.xhigh > BAND_OF.sonnet.high && BAND_OF.sonnet.xhigh < BAND_OF.opus.high)
  assert.equal(nextEffort('sonnet', 'xhigh'), undefined, 'Sonnet max buys no rung')
  assert.equal(nextEffort('haiku', 'medium'), undefined, 'Haiku effort buys no rung')
  assert.deepEqual(ladderStep({ family: 'opus', effort: 'high' }, 'weak', []), { family: 'opus', effort: 'xhigh', band: 4, kind: 'effort' })
  assert.equal(ladderStep({ family: 'opus', effort: 'max' }, 'weak', []), null)
})

test('the ladder: strong evidence moves the model, and only effort is left on Opus or with Opus out', () => {
  assert.deepEqual(ladderStep({ family: 'sonnet', effort: 'high' }, 'strong', ['sonnet', 'opus']), { family: 'opus', effort: 'high', band: 3, kind: 'model' })
  assert.deepEqual(ladderStep({ family: 'haiku', effort: 'medium' }, 'strong', ['haiku', 'sonnet']), { family: 'sonnet', effort: 'medium', band: 1, kind: 'model' })
  assert.deepEqual(ladderStep({ family: 'opus', effort: 'high' }, 'strong', ['sonnet', 'opus']), { family: 'opus', effort: 'xhigh', band: 4, kind: 'effort' })
  assert.deepEqual(ladderStep({ family: 'sonnet', effort: 'medium' }, 'strong', ['sonnet']), { family: 'sonnet', effort: 'high', band: 2, kind: 'effort' })
  assert.equal(ladderStep({ family: 'sonnet', effort: 'xhigh' }, 'strong', ['sonnet']), null)
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
