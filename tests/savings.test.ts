// Live savings end to end: a prompt AutoMode moves off the session's model shows its estimated saving in /automode.
import { describe, expect, test } from 'claude-code/testing'
import { harness, judge, says } from './harness.ts'

const low = { policy: 'auto', judge: judge({ tier: 'T1', newTask: true, confidence: 0.9 }), effortJudge: says('sonnet', 'medium'), config: { reachHaiku: true } }

describe('live savings', () => {
  test('a prompt routed to Haiku in a Sonnet session reports a saving against Sonnet', async ($, on) => {
    const h = harness(on, low)
    await h.submit($, 'add a flag to the parser')
    await h.step($)
    await h.complete($)
    expect(h.steps[h.steps.length - 1].model).toContain('haiku')
    const r: any = await $.command.run({ command: 'automode', args: 'details' })
    expect(String(r?.text ?? '')).toMatch(/Saved: (about \$\d|\$\d.* still to pay back)/)
    expect(String(r?.text ?? '')).toContain('against Sonnet')
  })

  test('a session that stays on its model reports nothing saved', async ($, on) => {
    const h = harness(on, { ...low, config: { reachHaiku: false } })
    await h.submit($, 'add a flag to the parser')
    await h.step($)
    await h.complete($)
    const r: any = await $.command.run({ command: 'automode', args: 'details' })
    expect(String(r?.text ?? '')).toContain('Saved: nothing yet')
  })
})
