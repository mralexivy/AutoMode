// The rescue ladder end to end in the mocked engine (policy auto): its records, the settings that change its order, and
// what each consult came to. Every setting at its code default keeps the ladder as it was (config.json ships the rescue values), and tests/overrides.test.ts
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

  test('model (the code default): the same regression consults at once', async ($, on) => {
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

  test('always (the code default) consults whatever the prefix, with no estimate', async ($, on) => {
    const h = harness(on, sonnetAt('high'))
    h.setPrefix(4_000)
    const out = await toStrong($, h)
    expect(JSON.stringify(out)).toContain('automode:architect')
    expect(of(h.writes, 'escalation').at(-1)!.estimate).toBeUndefined()
  })
})

describe('Consult outcomes', () => {
  const ok = { result: 'ok', isError: false, text: '' }
  const bad = { result: 'Error: Exit code 1\n--- FAIL: TestX (0.00s)\nFAIL', isError: true, text: '' }
  const setup = (config: Record<string, unknown> = {}) => { const s = { passing: false }; return { s, h: (on: any) => harness(on, { ...sonnetAt('high', config), judge: (p: string) => judge({ tier: 'T2', complexity: 'standard', newTask: /verbose/.test(p) }), bash: () => (s.passing ? ok : bad) }) } }
  const toConsult = async ($: any, h: any) => {
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await fail($)
    const out = await fail($)
    expect(JSON.stringify(out)).toContain('automode:architect')
    const res: any = await architect($)
    await h.complete($, 'claude-opus-5-5', res.agentId, 'Cause: the alias is dropped in parser.go.\nPlan: fix parser.go.')
  }
  const review = async ($: any, h: any, answer: string) => { const r: any = await $.agent.spawn({ subagentType: 'automode:reviewer', prompt: 'review', description: 'review', parentModel: 'claude-sonnet-5-5', fork: false, background: false, tool_use_id: 'r' } as never); await h.complete($, 'claude-opus-5-5', r.agentId, answer) }

  test('a pass and then an approval: verified_resolved, and the plan was followed', async ($, on) => {
    const { s, h: make } = setup()
    const h = make(on)
    await toConsult($, h)
    s.passing = true
    await fail($) // the edit to parser.go, then the check passes
    expect(of(h.writes, 'consult-outcome')).toEqual([])
    await review($, h, 'Verdict: approve\nNo blockers.')
    expect(of(h.writes, 'consult-outcome')[0]).toMatchObject({ outcome: 'verified_resolved', influence: 'followed', editsAfter: 1 })
  })

  test('the failure comes back and the session moves: escalated', async ($, on) => {
    const { h: make } = setup()
    const h = make(on)
    await toConsult($, h)
    await fail($)
    expect(of(h.writes, 'consult-outcome')[0]).toMatchObject({ outcome: 'escalated' })
  })

  test('a pass with no independent check, then a new task: unverified', async ($, on) => {
    const { s, h: make } = setup()
    const h = make(on)
    await toConsult($, h)
    s.passing = true
    await fail($)
    await h.complete($)
    await h.submit($, 'now add a --verbose flag to the CLI', { origin: { kind: 'composer' } })
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    await h.complete($, 'claude-sonnet-5-5', undefined, 'done', { turnId: 't2' })
    expect(of(h.writes, 'consult-outcome').map((x) => x.outcome)).toEqual(['unverified'])
  })

  test('under a rescue setting a consult requires the review; under the code defaults it does not', async ($, on) => {
    const { h: make } = setup({ consult: 'priced' })
    const h = make(on)
    h.setPrefix(400_000)
    await toConsult($, h)
    await h.complete($)
    const next = await h.submit($, 'keep going on the parser')
    expect(next.context.join('\n')).toContain('an Opus consult ran on a failure')
  })

  test('the code defaults add no review reason for a consult', async ($, on) => {
    const { h: make } = setup()
    const h = make(on)
    await toConsult($, h)
    await h.complete($)
    const next = await h.submit($, 'keep going on the parser')
    expect(next.context.join('\n')).not.toContain('an Opus consult ran on a failure')
  })
})

