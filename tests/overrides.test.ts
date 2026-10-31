// The person's own choices and the escalation ladder, end to end in the mocked engine (policy auto). The app's model and
// effort stay what the app asks for: a rewrite this mod sends changes the request, never the app's value.
import { describe, expect, test } from 'claude-code/testing'
import { harness, judge, perModel, records } from './harness.ts'

const auto = (o: Record<string, unknown> = {}) => ({ policy: 'auto', ...o })
const easy = judge({ tier: 'T1' })
const sonnetMedium = perModel({ sonnet: ['sonnet', 'medium'], opus: ['sonnet', 'medium'], haiku: ['sonnet', 'medium'] })
const opusHigh = perModel({ opus: ['opus', 'high'], sonnet: ['opus', 'high'] })
const pins = (w: Record<string, string>) => records(w).filter((x) => x.kind === 'pin')
const escalations = (w: Record<string, string>) => records(w).filter((x) => x.kind === 'escalation')
const FABLE = 'claude-fable-5-5'
const failing = { result: 'Error: Exit code 1\n--- FAIL: TestX (0.00s)\n    x_test.go:9: got 1 want 2\nFAIL', isError: true, text: '' }
const person = { origin: { kind: 'composer' } }
const edit = (path = 'parser.go', o: Record<string, unknown> = {}) => ({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b', ...o })

describe('Pins', () => {
  test('/model of the model the route already runs is a pin: the echo guard is gone', async ($, on) => {
    let n = 0
    const h = harness(on, auto({ judge: () => judge(n++ === 0 ? { tier: 'T3', complexity: 'complex' } : { tier: 'T1', newTask: true }), effortJudge: (p: string) => (n > 1 ? sonnetMedium(p) : opusHigh(p)) }))
    await h.submit($, 'design the cache layer')
    await h.step($)
    expect(h.steps[0].model).toBe('claude-opus-5-5')
    await h.complete($, 'claude-opus-5-5')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' }) // the person picked Opus: the app's value moved
    await h.complete($, 'claude-opus-5-5', undefined, 'done', { turnId: 't2' })
    await h.submit($, 'rename the flag')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't3' })
    expect(h.steps.at(-1)?.model).toBe('claude-opus-5-5')
    const pin = pins(h.writes).find((x) => x.action === 'pinned')
    expect(pin).toMatchObject({ axis: 'model', via: 'request', echo: true })
    expect(h.toasts.join(' ')).toContain('you chose opus')
  })

  test('/effort of the effort the route already runs is a pin', async ($, on) => {
    const h = harness(on, auto({ judge: easy, effortJudge: perModel({ sonnet: ['sonnet', 'high'] }) }))
    await h.submit($, 'add a flag to the importer')
    await h.step($)
    expect(h.steps[0].effort).toBe('high')
    await h.complete($)
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2', effort: 'high' })
    await h.complete($, 'claude-sonnet-5-5', undefined, 'done', { turnId: 't2' })
    expect(pins(h.writes).find((x) => x.action === 'pinned')).toMatchObject({ axis: 'effort', echo: true })
  })

  test('an am: command beats a pin for its turn, then the pin stands again', async ($, on) => {
    const h = harness(on, auto({ judge: easy, effortJudge: sonnetMedium }))
    await h.submit($, 'add a flag to the importer')
    await h.step($)
    await h.complete($)
    await h.submit($, 'add a second flag')
    await h.step($, 'claude-haiku-5-5', undefined, { turnId: 't2' }) // /model haiku
    await h.complete($, 'claude-haiku-5-5', undefined, 'done', { turnId: 't2' })
    await h.submit($, 'am:opus check the design')
    await h.step($, 'claude-haiku-5-5', undefined, { turnId: 't3' })
    expect(h.steps.at(-1)?.model).toBe('claude-opus-5-5')
    await h.complete($, 'claude-haiku-5-5', undefined, 'done', { turnId: 't3' })
    await h.submit($, 'add a third flag')
    await h.step($, 'claude-haiku-5-5', undefined, { turnId: 't4' })
    expect(h.steps.at(-1)?.model).toBe('claude-haiku-5-5')
  })

  test('an unknown or Fable app model passes through unrewritten and turns routing off', async ($, on) => {
    const h = harness(on, auto({ judge: easy, effortJudge: sonnetMedium }))
    await h.submit($, 'add a flag to the importer')
    await h.step($, FABLE, undefined, { effort: 'low' })
    expect(h.steps[0]).toMatchObject({ model: FABLE, effort: 'low' })
    expect(pins(h.writes).at(-1)).toMatchObject({ action: 'unroutable', axis: 'model' })
    expect(h.toasts.join(' ')).toContain('routing is off')
    await h.complete($, FABLE)
    const judged = h.judged.length
    await h.submit($, 'add a second flag')
    await h.step($, FABLE, undefined, { turnId: 't2', effort: 'low' })
    expect(h.steps.at(-1)).toMatchObject({ model: FABLE, effort: 'low' })
    expect(h.judged.length).toBe(judged) // no judge call while routing is off
    expect(records(h.writes).filter((x) => x.kind === 'request').every((x) => x.sent.model === FABLE)).toBe(true)
  })

  test('an am: command still gets its turn on an unroutable model; choosing a routed model turns routing back on', async ($, on) => {
    const h = harness(on, auto({ judge: easy, effortJudge: sonnetMedium }))
    await h.submit($, 'add a flag')
    await h.step($, FABLE)
    await h.complete($, FABLE)
    await h.submit($, 'am:opus review the design')
    await h.step($, FABLE, undefined, { turnId: 't2' })
    expect(h.steps.at(-1)?.model).toBe('claude-opus-5-5')
    await h.complete($, FABLE, undefined, 'done', { turnId: 't2' })
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't3' })
    await h.complete($, 'claude-sonnet-5-5', undefined, 'done', { turnId: 't3' })
    await h.submit($, 'add a second flag')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't4' })
    expect(pins(h.writes).some((x) => x.action === 'routable')).toBe(true)
    expect(h.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
  })

  test('a model change in plan mode and on the way out pins nothing, and says so in a record', async ($, on) => {
    const h = harness(on, auto({ judge: easy, effortJudge: sonnetMedium }))
    await h.submit($, 'add a flag')
    await h.step($)
    await h.complete($)
    await $.prompt.attachment({ type: 'plan_mode', text: 'plan mode', origin: { kind: 'engine' }, detail: { reminder: 'full' } })
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' }) // opusplan
    await h.complete($, 'claude-opus-5-5', undefined, 'done', { turnId: 't2' })
    await $.prompt.attachment({ type: 'plan_mode_exit', text: 'exit', origin: { kind: 'engine' }, detail: { hasPlan: true } })
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't3' })
    expect(pins(h.writes).filter((x) => x.action === 'pinned').length).toBe(0)
    expect(pins(h.writes).filter((x) => x.action === 'skipped').map((x) => x.why)).toEqual(['model: plan mode', 'model: plan mode'])
  })

  test('/model that equals the app value pins through command.run, which no request could show', async ($, on) => {
    on('command.run', () => ({ text: 'ok' }))
    let n = 0
    const h = harness(on, auto({ judge: () => judge(n++ === 0 ? { tier: 'T3', complexity: 'complex' } : { tier: 'T1', newTask: true }), effortJudge: (p: string) => (n > 1 ? sonnetMedium(p) : opusHigh(p)) }))
    await h.submit($, 'design the cache layer')
    await h.step($)
    expect(h.steps[0].model).toBe('claude-opus-5-5')
    await $.command.run({ command: 'model', args: 'sonnet', ...person })
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 1 })
    expect(h.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
    expect(pins(h.writes).at(-1)).toMatchObject({ action: 'pinned', via: 'command', to: 'sonnet' })
  })

  test('/effort through command.run pins, and auto hands it back with no pin from the app value that follows', async ($, on) => {
    on('command.run', () => ({ text: 'ok' }))
    const h = harness(on, auto({ judge: easy, effortJudge: sonnetMedium }))
    await h.submit($, 'add a flag')
    await h.step($)
    await $.command.run({ command: 'effort', args: 'medium', ...person })
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 1 })
    expect(pins(h.writes).at(-1)).toMatchObject({ action: 'pinned', axis: 'effort', to: 'medium' })
    await $.command.run({ command: 'effort', args: 'auto', ...person })
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 2, effort: 'high' })
    expect(pins(h.writes).at(-1)).toMatchObject({ action: 'released', axis: 'effort' })
  })

  test('an effort pin applies to helpers, with no judge call', async ($, on) => {
    const h = harness(on, auto({ judge: easy, effortJudge: sonnetMedium }))
    await h.submit($, 'add a flag')
    await h.step($)
    await h.complete($)
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2', effort: 'low' }) // /effort low
    const res: any = await $.agent.spawn({ subagentType: 'Explore', prompt: 'find the flag', description: 'find', parentModel: 'claude-sonnet-5-5', fork: false, background: false, tool_use_id: 'z' } as never)
    await h.step($, 'claude-haiku-5-5', res.agentId)
    expect(h.steps.at(-1)).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' })
    expect(records(h.writes).some((x) => x.kind === 'model-call' && x.purpose === 'effortless-helper')).toBe(false)
  })

  test('an escalation a pin undoes claims no move', async ($, on) => {
    const h = harness(on, auto({ judge: easy, effortJudge: perModel({ sonnet: ['sonnet', 'medium'] }) }))
    await h.submit($, 'fix the parser')
    await h.step($)
    await h.complete($)
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2', effort: 'low' }) // /effort low
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await $.tool.call(edit())
    const out = await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    expect(JSON.stringify(out)).not.toContain('escalated')
    expect(JSON.stringify(out)).toContain('the route stays')
    expect(h.toasts.join(' ')).not.toContain('Moving to')
    expect(escalations(h.writes).at(-1)).toMatchObject({ action: 'held-by-pin', level: 'weak' })
  })
})

