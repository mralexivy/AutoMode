// Route learning end to end in the mocked engine: rescues and corrections teach, the next task of that kind starts on
// Opus, and learning off changes nothing. The rules themselves are in tests/learn.test.mts.
import { describe, expect, test } from 'claude-code/testing'
import { harness, judge, records, says } from './harness.ts'

const T = (o = {}) => ({ policy: 'auto', judge: judge({ tier: 'T2', newTask: true, confidence: 0.9 }), effortJudge: says('sonnet', 'high'), ...o })
const file = (h: any) => Object.keys(h.writes).find((k) => /learned-/.test(k))
const memory = (h: any) => JSON.parse(h.writes[file(h)!] ?? '{"tasks":[]}')
const round = async ($: any, h: any, text: string) => { await h.submit($, text); await h.step($); await h.complete($) }
const model = (h: any) => h.steps[h.steps.length - 1].model

describe('Route learning', () => {
  test('a correction marks the task bad, and two of them start that kind of task on Opus', async ($, on) => {
    const h = harness(on, T({ config: { learning: true } }))
    await round($, h, 'add a retry counter to the client')
    expect(model(h)).toContain('sonnet')
    await round($, h, 'that is wrong, it still fails')
    await round($, h, 'write a parser for the config format')
    await round($, h, 'no, that broke the build')
    expect(memory(h).tasks.filter((t: any) => t.outcome === 'bad').length).toBeGreaterThanOrEqual(2)
    await round($, h, 'add a cache layer to the fetcher')
    expect(model(h)).toContain('opus')
    expect(records(h.writes).some((x) => x.kind === 'learned')).toBe(true)
  })

  test('with learning off nothing is written and the route stays', async ($, on) => {
    const h = harness(on, T())
    await round($, h, 'add a retry counter to the client')
    await round($, h, 'that is wrong, it still fails')
    await round($, h, 'write a parser for the config format')
    await round($, h, 'no, that broke the build')
    await round($, h, 'add a cache layer to the fetcher')
    expect(file(h)).toBeUndefined()
    expect(model(h)).toContain('sonnet')
  })

  test('a person who pinned a model keeps it', async ($, on) => {
    const h = harness(on, T({ config: { learning: true } }))
    await round($, h, 'add a retry counter to the client')
    await round($, h, 'that is wrong, it still fails')
    await round($, h, 'write a parser for the config format')
    await round($, h, 'no, that broke the build')
    await round($, h, 'am:sonnet add a cache layer to the fetcher')
    expect(model(h)).toContain('sonnet')
  })
})
