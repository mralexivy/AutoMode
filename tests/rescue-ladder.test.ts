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