describe('The ladder', () => {
  const sonnetAt = (effort: string) => auto({ judge: judge({ tier: 'T2', complexity: 'standard' }), effortJudge: perModel({ sonnet: ['sonnet', effort], opus: ['opus', 'high'] }) })
  const fail = async ($: any) => { await $.tool.call(edit()); return $.tool.call({ tool: 'Bash', command: 'go test ./...' }) }

  test('Sonnet high: effort to xhigh, then the Opus consult, then the model, whatever the prefix size', async ($, on) => {
    const h = harness(on, sonnetAt('high'))
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    const weak = await fail($)
    expect(JSON.stringify(weak)).toContain('escalated to T2 (sonnet xhigh)')
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 1 })
    expect(h.steps.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'xhigh' })
    const strong = await fail($)
    expect(JSON.stringify(strong)).toContain('automode:architect')
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 2 })
    expect(h.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
    const again = await fail($)
    expect(JSON.stringify(again)).toContain('escalated to T3 (opus high)')
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 3 })
    expect(h.steps.at(-1)?.model).toBe('claude-opus-5-5')
    expect(escalations(h.writes).map((x) => [x.level, x.action])).toEqual([['weak', 'raise'], ['strong', 'consult-opus'], ['strong', 'switch']])
  })

  test('a floor from the ladder holds on the next prompt and ends with its own check', async ($, on) => {
    let fixed = false
    const h = harness(on, { ...sonnetAt('medium'), judge: judge({ tier: 'T1', newTask: false }), bash: () => (fixed ? { result: 'ok', isError: false, text: '' } : failing) })
    await h.submit($, 'fix the parser')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await fail($)
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 1 })
    expect(h.steps.at(-1)?.effort).toBe('high')
    await h.complete($)
    await h.submit($, 'try the other parser path')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    expect(h.steps.at(-1)?.effort).toBe('high')
    expect(escalations(h.writes).length).toBe(1) // the floor holds, and no second raise on its own
    fixed = true
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await h.complete($, 'claude-sonnet-5-5', undefined, 'done', { turnId: 't2' })
    await h.submit($, 'tidy the parser path')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't3' })
    expect(h.steps.at(-1)?.effort).toBe('medium')
  })

  test('a failure right after an escalation is not read as a repair: the edit flag clears', async ($, on) => {
    const h = harness(on, sonnetAt('high'))
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await fail($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' }) // a rerun, no edit
    expect(escalations(h.writes).length).toBe(1)
  })

  test('a check that passed and now fails is strong on its first failure', async ($, on) => {
    let broken = false
    const h = harness(on, { ...sonnetAt('high'), bash: () => (broken ? failing : { result: 'ok', isError: false, text: '' }) })
    await h.submit($, 'fix the parser')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    broken = true
    const out = await fail($)
    expect(JSON.stringify(out)).toContain('automode:architect')
    expect(escalations(h.writes)[0]).toMatchObject({ level: 'strong', action: 'consult-opus' })
  })

  test('three tool errors in a row raise the effort once; a success resets the count', async ($, on) => {
    let errors = true
    const h = harness(on, { ...sonnetAt('medium'), tools: { Grep: () => (errors ? { result: 'no', isError: true, text: '' } : { result: 'ok', text: '' }) } })
    await h.submit($, 'fix the parser')
    await h.step($)
    await $.tool.call({ tool: 'Grep', pattern: 'a' })
    await $.tool.call({ tool: 'Grep', pattern: 'a' })
    errors = false
    await $.tool.call({ tool: 'Grep', pattern: 'a' })
    errors = true
    await $.tool.call({ tool: 'Grep', pattern: 'a' })
    await $.tool.call({ tool: 'Grep', pattern: 'a' })
    expect(escalations(h.writes).length).toBe(0)
    const third: any = await $.tool.call({ tool: 'Grep', pattern: 'a' })
    expect(JSON.stringify(third.context)).toContain('escalated to T2 (sonnet high)')
    expect(JSON.stringify(third.context)).not.toContain('review')
    expect(escalations(h.writes)[0]).toMatchObject({ level: 'weak', action: 'raise' })
  })

  test('a revert of the task work is strong', async ($, on) => {
    const h = harness(on, { ...sonnetAt('high'), bash: () => ({ result: 'ok', isError: false, text: '' }) })
    await h.submit($, 'fix the parser')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
    expect(escalations(h.writes).length).toBe(0) // nothing of the task's to revert yet
    await $.tool.call(edit())
    const out = await $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
    expect(JSON.stringify(out)).toContain('automode:architect')
  })

  test('a reviewer blocker is strong, and its note reaches the next main tool result', async ($, on) => {
    const h = harness(on, { ...sonnetAt('high'), bash: () => ({ result: 'ok', isError: false, text: '' }) })
    await h.submit($, 'fix the parser')
    await h.step($)
    const res: any = await $.agent.spawn({ subagentType: 'automode:reviewer', prompt: 'review', description: 'review', parentModel: 'claude-sonnet-5-5', fork: false, background: false, tool_use_id: 'z' } as never)
    await h.complete($, 'claude-opus-5-5', res.agentId, 'Verdict: changes_required\nblocker a.go:1')
    expect(escalations(h.writes)[0]).toMatchObject({ level: 'strong', action: 'consult-opus' })
    const out = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(JSON.stringify(out)).toContain('automode:architect')
    const later = await $.tool.call({ tool: 'Bash', command: 'ls' })
    expect(JSON.stringify(later)).not.toContain('automode:architect')
  })

  test('a subagent edit and a subagent check count in the task, and the note waits for the main session', async ($, on) => {
    const h = harness(on, { ...sonnetAt('medium') })
    await h.submit($, 'fix the parser')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...', agentId: 'sub1' })
    await $.tool.call(edit('src/auth/login.go', { agentId: 'sub1' }))
    const seen = await $.tool.call({ tool: 'Bash', command: 'go test ./...', agentId: 'sub1' })
    expect(JSON.stringify(seen)).not.toContain('escalated')
    expect(escalations(h.writes)[0]).toMatchObject({ level: 'weak' })
    const main = await $.tool.call({ tool: 'Read', file_path: 'a.go' })
    expect(JSON.stringify(main)).toContain('escalated')
    await h.complete($)
    await h.submit($, 'continue')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    const last = records(h.writes).filter((x) => x.kind === 'decision').at(-1)
    expect(last.risk.reviewRequired).toBe(true) // a subagent's edit of an auth path counts as hard evidence
  })

  test('wrapped checks count: a failing `timeout 60 go test` repeats like a plain one', async ($, on) => {
    const h = harness(on, sonnetAt('medium'))
    await h.submit($, 'fix the parser')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'timeout 60 go test ./...' })
    await $.tool.call(edit())
    const out = await $.tool.call({ tool: 'Bash', command: 'timeout 60 go test ./...' })
    expect(JSON.stringify(out)).toContain('escalated')
  })
})

