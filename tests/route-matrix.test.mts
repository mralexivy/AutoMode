// Route invariants for policy auto. Walks every combination of AutoMode tier (a failed judge included), complexity,
// consequence, effortless model, per-model verdict effort and allowed-model set through optimizeAuto with the real
// attempt cost, and asserts the quality rules hold in all of them. Example cases live in auto-lib.test.mts.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { optimizeAuto, type AutoFloors, type AutoInput, type FamilyVerdict } from '../hooks/lib/auto.ts'
import { BAND_OF } from '../hooks/lib/bands.ts'
import { attemptCost, DEFAULT_PRIORS, TASK_STEPS } from '../hooks/lib/optimizer.ts'
import { ANTHROPIC } from '../hooks/lib/prices.ts'
import { EFFORTS, type Complexity, type Effort, type Family, type Risk, type Tier } from '../hooks/lib/types.ts'
import type { ModelKey } from '../hooks/lib/effortless.ts'

const TIER_OPTIONS: (Tier | null)[] = [null, 'T0', 'T1', 'T2', 'T3', 'T4']
const COMPLEXITIES: Complexity[] = ['trivial', 'standard', 'complex']
const RISKS: Risk[] = ['none', 'elevated', 'critical']
const MODELS: ModelKey[] = ['haiku', 'sonnet', 'opus', 'fable']
const VERDICT_EFFORTS: (Effort | null)[] = [null, ...EFFORTS]
const ALLOWED: Family[][] = [['haiku'], ['sonnet'], ['opus'], ['haiku', 'sonnet'], ['haiku', 'opus'], ['sonnet', 'opus'], ['haiku', 'sonnet', 'opus']]
const at = (e: Effort) => EFFORTS.indexOf(e)

const cache = { model: null, effort: null, prefixTokens: 60_000, lastRequestAt: null, ttlMs: 300_000, effortSharesCache: true }
const memo = new Map<string, number>()
function costFor(complexity: Complexity) {
  return (family: Family, effort: Effort) => {
    const key = `${complexity}/${family}/${effort}`
    let usd = memo.get(key)
    if (usd === undefined) {
      usd = attemptCost({ family, effort, cap: { lo: 0, hi: 0 } }, { steps: TASK_STEPS[complexity] }, { cache, warm: {}, now: 0, prices: ANTHROPIC, priors: DEFAULT_PRIORS, neutral: true }).usd
      memo.set(key, usd)
    }
    return usd
  }
}

// The consequence floors autoFloors (v4.ts) sets; tests/auto.test.ts checks that path end to end.
function floorsFor(consequence: Risk, complexity: Complexity): AutoFloors {
  if (consequence !== 'critical' || complexity === 'trivial') return { because: [] }
  return { effortMin: { sonnet: 'high', opus: 'medium' }, exclude: { haiku: 'critical' }, because: ['critical'] }
}

const verdict = (model: ModelKey, effort: Effort): FamilyVerdict => ({ model, effort, why: '' })

interface Case { input: AutoInput; tier: Tier | null; complexity: Complexity; consequence: Risk; model: ModelKey }

function* cases(): Generator<Case> {
  for (const tier of TIER_OPTIONS) for (const complexity of COMPLEXITIES) for (const consequence of RISKS) for (const model of MODELS)
    for (const allowed of ALLOWED) for (const haiku of VERDICT_EFFORTS) for (const sonnet of VERDICT_EFFORTS) for (const opus of VERDICT_EFFORTS) {
      const verdicts: AutoInput['verdicts'] = {}
      if (haiku) verdicts.haiku = verdict(model, haiku)
      if (sonnet) verdicts.sonnet = verdict(model, sonnet)
      if (opus) verdicts.opus = verdict(model, opus)
      yield { tier, complexity, consequence, model, input: { allowed, verdicts, hm: tier ? { tier, complexity } : null, consequence, floors: floorsFor(consequence, complexity), current: null, cost: costFor(complexity) } }
    }
}

test('every route keeps the quality rules', () => {
  let walked = 0
  for (const c of cases()) {
    walked++
    const { best, inadequate } = optimizeAuto(c.input)
    const where = () => JSON.stringify({ tier: c.tier, complexity: c.complexity, consequence: c.consequence, model: c.model, allowed: c.input.allowed, verdicts: c.input.verdicts, best: `${best.family}/${best.effort}`, inadequate })
    const hasEffortlessAnswer = Object.keys(c.input.verdicts).length > 0

    assert.ok(c.input.allowed.includes(best.family), `an allowed model: ${where()}`)
    if (!inadequate && best.family === 'haiku' && c.input.allowed.length > 1) {
      assert.equal(c.tier, 'T0', `Haiku needs the AutoMode judge at T0: ${where()}`)
      assert.equal(c.model, 'haiku', `Haiku needs the effortless judge too: ${where()}`)
    }
    if (best.family === 'opus' && (c.tier === 'T4' || (hasEffortlessAnswer && c.model === 'fable')))
      assert.ok(at(best.effort) >= at('high'), `hard work never runs Opus below high: ${where()}`)
    if (c.consequence === 'critical' && c.complexity !== 'trivial' && c.input.allowed.some((f) => f !== 'haiku')) {
      assert.notEqual(best.family, 'haiku', `critical work leaves Haiku: ${where()}`)
      if (best.family === 'sonnet') assert.ok(at(best.effort) >= at('high'), `critical work on Sonnet: ${where()}`)
      if (best.family === 'opus') assert.ok(at(best.effort) >= at('medium'), `critical work on Opus: ${where()}`)
    }
    if ((c.tier === 'T3' || c.tier === 'T4') && hasEffortlessAnswer) assert.notEqual(best.effort, 'low', `T3 and T4 never run at low: ${where()}`)
  }
  assert.ok(walked > 100_000, `walked ${walked}`)
})

test('an explicit user effort beats every floor', () => {
  for (const tier of ['T3', 'T4'] as Tier[]) for (const model of MODELS) for (const effort of EFFORTS) {
    const { best } = optimizeAuto({ allowed: ['sonnet', 'opus'], verdicts: { opus: verdict(model, 'high') }, hm: { tier, complexity: 'complex' }, floors: { fixedEffort: effort, fixedFamily: 'opus', because: [] }, current: null, cost: costFor('complex') })
    assert.equal(best.effort, effort, `${tier} ${model} ${effort}`)
  }
})

test('raising the running verdict never lowers the band of a fixed model', () => {
  for (const tier of TIER_OPTIONS) for (const family of ['sonnet', 'opus'] as Family[]) {
    let last = -Infinity
    for (const effort of EFFORTS) {
      const { best } = optimizeAuto({ allowed: [family], verdicts: { [family]: verdict(family, effort) }, hm: tier ? { tier, complexity: 'standard' } : null, floors: { because: [] }, current: null, cost: costFor('standard') })
      const band = BAND_OF[best.family][best.effort]
      assert.ok(band >= last, `${tier} ${family} ${effort}: band ${band} after ${last}`)
      last = band
    }
  }
})