describe('Consult packet', () => {
  const git = (argv: string[]) => ({ exitCode: 0, stdout: argv.includes('--stat') ? ' parser.go | 2 +-' : '@@ -1 +1 @@\n-a\n+b' })
  const toConsult = async ($: any, h: any, later?: string) => {
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await h.complete($)
    if (later) { await h.submit($, later); await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' }) }
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await fail($)
    return fail($)
  }
  const keep = { judge: (p: string) => judge({ tier: 'T2', complexity: 'standard', newTask: !/old flag/.test(p) }) }

  test('rich: the diff and each source, and no fork', async ($, on) => {
    const h = harness(on, { ...sonnetAt('high', { packet: 'rich' }), git })
    const out = JSON.stringify(await toConsult($, h))
    expect(out).toContain('[git-diff]')
    expect(out).toContain('missing_evidence')
    expect(h.forks.length).toBe(0)
    expect(of(h.writes, 'handoff')[0]).toMatchObject({ source: 'rich', diff: true, fork: null })
  })

  test('fork-gated: a later message is a conversational gap, so a warm fork fills it', async ($, on) => {
    const h = harness(on, { ...sonnetAt('high', { packet: 'fork-gated' }), ...keep, git, fork: '{"constraints": ["keep the old flag name"], "unknowns": ["which dialect fails"]}' })
    h.setPrefix(150_000)
    const out = JSON.stringify(await toConsult($, h, 'no, keep the old flag name'))
    expect(h.forks.length).toBe(1)
    expect(out).toContain('keep the old flag name [conversation]')
    expect(of(h.writes, 'handoff')[0]).toMatchObject({ source: 'fork', fork: { ran: true, ok: true, reason: 'answered' } })
    expect(of(h.writes, 'handoff')[0].fork.usage.cacheRead).toBeGreaterThan(0)
  })

  test('fork-gated: a cold cache makes the fork too dear, so the rich packet goes alone', async ($, on) => {
    const h = harness(on, { ...sonnetAt('high', { packet: 'fork-gated' }), ...keep, git, fork: '{"constraints": [], "unknowns": []}' })
    h.setPrefix(150_000)
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await h.complete($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await fail($)
    await h.clock.advance(2 * 3_600_000) // the cache is cold
    await fail($)
    expect(h.forks.length).toBe(0)
    expect(of(h.writes, 'handoff')[0]).toMatchObject({ source: 'rich', fork: { ran: false } })
    expect(of(h.writes, 'handoff')[0].fork.why).toContain('costs more than 25% of the consult')
  })

  test('fork-gated: nothing to fork falls back to the rich packet', async ($, on) => {
    const h = harness(on, { ...sonnetAt('high', { packet: 'fork-gated' }), ...keep, git, fork: null })
    h.setPrefix(150_000)
    const out = JSON.stringify(await toConsult($, h, 'no, keep the old flag name'))
    expect(h.forks.length).toBe(1)
    expect(out).toContain('[git-diff]')
    expect(of(h.writes, 'handoff')[0]).toMatchObject({ source: 'rich', fork: { ran: true, ok: false, reason: 'nothing-to-fork' } })
  })

  test('basic (the code default): the old packet, no handoff record', async ($, on) => {
    const h = harness(on, { ...sonnetAt('high'), git })
    const out = JSON.stringify(await toConsult($, h))
    expect(out).not.toContain('[git-diff]')
    expect(out).toContain('Files edited so far')
    expect(of(h.writes, 'handoff')).toEqual([])
  })
})

describe('Fork diagnosis rung', () => {
  const fork = async ($: any) => $.agent.spawn({ subagentType: 'fork', prompt: 'diagnose', description: 'diagnose', parentModel: 'claude-sonnet-5-5', fork: true, background: false, tool_use_id: 'f1' } as never)

  test('on: effort, then a fork, then the Opus consult, then the model; the fork run is measured', async ($, on) => {
    const h = harness(on, sonnetAt('high', { forkRung: 'on' }))
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await fail($) // weak: effort
    const forkNote = JSON.stringify(await fail($))
    expect(forkNote).toContain('subagent_type \\"fork\\"')
    expect(forkNote).not.toContain('automode:architect')
    const res: any = await fork($)
    await h.step($, 'claude-sonnet-5-5', res.agentId)
    await h.complete($, 'claude-sonnet-5-5', res.agentId, 'Cause: the alias drops in parser.go. Plan: fix parser.go.')
    const run = of(h.writes, 'fork-run')[0]
    expect(run).toMatchObject({ agentId: res.agentId, planFiles: 1, firstCacheRead: 29500 })
    expect(JSON.stringify(await fail($))).toContain('automode:architect')
    expect(of(h.writes, 'consult-outcome')[0]).toMatchObject({ via: 'fork', outcome: 'recurred', influence: 'followed' })
    expect(JSON.stringify(await fail($))).toContain('escalated to T3 (opus high)')
    expect(of(h.writes, 'escalation').map((x) => x.action)).toEqual(['raise', 'fork-diagnose', 'consult-opus', 'switch'])
  })

  test('off (the code default): no fork rung', async ($, on) => {
    const h = harness(on, sonnetAt('high'))
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await fail($)
    expect(JSON.stringify(await fail($))).toContain('automode:architect')
  })
})

describe('Failed stops climb the ladder', () => {
  const chain = { completionGate: 'block', strongStep: 'effort-first', consult: 'priced', forkRung: 'on' }

  test('a failed stop after new work is a rung, carried in the block, and the rescue reaches the switch', async ($, on) => {
    const h = harness(on, sonnetAt('high', chain))
    h.setPrefix(400_000)
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    // A Bash edit, then one failing run: no repeat, so the ladder has not acted yet.
    await $.tool.call({ tool: 'Bash', command: "sed -i '' 's/a/b/' parser.go" })
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    expect(of(h.writes, 'escalation')).toEqual([])
    // Each rung follows work. A stop with no edit since the last rung contests the failure and stands.
    const redo = () => $.tool.call({ tool: 'Bash', command: "sed -i '' 's/b/c/' parser.go && go test ./..." })
    const first = await $.classic.Stop({ stop_hook_active: false })
    expect(first.block).toContain('Effort rises first')
    expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()
    const blocks: string[] = []
    for (let i = 0; i < 4; i++) { await redo(); blocks.push(String((await $.classic.Stop({ stop_hook_active: true })).block ?? '')) }
    expect(blocks.join('\n')).toContain('automode:architect')
    expect(of(h.writes, 'escalation').map((x) => x.action).at(-1)).toBe('switch')
    expect(of(h.writes, 'completion').filter((c) => c.contested).length).toBe(1)
  })

  test('the code-default gate (report) never blocks, so a failed stop stays a record', async ($, on) => {
    const h = harness(on, sonnetAt('high'))
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: "sed -i '' 's/a/b/' parser.go" })
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
    expect(of(h.writes, 'escalation')).toEqual([])
  })
})

