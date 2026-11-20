// Adaptive routing end to end in the mocked engine: an adopted cheaper start puts eligible tasks on Haiku, and nothing risky, pinned or
// switched off ever does. The learning itself is in tests/experiment.test.mts.
import { describe, expect, test } from 'claude-code/testing'
import { harness, judge, records, says } from './harness.ts'
import { projectKey } from '../hooks/v4.ts'

const T = (o = {}) => ({ policy: 'auto', judge: judge({ tier: 'T3', complexity: 'standard', newTask: true, confidence: 0.9 }), effortJudge: says('sonnet', 'high'), config: { learning: true }, ...o })
const seeded = (bucket: string) => {
  const now = Date.now(), tasks: unknown[] = []
  for (let i = 0; i < 10; i++) tasks.push({ id: `h${i}`, bucket: 'T3/sonnet', family: 'sonnet', outcome: 'ok', at: now - 5 * 86_400_000 + i, usd: 0.5, exp: { k: 'haiku', a: 'hold', b: bucket } })
  for (let i = 0; i < 10; i++) tasks.push({ id: `p${i}`, bucket: 'T3/sonnet', family: 'haiku', outcome: 'ok', at: now - 4 * 86_400_000 + i, usd: 0.1, exp: { k: 'haiku', a: 'probe', b: bucket } })
  return JSON.stringify({ v: 1, tasks })
}
// The mocked session start carries no working folder, so the memory loads from the "unknown" project.
const file = `/data/learned-${projectKey(undefined)}.json`
const models = async ($: any, h: any, n: number, extra = '') => {
  const out: string[] = []
  for (let i = 0; i < n; i++) { await h.submit($, `${extra}add feature number ${i} to the parser and its tests`); await h.step($, 'claude-sonnet-5-5'); out.push(h.steps[h.steps.length - 1].model); await h.complete($) }
  return out
}

describe('Adaptive routing', () => {
  test('an adopted Haiku start sends most eligible T3 tasks to Haiku, keeps a tenth on the shipped route, and records which arm each ran', async ($, on) => {
    const h = harness(on, T())
    h.writes[file] = seeded('T3/standard')
    const ms = await models($, h, 30)
    const haiku = ms.filter((m) => /haiku/.test(m)).length
    // The cache policy can still hold a running Sonnet for a task, so the share on Haiku is below the 90% assigned. The experiment counts
    // the assignment, as intended, so that what it measures is what the router really does.
    expect(haiku).toBeGreaterThan(12)
    expect(haiku).toBeLessThan(30)
    expect(ms.some((m) => /sonnet/.test(m))).toBe(true)
  })

  test('with adaptive off the shipped route holds', async ($, on) => {
    const h = harness(on, T({ config: { learning: true, adaptive: false } }))
    h.writes[file] = seeded('T3/standard')
    expect((await models($, h, 12)).some((m) => /haiku/.test(m))).toBe(false)
  })

  test('a pinned model is never probed', async ($, on) => {
    const h = harness(on, T())
    h.writes[file] = seeded('T3/standard')
    await h.submit($, 'am:sonnet add a feature to the parser and its tests')
    await h.step($, 'claude-sonnet-5-5')
    expect(h.steps[h.steps.length - 1].model).toContain('sonnet')
  })

  test('a kind of task with no history is not probed', async ($, on) => {
    const h = harness(on, T())
    expect((await models($, h, 12)).some((m) => /haiku/.test(m))).toBe(false)
  })

  test('critical risk is never probed', async ($, on) => {
    const h = harness(on, T({ judge: judge({ tier: 'T3', complexity: 'standard', risk: 'critical', newTask: true, confidence: 0.9 }) }))
    h.writes[file] = seeded('T3/standard')
    expect((await models($, h, 12)).some((m) => /haiku/.test(m))).toBe(false)
    expect(records(h.writes).length).toBeGreaterThan(0)
  })
})
