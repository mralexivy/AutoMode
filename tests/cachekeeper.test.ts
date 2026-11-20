// Cache keeper in the mocked engine: the cold-send guard asks before a big cold rewrite. The decisions themselves are in tests/cachekeeper.test.mts.
import { describe, expect, test } from 'claude-code/testing'
import { harness, judge, records, says } from './harness.ts'

const T = (o = {}) => ({ policy: 'auto', judge: judge({ tier: 'T1', newTask: true, confidence: 0.9 }), effortJudge: says('sonnet', 'medium'), fork: 'ok', ...o })
const HOUR = 3_600_000
const warmChat = async ($: any, h: any, tokens = 200_000) => { h.setPrefix(tokens); await h.submit($, 'add a retry counter to the client'); await h.step($); await h.complete($) }

const flush = async ($: any, h: any) => { await h.step($); await h.complete($) }
const guards = (h: any) => records(h.writes).filter((x: any) => x.kind === 'cold-guard')

describe('Cold-send guard', () => {
  // The test kit has no answer for $.ui.ask, so the question fails and the prompt goes as typed. The record shows the guard fired.
  test('fires on a big cold rewrite, and the prompt still goes when no dialog can answer', async ($, on) => {
    const h = harness(on, T())
    await warmChat($, h)
    await h.clock.advance(HOUR + 60_000)
    const r: any = await h.submit($, 'now add the tests')
    await flush($, h)
    expect(r?.drop).toBeUndefined()
    const g = guards(h)
    expect(g.length).toBe(1)
    expect(g[0].choice).toBe('unavailable')
    expect(g[0].prefixTokens).toBeGreaterThan(190_000)
    expect(g[0].rewriteUsd).toBeGreaterThan(0.5)
  })

  test('stays quiet while the cache is warm', async ($, on) => {
    const h = harness(on, T())
    await warmChat($, h)
    await h.submit($, 'now add the tests')
    await flush($, h)
    expect(guards(h).length).toBe(0)
  })

  test('stays quiet below the size limit', async ($, on) => {
    const h = harness(on, T())
    await warmChat($, h, 80_000)
    await h.clock.advance(HOUR + 60_000)
    await h.submit($, 'and the docs')
    await flush($, h)
    expect(guards(h).length).toBe(0)
  })

  test('stays quiet with the guard off in config.json', async ($, on) => {
    const h = harness(on, T({ config: { cacheKeeper: { guard: false } } }))
    await warmChat($, h)
    await h.clock.advance(HOUR + 60_000)
    await h.submit($, 'and the docs')
    await flush($, h)
    expect(guards(h).length).toBe(0)
  })
})
