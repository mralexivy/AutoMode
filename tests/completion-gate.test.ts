// The completion gate end to end in the mocked engine: evidence from real Bash output, the Stop block, one block per
// task, and a contradiction reaching the escalation ladder. The rules themselves are in tests/completion.test.mts.
import { describe, expect, test } from 'claude-code/testing'
import { harness, judge, records } from './harness.ts'

const PROMPT = 'Fix parse so parse("a(") must return ok(a).'
const CHECK = `python -c 'print(parse("a("))'`
const gate = (completionGate: string, o: Record<string, unknown> = {}) => ({ policy: 'auto', config: { completionGate }, bash: (c: string) => (c.startsWith('python') ? { result: 'ok(a)', isError: false, text: '' } : { result: 'all passed', isError: false, text: '' }), ...o })
const wrong = (c: string) => (c.startsWith('python') ? { result: 'bad(a)', isError: false, text: '' } : { result: 'all passed', isError: false, text: '' })
const completions = (w: Record<string, string>) => records(w).filter((x) => x.kind === 'completion')
const edit = ($: any) => $.tool.call({ tool: 'Edit', file_path: 'parse.py', old_string: 'a', new_string: 'b' })

describe('Completion gate', () => {
  test('a stated result with wrong output and exit 0 is failed, and the model goes back once', async ($, on) => {
    const h = harness(on, gate('block', { bash: wrong }))
    await h.submit($, PROMPT)
    await h.step($)
    await edit($)
    await $.tool.call({ tool: 'Bash', command: 'pytest' })
    await $.tool.call({ tool: 'Bash', command: CHECK })
    const first = await $.classic.Stop({ stop_hook_active: false })
    expect(first.block).toContain('work is failed')
    expect(first.block).toContain('ok(a)')
    expect((await $.classic.Stop({ stop_hook_active: true })).block).toBeUndefined()
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
    expect(completions(h.writes).map((c) => [c.state, c.blocked])).toEqual([['failed', true], ['failed', false], ['failed', false]])
  })

  test('a passing check alone does not pass a stated result', async ($, on) => {
    const h = harness(on, gate('block'))
    await h.submit($, PROMPT)
    await h.step($)
    await edit($)
    await $.tool.call({ tool: 'Bash', command: 'pytest' })
    const res = await $.classic.Stop({ stop_hook_active: false })
    expect(res.block).toContain('parse("a(")')
    expect(completions(h.writes)[0].state).toBe('partially_verified')
  })

  test('real output and a check after the last edit verify the work', async ($, on) => {
    const h = harness(on, gate('block'))
    await h.submit($, PROMPT)
    await h.step($)
    await edit($)
    await $.tool.call({ tool: 'Bash', command: CHECK })
    await $.tool.call({ tool: 'Bash', command: 'pytest' })
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
    expect(completions(h.writes)[0].state).toBe('verified')
  })

  test('an edit after the evidence reopens it', async ($, on) => {
    const h = harness(on, gate('block'))
    await h.submit($, PROMPT)
    await h.step($)
    await edit($)
    await $.tool.call({ tool: 'Bash', command: CHECK })
    await $.tool.call({ tool: 'Bash', command: 'pytest' })
    await edit($)
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toContain('unverified')
  })

  test('a task with no edits is not gated', async ($, on) => {
    const h = harness(on, gate('block'))
    await h.submit($, 'explain how parse("a(") must return ok(a)')
    await h.step($)
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
    expect(completions(h.writes)).toEqual([])
  })

  test('report records the state and never blocks', async ($, on) => {
    const h = harness(on, gate('report', { bash: wrong }))
    await h.submit($, PROMPT)
    await h.step($)
    await edit($)
    await $.tool.call({ tool: 'Bash', command: CHECK })
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
    expect(completions(h.writes)[0]).toMatchObject({ state: 'failed', blocked: false })
  })

  test('off records nothing', async ($, on) => {
    const h = harness(on, gate('off'))
    await h.submit($, PROMPT)
    await h.step($)
    await edit($)
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeUndefined()
    expect(completions(h.writes)).toEqual([])
  })

  test('background work is not held up', async ($, on) => {
    const h = harness(on, gate('block'))
    await h.submit($, PROMPT)
    await h.step($)
    await edit($)
    const res = await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 't', type: 'bash', status: 'running', description: 'x' }] } as any)
    expect(res.block).toBeUndefined()
  })

  test('a new task gets its own block', async ($, on) => {
    const h = harness(on, gate('block', { judge: judge({ newTask: true }) }))
    await h.submit($, PROMPT)
    await h.step($)
    await edit($)
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toBeTruthy()
    await h.submit($, 'A different job: make render("b(") must return ok(b).')
    await h.step($)
    await edit($)
    expect((await $.classic.Stop({ stop_hook_active: false })).block).toContain('render("b(")')
  })

  test('a repeated contradiction after an edit raises the effort', async ($, on) => {
    const h = harness(on, gate('block', { bash: wrong, judge: judge({ newTask: false }) }))
    await h.submit($, PROMPT)
    await h.step($)
    const before = h.steps[0].effort
    const run = { tool: 'Bash', command: CHECK }
    await edit($)
    await $.tool.call(run)
    await edit($)
    await $.tool.call(run)
    await h.step($)
    expect(before).toBe('medium')
    expect(h.steps[1].effort).toBe('high')
  })

  test('a record holds no text from the request', async ($, on) => {
    const h = harness(on, gate('block'))
    await h.submit($, PROMPT)
    await h.step($)
    await edit($)
    await $.classic.Stop({ stop_hook_active: false })
    expect(JSON.stringify(completions(h.writes))).not.toContain('ok(a)')
  })
})