describe('A failed stop joins the failing check', () => {
  test('the stop climbs the failing check\'s own episode: no rung twice', async ($, on) => {
    const h = harness(on, { ...sonnetAt('high', { completionGate: 'block', strongStep: 'effort-first', consult: 'priced', forkRung: 'on' }) })
    h.setPrefix(400_000)
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await fail($) // weak: effort
    await fail($) // strong: the episode's one effort raise
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toContain('subagent_type "fork"')
    // No edit since that rung: the stop stands, and the episode keeps its one fork.
    expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()
    const esc = of(h.writes, 'escalation')
    expect(esc.map((x) => x.action)).toEqual(['raise', 'raise', 'fork-diagnose'])
    expect(new Set(esc.map((x) => x.episode)).size).toBe(1)
  })
})

describe('Haiku first, escalate on evidence', () => {
  const haiku = { policy: 'auto', config: { opusStart: 'evidence', reachHaiku: true }, judge: judge({ tier: 'T1', complexity: 'standard' }), effortJudge: perModel({ sonnet: ['sonnet', 'medium'], haiku: ['haiku', 'medium'], opus: ['opus', 'medium'] }) }

  test('repeated failures keep Haiku working; a stop with the check failing is sent back and moves it to Sonnet, with no extra review', async ($, on) => {
    const h = harness(on, haiku)
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    expect(h.steps.at(-1)?.model).toBe('claude-haiku-5-5')
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await fail($)
    await fail($)
    await fail($)
    expect(of(h.writes, 'escalation').filter((x) => x.action !== 'none')).toEqual([])
    const stop = await $.classic.Stop({ stop_hook_active: false })
    expect(stop.block).toContain('escalated to')
    expect(stop.block).toContain('sonnet')
    expect(of(h.writes, 'escalation').filter((x) => x.action !== 'none').map((x) => [x.action, x.because])).toEqual([['switch', 'the session tried to stop with its last check failing']])
    const next = await h.submit($, 'keep going')
    expect(next.context.join('\n')).not.toContain('Independent review required')
  })

  test('a stop with no edit since the last rung contests the failure: the stop stands and no rung is bought', async ($, on) => {
    // Found live: dnspython stopped three times in 29 s with no edit, on a test that failed before any change, and each
    // stop bought a pricier rung: fork, Opus consult, Opus switch.
    const h = harness(on, haiku)
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Edit', file_path: 'parser.go', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await fail($)
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toContain('escalated to')
    const rungs = () => of(h.writes, 'escalation').filter((x) => x.action !== 'none').length
    const after = rungs()
    expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()
    expect(rungs()).toBe(after)
    // Work after the rung earns the next one.
    await fail($) // an edit, then the check fails again
    expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeDefined()
  })

  test('a review the model asks for on its own runs on Sonnet', async ($, on) => {
    const h = harness(on, haiku)
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.agent.spawn({ subagentType: 'automode:reviewer', prompt: 'review', description: 'review', parentModel: 'claude-haiku-5-5', fork: false, background: false, tool_use_id: 'r' } as never)
    expect(h.spawned.at(-1)).toEqual({ subagentType: 'automode:reviewer', model: 'sonnet' })
  })

  test('the old rule (opusStart judge): the first repeat on Haiku moves the model', async ($, on) => {
    const h = harness(on, { ...haiku, config: { reachHaiku: true } })
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await fail($)
    await fail($)
    expect(of(h.writes, 'escalation').some((x) => x.action === 'switch')).toBe(true)
  })
})

