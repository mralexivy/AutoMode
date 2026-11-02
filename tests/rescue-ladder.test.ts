// The rescue ladder end to end in the mocked engine (policy auto): its records, the settings that change its order, and
// what each consult came to. Every setting at its shipped value keeps the ladder as it was, and tests/overrides.test.ts
// still pins that order.
import { describe, expect, test } from 'claude-code/testing'
import { harness, judge, perModel, records } from './harness.ts'

const sonnetAt = (effort: string, config: Record<string, unknown> = {}) => ({ policy: 'auto', config, judge: judge({ tier: 'T2', complexity: 'standard' }), effortJudge: perModel({ sonnet: ['sonnet', effort], opus: ['opus', 'high'] }) })
const of = (w: Record<string, string>, kind: string) => records(w).filter((x) => x.kind === kind)
const edit = (path = 'parser.go') => ({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b' })
const fail = async ($: any) => { await $.tool.call(edit()); return $.tool.call({ tool: 'Bash', command: 'go test ./...' }) }
const architect = async ($: any) => $.agent.spawn({ subagentType: 'automode:architect', prompt: 'consult', description: 'consult', parentModel: 'claude-sonnet-5-5', fork: false, background: false, tool_use_id: 'a1' } as never)

describe('Rescue records', () => {
  test('an escalation carries the cache state, and a consult run its real duration and cost', async ($, on) => {
    const h = harness(on, sonnetAt('high'))
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await fail($)
    await fail($)
    const esc = of(h.writes, 'escalation')
    expect(esc.map((x) => x.action)).toEqual(['raise', 'consult-opus'])
    expect(esc[1].cache).toMatchObject({ prefixTokens: 30000, warm: true })
    const res: any = await architect($)
    await h.clock.advance(90_000)
    await h.step($, 'claude-opus-5-5', res.agentId)
    await h.complete($, 'claude-opus-5-5', res.agentId, 'Cause: the alias is dropped in src/parse.go.\nPlan: fix src/parse.go, then run go test.')
    const run = of(h.writes, 'consult-run')[0]
    expect(run).toMatchObject({ agentId: res.agentId, durationMs: 90_000, planFiles: 1, aborted: false })
    expect(run.usd).toBeGreaterThan(0)
  })
})

describe('Effort first on strong evidence', () => {
  test('effort-first: raise once, then the consult, then the model', async ($, on) => {
    let passing = true
    const h = harness(on, { ...sonnetAt('high', { strongStep: 'effort-first' }), bash: () => (passing ? { result: 'ok', isError: false, text: '' } : { result: 'Error: Exit code 1\n--- FAIL: TestX (0.00s)\nFAIL', isError: true, text: '' }) })
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await h.clock.advance(1_000) // the regression rule needs the pass to come before the failure
    passing = false
    await $.tool.call(edit())
    const first = await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    expect(JSON.stringify(first)).toContain('escalated to T2 (sonnet xhigh)')
    expect(JSON.stringify(first)).toContain('Effort rises first')
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 1 })
    expect(h.steps.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'xhigh' })
    const second = await fail($)
    expect(JSON.stringify(second)).toContain('automode:architect')
    const third = await fail($)
    expect(JSON.stringify(third)).toContain('escalated to T3 (opus high)')
    const esc = of(h.writes, 'escalation')
    expect(esc.map((x) => [x.level, x.action])).toEqual([['strong', 'raise'], ['strong', 'consult-opus'], ['strong', 'switch']])
    expect(new Set(esc.map((x) => x.episode)).size).toBe(1)
    expect(esc[0].effortFirst).toContain('effort first')
  })

  test('model (the shipped value): the same regression consults at once', async ($, on) => {
    let passing = true
    const h = harness(on, { ...sonnetAt('high'), bash: () => (passing ? { result: 'ok', isError: false, text: '' } : { result: 'Error: Exit code 1\n--- FAIL: TestX (0.00s)\nFAIL', isError: true, text: '' }) })
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await h.clock.advance(1_000) // the regression rule needs the pass to come before the failure
    passing = false
    await $.tool.call(edit())
    const first = await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    expect(JSON.stringify(first)).toContain('automode:architect')
    expect(of(h.writes, 'escalation').map((x) => x.action)).toEqual(['consult-opus'])
  })

  test('critical work skips effort-first: the model path runs at once', async ($, on) => {
    let passing = true
    const h = harness(on, { ...sonnetAt('high', { strongStep: 'effort-first' }), judge: judge({ tier: 'T2', complexity: 'standard', risk: 'critical', riskWhy: 'payment path' }), bash: () => (passing ? { result: 'ok', isError: false, text: '' } : { result: 'Error: Exit code 1\n--- FAIL: TestX (0.00s)\nFAIL', isError: true, text: '' }) })
    await h.submit($, 'change how the payment webhook retries')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await h.clock.advance(1_000) // the regression rule needs the pass to come before the failure
    passing = false
    await $.tool.call(edit())
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    const esc = of(h.writes, 'escalation')
    expect(esc[0].action).not.toBe('raise')
    expect(esc[0].effortFirst).toContain('critical')
  })

  test('a reviewer blocker raises effort first, and a second blocker in the same round consults', async ($, on) => {
    const h = harness(on, { ...sonnetAt('high', { strongStep: 'effort-first' }), bash: () => ({ result: 'ok', isError: false, text: '' }) })
    await h.submit($, 'fix the parser')
    await h.step($)
    const review = async () => { const r: any = await $.agent.spawn({ subagentType: 'automode:reviewer', prompt: 'review', description: 'review', parentModel: 'claude-sonnet-5-5', fork: false, background: false, tool_use_id: 'z' } as never); await h.complete($, 'claude-opus-5-5', r.agentId, 'Verdict: changes_required\nblocker a.go:1') }
    await review()
    await review()
    expect(of(h.writes, 'escalation').map((x) => x.action)).toEqual(['raise', 'consult-opus'])
  })
})

describe('Priced consult', () => {
  const toStrong = async ($: any, h: any) => {
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await fail($) // weak: effort to xhigh
    return fail($) // strong: the Opus-bound step
  }

  test('a small prefix moves the session, and the record says why', async ($, on) => {
    const h = harness(on, sonnetAt('high', { consult: 'priced' }))
    h.setPrefix(4_000)
    const out = await toStrong($, h)
    expect(JSON.stringify(out)).not.toContain('automode:architect')
    expect(JSON.stringify(out)).toContain('A consult would not pay here')
    const last = of(h.writes, 'escalation').at(-1)!
    expect(last).toMatchObject({ action: 'switch' })
    expect(last.estimate.consultUsd).toBeGreaterThan(last.estimate.switchUsd)
  })

  test('a large warm prefix still consults, with its estimate on the record', async ($, on) => {
    const h = harness(on, sonnetAt('high', { consult: 'priced' }))
    h.setPrefix(400_000)
    const out = await toStrong($, h)
    expect(JSON.stringify(out)).toContain('automode:architect')
    const last = of(h.writes, 'escalation').at(-1)!
    expect(last).toMatchObject({ action: 'consult-opus' })
    expect(last.estimate.consultUsd).toBeLessThan(last.estimate.switchUsd)
    expect(last.estimate.basis.durations).toBe('prior')
  })

  test('always (the shipped value) consults whatever the prefix, with no estimate', async ($, on) => {
    const h = harness(on, sonnetAt('high'))
    h.setPrefix(4_000)
    const out = await toStrong($, h)
    expect(JSON.stringify(out)).toContain('automode:architect')
    expect(of(h.writes, 'escalation').at(-1)!.estimate).toBeUndefined()
  })
})