describe('Consequence controls', () => {
  test('judge-only critical gets a Sonnet reviewer and keeps its routing floor', async ($, on) => {
    const h = harness(on, auto({ judge: judge({ tier: 'T1', risk: 'critical', riskWhy: 'looks risky' }), effortJudge: sonnetMedium }))
    const out = await h.submit($, 'rename a helper in the importer')
    expect(out.context.join('\n')).toContain('"automode:reviewer" (Sonnet, read-only)')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' }) // the Sonnet high minimum stays
    const res: any = await $.agent.spawn({ subagentType: 'automode:reviewer', prompt: 'review', description: 'review', parentModel: 'claude-sonnet-5-5', fork: false, background: false, tool_use_id: 'z' } as never)
    expect(res.agentId).toBeTruthy()
    expect(h.spawned.at(-1)).toMatchObject({ subagentType: 'automode:reviewer', model: 'sonnet' })
  })

  test('hard evidence moves the review to Opus: an edited path after a judge-only verdict', async ($, on) => {
    const h = harness(on, auto({ judge: judge({ tier: 'T1', risk: 'critical', riskWhy: 'looks risky' }), effortJudge: sonnetMedium }))
    await h.submit($, 'rename a helper in the importer')
    await h.step($)
    const review = () => $.agent.spawn({ subagentType: 'automode:reviewer', prompt: 'review', description: 'review', parentModel: 'claude-sonnet-5-5', fork: false, background: false, tool_use_id: 'z' } as never)
    await review()
    expect(h.spawned.at(-1)?.model).toBe('sonnet')
    await $.tool.call(edit('db/migrations/0004.sql'))
    await review()
    expect(h.spawned.at(-1)?.model).toBeUndefined() // the agent's own model: Opus
  })

  test('text alone buys no review; a Bash operation is hard evidence that does', async ($, on) => {
    const h = harness(on, auto({ judge: easy, effortJudge: sonnetMedium, bash: () => ({ result: 'ok', isError: false, text: '' }) }))
    const out = await h.submit($, 'add roles to the footer')
    expect(out.context.join('\n')).not.toContain('automode:reviewer')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'git push --force origin main' })
    await h.complete($)
    await h.submit($, 'continue')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    const last = records(h.writes).filter((x) => x.kind === 'decision').at(-1)
    expect(last.risk.reviewRequired).toBe(true)
  })
})

describe('The Bash guard fails closed', () => {
  test('a guard that throws before the call denies it', async ($, on) => {
    let broken = false
    const h = harness(on, auto({ judge: easy, effortJudge: sonnetMedium, agentList: () => (broken ? null : []) })) // the guard reads this list first
    await h.submit($, 'add a flag')
    broken = true
    const out: any = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'sub1' })
    expect(out.deny).toContain('guard failed')
    expect(h.toolsRun).not.toContain('Bash')
  })
})