describe('v6 strategies', () => {
  const failing = { result: 'Error: Exit code 1\n--- FAIL: TestX (0.00s)\nFAIL', isError: true, text: '' }
  const v6 = (strategy: string, extra: Record<string, unknown> = {}) => ({ ...sonnetAt('high', { opusStart: 'evidence', strategy, ...extra }), bash: () => failing })
  const climb = async ($: any, h: any) => {
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await fail($)
    return fail($)
  }

  test('v6c: a large context gets a fresh same-model builder first, then one model up; the session never switches', async ($, on) => {
    const h = harness(on, v6('v6c'))
    h.setPrefix(150_000)
    const out: any = await climb($, h)
    const note = JSON.stringify(out.context ?? [])
    expect(note).toContain('subagent_type \\"automode:builder\\" and model \\"sonnet\\"')
    expect(note).toContain('git worktree add -q')
    expect(note).toContain('Implement the objective')
    expect(note).not.toContain('Return the cause, the fix plan')
    expect(of(h.writes, 'escalation').map((x) => x.action)).toEqual(['raise', 'recovery'])
    expect(of(h.writes, 'recovery').map((x) => x.action)).toEqual(['rescue-same'])
    expect(of(h.writes, 'rescue')[0]).toMatchObject({ family: 'sonnet', mode: 'restart', prefixTokens: 150_000 })
    // The same need again: the stronger builder, priced under a switch at 150k.
    await fail($)
    expect(of(h.writes, 'recovery').map((x) => x.action)).toEqual(['rescue-same', 'rescue-up'])
    expect(of(h.writes, 'rescue').map((x) => x.family)).toEqual(['sonnet', 'opus'])
    expect(of(h.writes, 'model-switch')).toEqual([])
  })

  test('v6c: a pin keeps the model: a fresh builder on it, never one model up', async ($, on) => {
    on('command.run', () => ({ text: 'ok' }))
    const h = harness(on, v6('v6c'))
    h.setPrefix(150_000)
    await h.submit($, 'fix the failing parser test')
    await $.command.run({ command: 'model', args: 'sonnet', origin: { kind: 'composer' } } as never)
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await fail($)
    await fail($)
    expect(of(h.writes, 'recovery').map((x) => x.action)).toEqual(['rescue-same'])
    await fail($)
    expect(of(h.writes, 'recovery').map((x) => x.action)).toEqual(['rescue-same', 'hold'])
    expect(of(h.writes, 'rescue').map((x) => x.family)).toEqual(['sonnet'])
  })

  test('v6a: the route holds instead of moving a large context', async ($, on) => {
    const held = harness(on, v6('v6a'))
    held.setPrefix(150_000)
    const out: any = await climb($, held)
    expect(JSON.stringify(out.context ?? [])).toContain('The route holds: moving a large context costs more than it saves')
    expect(of(held.writes, 'recovery').map((x) => x.action)).toEqual(['hold'])
  })

  test('v6c with a small context switches as before: the rebuild costs cents', async ($, on) => {
    const h = harness(on, v6('v6c'))
    h.setPrefix(10_000)
    await climb($, h)
    expect(of(h.writes, 'escalation').map((x) => x.action)).toEqual(['raise', 'switch'])
    expect(of(h.writes, 'rescue')).toEqual([])
  })

  test('recovery rescue under the legacy start (E1): the start is unchanged, the switch becomes a builder', async ($, on) => {
    const h = harness(on, { ...sonnetAt('high', { opusStart: 'evidence', recovery: 'rescue' }), bash: () => failing })
    h.setPrefix(150_000)
    await climb($, h)
    expect(of(h.writes, 'recovery').map((x) => x.action)).toEqual(['rescue-same'])
  })

  test('watchdog: failing checks and context growth with no pass recover early, long before the 150k limit', async ($, on) => {
    const h = harness(on, v6('v6c'))
    h.setPrefix(40_000)
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call(edit())
    h.setPrefix(85_000)
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await $.tool.call(edit())
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    const rec = of(h.writes, 'recovery').find((x) => x.source === 'watchdog')
    expect(rec).toMatchObject({ action: 'rescue-same' })
    expect(of(h.writes, 'rescue')[0].prefixTokens).toBeLessThan(150_000)
  })

  test('a correction the person gave mid-task reaches the rescue brief', async ($, on) => {
    const h = harness(on, { ...v6('v6c'), judge: judge({ tier: 'T2', complexity: 'standard', newTask: false }) })
    h.setPrefix(150_000)
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await h.submit($, 'keep the old flag name --legacy-mode')
    await h.step($)
    const out: any = await (async () => { await $.tool.call({ tool: 'Bash', command: 'go test ./...' }); await fail($); return fail($) })()
    expect(JSON.stringify(out.context ?? [])).toContain('--legacy-mode')
  })

  test('v6b: an unverified stop is not a capability failure: no recovery, no model change', async ($, on) => {
    const h = harness(on, { ...sonnetAt('high', { opusStart: 'evidence', strategy: 'v6b', completionGate: 'block' }), bash: () => ({ result: 'ok', isError: false, text: '' }) })
    await h.submit($, 'fix the parser')
    await h.step($)
    await $.tool.call(edit())
    await $.classic.Stop({ stop_hook_active: false })
    expect(of(h.writes, 'recovery')).toEqual([])
    expect(of(h.writes, 'escalation')).toEqual([])
  })

  test('v6: Haiku past its price step is priced and stays; an effort change records what the cache kept', async ($, on) => {
    const h = harness(on, { policy: 'auto', config: { opusStart: 'evidence', strategy: 'v6b' }, judge: judge({ tier: 'T0', complexity: 'trivial' }), effortJudge: perModel({ haiku: ['haiku', 'medium'], sonnet: ['sonnet', 'medium'] }) })
    h.setPrefix(120_000)
    await h.submit($, 'what does the --dry-run flag do')
    await h.step($, 'claude-haiku-5-5')
    await h.step($, 'claude-haiku-5-5', undefined, { index: 1 })
    expect(of(h.writes, 'price-step')[0]).toMatchObject({ crossed: true, verdict: 'stay' })
    expect(of(h.writes, 'recovery')).toEqual([])
  })

  test('v6b: an effort raise on the same model records what the next request read from cache', async ($, on) => {
    const h = harness(on, { ...sonnetAt('medium', { opusStart: 'evidence', strategy: 'v6b' }), bash: () => failing })
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await fail($)
    await fail($)
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 1 })
    const ec = of(h.writes, 'effort-cache')
    expect(ec.length).toBeGreaterThan(0)
    expect(ec[0]).toMatchObject({ family: 'sonnet', from: 'medium' })
    expect(ec[0].cacheRead).toBeGreaterThan(0)
  })

  const crit = { policy: 'auto', judge: judge({ tier: 'T2', complexity: 'standard', risk: 'critical', riskWhy: 'auth path' }), effortJudge: perModel({ sonnet: ['sonnet', 'high'], opus: ['opus', 'medium'] }) }

  test('legacy: a judge\'s critical rating asks for a review', async ($, on) => {
    const h = harness(on, { ...crit, config: { opusStart: 'evidence' } })
    expect((await h.submit($, 'change the login token check')).context.join('\n')).toContain('automode:reviewer')
  })

  test('v6: a judge\'s critical rating alone asks for no review; builder on hands the work to one builder', async ($, on) => {
    const h = harness(on, { ...crit, config: { opusStart: 'evidence', strategy: 'v6b', builder: 'on' } })
    const ctx = (await h.submit($, 'change the login token check')).context.join('\n')
    expect(ctx).not.toContain('automode:reviewer')
    expect(ctx).toContain('subagent_type "automode:builder"')
  })
})

describe('a session launched on Opus, the way most people run Claude Code', () => {
  test('is no pin: AutoMode routes a quick question to Haiku and a hard task off Opus', async ($, on) => {
    let n = 0
    // The shipped config.json activates AutoMode with the session (activation: always), whatever model it starts on.
    const h = harness(on, { policy: 'auto', model: 'claude-opus-5-5', config: { activation: 'always', opusStart: 'evidence', strategy: 'v6c' }, judge: () => judge(n++ === 0 ? { tier: 'T0', complexity: 'trivial' } : { tier: 'T3', complexity: 'complex', newTask: true }), effortJudge: perModel({ haiku: ['haiku', 'medium'], sonnet: ['sonnet', 'high'], opus: ['opus', 'high'] }) })
    await h.submit($, 'where is the code span tokenizer defined?')
    await h.step($, 'claude-opus-5-5')
    expect(h.steps.at(-1)?.model).toBe('claude-haiku-5-5')
    await h.submit($, 'rework how list tokens are built from the lexer')
    await h.step($, 'claude-opus-5-5', undefined, { index: 1 })
    expect(h.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
  })


})
