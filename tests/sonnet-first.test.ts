// sonnetFirst end to end: the flag must reach every decision path, not only the library rule.
import { describe, expect, test } from 'claude-code/testing'
import { harness, judge, perModel } from './harness.ts'

const setup = (o = {}) => ({ policy: 'auto', judge: judge({ tier: 'T3', complexity: 'complex', newTask: true, confidence: 0.9 }), effortJudge: perModel({ sonnet: ['opus', 'high'], opus: ['opus', 'high'] }), ...o })

describe('sonnetFirst', () => {
  test('on: a T3 task whose need names Opus runs on Sonnet at high', async ($, on) => {
    const h = harness(on, setup({ config: { sonnetFirst: true } }))
    await h.submit($, 'redesign the parser precedence across modules')
    await h.step($)
    const last = h.steps[h.steps.length - 1]
    expect(last.model).toContain('sonnet')
    expect(JSON.stringify(last.effort)).toContain('high')
  })

  test('off: the same task runs on Opus', async ($, on) => {
    const h = harness(on, setup())
    await h.submit($, 'redesign the parser precedence across modules')
    await h.step($)
    expect(h.steps[h.steps.length - 1].model).toContain('opus')
  })

  test('on: critical work still runs on Opus', async ($, on) => {
    const h = harness(on, setup({ config: { sonnetFirst: true }, judge: judge({ tier: 'T3', complexity: 'complex', risk: 'critical', consequence: 'critical', newTask: true, confidence: 0.9 }) }))
    await h.submit($, 'redesign the parser precedence across modules')
    await h.step($)
    expect(h.steps[h.steps.length - 1].model).toContain('opus')
  })
})
