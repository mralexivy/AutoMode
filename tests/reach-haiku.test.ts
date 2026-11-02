// reachHaiku end to end: the flag must reach every decision path, not only the library rule.
import { describe, expect, test } from 'claude-code/testing'
import { harness, judge, says } from './harness.ts'

const low = { policy: 'auto', judge: judge({ tier: 'T1', newTask: true, confidence: 0.9 }), effortJudge: says('sonnet', 'medium') }

describe('reachHaiku', () => {
  test('on: T1 work a judge rates as Sonnet runs on Haiku', async ($, on) => {
    const h = harness(on, { ...low, config: { reachHaiku: true } })
    await h.submit($, 'add a flag to the parser')
    await h.step($)
    expect(h.steps[h.steps.length - 1].model).toContain('haiku')
  })

  test('off: the same work runs on Sonnet', async ($, on) => {
    const h = harness(on, low)
    await h.submit($, 'add a flag to the parser')
    await h.step($)
    expect(h.steps[h.steps.length - 1].model).toContain('sonnet')
  })

  test('on: T2 with need=opus runs on Opus', async ($, on) => {
    const h = harness(on, { policy: 'auto', judge: judge({ tier: 'T2', newTask: true, confidence: 0.9 }), effortJudge: says('opus', 'high'), config: { reachHaiku: true } })
    await h.submit($, 'rework set operation precedence')
    await h.step($)
    expect(h.steps[h.steps.length - 1].model).toContain('opus')
  })
})
