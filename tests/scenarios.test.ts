// Scenarios A-F from the production-hardening plan, as golden traces: each one drives the router through
// mocked engine events and checks the decision and request records it writes. These prove the policy
// and its wiring; they do not prove live API behavior (docs/automode-v4-release.md lists what does).
import { describe, expect, test } from 'claude-code/testing'
import { __reset } from '../hooks/v4.ts'
import { harness, judge, records, says } from './harness.ts'

const HOUR = 3_600_000
const main = (r: any[]) => r.filter((x) => x.kind === 'request' && !x.agentId)
const decisions = (r: any[]) => r.filter((x) => x.kind === 'decision')

describe('Scenarios A-F', () => {
  test('A dynamic effort: Sonnet medium, then high, then medium, in the sent requests', async ($, on) => {
    let n = 0
    const verdicts = [{ tier: 'T1' }, { tier: 'T2', newTask: false }, { tier: 'T1', newTask: false }]
    const h = harness(on, { policy: 'legacy', judge: () => judge({ ...verdicts[Math.min(n++, 2)], confidence: 0.95 }) })
    for (const [i, text] of ['add a --dry-run flag', 'the cleanup test fails only in CI, find out why', 'now rename the flag'].entries()) {
      await h.submit($, text)
      await h.step($, 'claude-sonnet-5-5', undefined, { turnId: `t${i}` })
      await h.complete($)
    }
    const sent = main(records(h.writes)).map((r) => `${r.sent.model}/${r.sent.effort}`)
    expect(sent).toEqual(['claude-sonnet-5-5/medium', 'claude-sonnet-5-5/high', 'claude-sonnet-5-5/medium'])
    expect(main(records(h.writes)).every((r) => r.app.effort === 'medium')).toBe(true) // the app asked for medium every time
  })

  test('A2 dynamic effort on Opus: Opus medium, then Opus xhigh, same model, no rewrite of the model', async ($, on) => {
    let n = 0
    const h = harness(on, { policy: 'legacy', judge: () => judge(n++ === 0 ? { tier: 'T3', complexity: 'standard', newTask: true } : { tier: 'T3', complexity: 'complex', newTask: false, confidence: 0.95 }) })
    await h.submit($, 'use opus with medium effort: outline the cache layer')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 'o1' })
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'now design the failure handling for it in depth')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 'o2' })
    await h.complete($, 'claude-opus-5-5')
    const sent = main(records(h.writes)).map((r) => `${r.sent.model}/${r.sent.effort}`)
    expect(sent[0]).toBe('claude-opus-5-5/medium')
    expect(sent[1].startsWith('claude-opus-5-5/')).toBe(true)
    expect(sent[1]).not.toBe('claude-opus-5-5/medium')
    expect(decisions(records(h.writes))[1].effective.check.reason).toBe('effort change on the same model')
  })

  test('B escalation: Sonnet high to Opus high after a repeated defect, the Opus consult already used', async ($, on) => {
    const h = harness(on, { policy: 'legacy', judge: judge({ tier: 'T2', complexity: 'standard' }) })
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await $.tool.call({ tool: 'Edit', file_path: 'parser.go', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' }) // consult
    await $.tool.call({ tool: 'Edit', file_path: 'parser.go', old_string: 'b', new_string: 'c' })
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' }) // switch
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 1 })
    await h.complete($)
    const r = records(h.writes)
    expect(r.filter((x) => x.kind === 'escalation').map((x) => x.via)).toEqual(['architect', 'switch'])
    expect(main(r).map((x) => `${x.sent.model}/${x.sent.effort}`)).toEqual(['claude-sonnet-5-5/high', 'claude-opus-5-5/high'])
    expect(main(r)[1].owner).toBe('quality-escalation')
  })

  test('C economic downgrade: a new task on a cold Opus cache goes to Sonnet, and the rewrite is cheaper than staying', async ($, on) => {
    let n = 0
    const h = harness(on, { judge: () => judge(n++ === 0 ? { tier: 'T3', complexity: 'complex' } : { tier: 'T1', complexity: 'standard', newTask: true, confidence: 0.95 }) })
    h.setPrefix(60_000)
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.clock.advance(2 * HOUR)
    await h.submit($, 'add a --verbose flag to the usage command')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    await h.complete($)
    const d = decisions(records(h.writes))[1]
    expect(d.effective.model).toBe('claude-sonnet-5-5')
    expect(d.effective.check).toMatchObject({ verdict: 'switch', lowPenaltyPoint: true })
    expect(d.effective.check.economics.writePenaltyUsd).toBe(-0.24)
    expect(main(records(h.writes))[1].sent.model).toBe('claude-sonnet-5-5')
  })

  test('D cache-aware hold: a cheaper route is held on a warm 60k Opus cache because the rewrite does not pay back', async ($, on) => {
    let n = 0
    const h = harness(on, { policy: 'legacy', judge: () => judge(n++ === 0 ? { tier: 'T3', complexity: 'complex' } : { tier: 'T1', complexity: 'standard', newTask: true, confidence: 0.95 }) })
    h.setPrefix(60_000)
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.clock.advance(60_000)
    await h.submit($, 'add a --verbose flag to the usage command')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    await h.complete($)
    const d = decisions(records(h.writes))[1]
    expect(d.candidate.tier).toBe('T1') // the optimizer recommends Sonnet
    expect(d.effective.owner).toBe('cache-policy')
    expect(d.effective.model).toBe('claude-opus-5-5')
    expect(d.effective.check.gate).toBe('payback')
    const e = d.effective.check.economics
    expect(e.writePenaltyUsd).toBeGreaterThan(e.savingUsd.p25)
    expect(main(records(h.writes))[1].sent.model).toBe('claude-opus-5-5')
  })

  test('E targeted Opus consult: a repeated defect in a large warm Sonnet session asks the architect, the session stays', async ($, on) => {
    const h = harness(on, { policy: 'legacy', judge: judge({ tier: 'T2', complexity: 'standard' }) })
    h.setPrefix(150_000)
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await $.tool.call({ tool: 'Edit', file_path: 'parser.go', old_string: 'a', new_string: 'b' })
    const second = await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    expect(JSON.stringify(second)).toContain('automode:architect')
    expect(JSON.stringify(second)).toContain('Failing check (2 attempts)') // the evidence packet goes with it
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 1 })
    await h.complete($)
    const esc = records(h.writes).find((x) => x.kind === 'escalation')
    expect(esc.via).toBe('architect')
    expect(esc.estimate.consultUsd).toBeLessThan(esc.estimate.switchUsd)
    expect(main(records(h.writes)).map((x) => x.sent.model)).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5'])
  })

  test('F compaction: the route is re-evaluated on the smaller context, and the task envelope keeps review and criteria', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T2', complexity: 'standard', risk: 'critical', riskWhy: 'migration' }) })
    h.setPrefix(150_000)
    await h.submit($, 'write the data migration for users\n- must keep existing ids')
    await h.step($)
    await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: 'x', toolUses: [] }] })
    h.setPrefix(12_000)
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 1 })
    await h.complete($)
    const trig = decisions(records(h.writes)).find((x) => x.point === 'trigger')
    expect(trig.trigger.event).toBe('compacted')
    // Compaction is a partial reset (live L7: the next request still read 48,836 cached tokens): a switch
    // is priced on the surviving system-and-tools prefix, not treated as free.
    expect(trig.effective.check.lowPenaltyPoint).toBe(false)
    expect(trig.effective.check.economics.prefixTokens).toBeLessThan(150_000)
    const out = await h.submit($, 'continue')
    const state = out.context.join('\n')
    expect(state).toContain('[AutoMode task state]')
    expect(state).toContain('must keep existing ids')
    expect(state).toContain('automode:reviewer')
  })
})

describe('Escalation lifecycle and compaction detection', () => {
  test('consult, retry, same defect again: the main session moves to Opus, review becomes required, the consult is not repeated', async ($, on) => {
    const h = harness(on, { policy: 'legacy', judge: judge({ tier: 'T2', complexity: 'standard' }) })
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await $.tool.call({ tool: 'Edit', file_path: 'parser.go', old_string: 'a', new_string: 'b' })
    const consult = await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    expect(JSON.stringify(consult)).toContain('automode:architect')
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 1 })
    // A different check passes after the consult (found live, L5B): the consult still holds, no switch yet.
    await $.tool.call({ tool: 'Edit', file_path: 'other.go', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'go vet ./...' })
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 2 })
    expect(h.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
    await $.tool.call({ tool: 'Edit', file_path: 'parser.go', old_string: 'b', new_string: 'c' })
    const switched = await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    expect(JSON.stringify(switched)).toContain('already ran')
    expect(JSON.stringify(switched)).not.toContain('call the Agent tool with subagent_type \\"automode:architect\\"')
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 3 })
    await h.step($, 'claude-opus-5-5', undefined, { index: 4 })
    await h.complete($)
    const r = records(h.writes)
    const sent = r.filter((x) => x.kind === 'request' && !x.agentId).map((x) => x.sent.model)
    expect(sent).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
    const next = await h.submit($, 'go ahead')
    expect(next.context.join('\n')).toContain('automode:reviewer')
  })

  test('a piped check runs with pipefail', async ($, on) => {
    const h = harness(on, { bash: () => ({ result: { stdout: 'ok', stderr: '' }, text: '' }) })
    await h.submit($, 'add retries to the uploader')
    await $.tool.call({ tool: 'Bash', command: 'go test ./... 2>&1 | tail -5' })
    expect(h.commands[0]).toBe('set -o pipefail; go test ./... 2>&1 | tail -5')
  })

  test('a drop in the request message count marks a compaction (no hook needed) and re-attaches the task state', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T2', complexity: 'standard', risk: 'critical', riskWhy: 'migration' }) })
    await h.submit($, 'write the data migration for users\n- must keep existing ids')
    await h.step($, 'claude-sonnet-5-5', undefined, { messageCount: 40 })
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 1, messageCount: 4 })
    await h.complete($)
    const r = records(h.writes)
    expect(r.find((x) => x.kind === 'compaction')?.via).toContain('message count 40 -> 4')
    expect(decisions(r).find((x) => x.point === 'trigger')?.trigger.event).toBe('compacted')
    const out = await h.submit($, 'continue')
    expect(out.context.join('\n')).toContain('must keep existing ids')
  })

  test('provider guard: on Vertex, auto mode observes only and Claude Code runs as usual', async ($, on) => {
    const h = harness(on, { env: { CLAUDE_CODE_USE_VERTEX: '1' }, judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }) })
    await h.submit($, 'where is the output folder written?')
    await h.step($)
    await h.complete($)
    expect(h.steps[0].model).toBe('claude-sonnet-5-5')
    expect(records(h.writes).find((x) => x.kind === 'guard')?.provider).toBe('vertex')
  })
})

describe('Adaptive edges', () => {
  test('a task the running Haiku route is not adequate for moves up at once, no vote gate (live VS Code A3)', async ($, on) => {
    let n = 0
    const h = harness(on, { judge: () => judge(n++ === 0 ? { tier: 'T0', complexity: 'trivial', effort: 'low' } : { tier: 'T1', complexity: 'standard', newTask: true, confidence: 0.9 }), effortJudge: (p) => (/output folder/.test(p) ? says('haiku', 'low') : says('sonnet'))(p) })
    h.setPrefix(65_000)
    await h.submit($, 'where is the output folder written?')
    await h.step($)
    await h.complete($, 'claude-haiku-5-5')
    await h.submit($, 'add a --dry-run flag to the setup command')
    await h.step($, 'claude-haiku-5-5', undefined, { turnId: 't2' })
    expect(h.steps[1].model).toBe('claude-sonnet-5-5')
    const d = records(h.writes).filter((x) => x.kind === 'decision')[1]
    expect(d.effective.owner).toBe('quality-escalation')
    expect(d.effective.floor).toBe('T1')
  })

  test('a check whose exit code is masked but which prints FAIL is a failure, with the live Bash result shape { stdout, stderr }', async ($, on) => {
    const out = { result: { stdout: '--- FAIL: TestPlantedChecksum (0.00s)\n    planted_test.go:15: plantedChecksum = 43, want 41\nFAIL\nFAIL\tgithub.com/x/config\t0.2s', stderr: '', interrupted: false }, isError: false, text: '' }
    const h = harness(on, { judge: judge({ tier: 'T2', complexity: 'standard' }), bash: () => out })
    await h.submit($, 'make TestPlantedChecksum pass')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/ || true' })
    await $.tool.call({ tool: 'Edit', file_path: 'src/config/planted.go', old_string: 'a', new_string: 'b' })
    const second = await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/ || true' })
    expect(JSON.stringify(second)).toMatch(/escalated|automode:architect/)
  })

  test('a passing check with a harmless FAIL in its log is a pass', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T2', complexity: 'standard' }), bash: () => ({ result: { stdout: 'TestFAILover ok\nok  \tgithub.com/x/config\t0.2s', stderr: '' }, isError: false, text: '' }) })
    await h.submit($, 'fix the failover test')
    await h.step($)
    await $.tool.call({ tool: 'Edit', file_path: 'a.go', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await h.complete($)
    expect(records(h.writes).find((x) => x.kind === 'outcome').checks).toEqual({ pass: 1, fail: 0 })
  })

  test('a compact_boundary notice alone (no session.compact hook) marks the compaction: envelope re-attached, next request re-evaluated', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T2', complexity: 'standard', risk: 'critical', riskWhy: 'migration' }) })
    await h.submit($, 'write the data migration for users\n- must keep existing ids')
    await h.step($)
    await h.complete($)
    await $.session.append({ message: { type: 'system', name: 'compact_boundary', content: [] }, door: 'notice', origin: { kind: 'engine' }, uuid: 'u1' })
    const r = records(h.writes)
    expect(r.find((x) => x.kind === 'compaction')?.via).toContain('session.append')
    const out = await h.submit($, 'continue')
    expect(out.context.join('\n')).toContain('must keep existing ids')
  })

  test('a compaction the hook never saw (another process) is detected from the shrunken prompt', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T2', complexity: 'standard' }) })
    h.setPrefix(150_000)
    await h.submit($, 'fix the flaky retry test')
    await h.step($)
    h.setPrefix(14_000) // the engine compacted without this mod's hook
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 1 })
    await h.complete($)
    expect(decisions(records(h.writes)).find((x) => x.point === 'trigger')?.trigger.event).toBe('compacted')
  })

  test('the turn\'s last request is in the ledger before turn.complete (print mode can exit first)', async ($, on) => {
    const h = harness(on, {})
    await h.submit($, 'add retries to the uploader')
    await h.step($)
    expect(records(h.writes).filter((x) => x.kind === 'request').length).toBe(1)
    expect(records(h.writes).find((x) => x.kind === 'request').usage.cacheWrite1h + records(h.writes).find((x) => x.kind === 'request').usage.cacheWrite5m).toBe(0)
  })

  test('a passed check in implementation re-optimizes without a judge call', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T2', complexity: 'standard' }) })
    await h.submit($, 'fix the flaky retry test')
    await h.step($)
    await $.tool.call({ tool: 'Edit', file_path: 'retry.go', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'go vet ./...' })
    await h.complete($)
    expect(h.judged.length).toBe(1)
    expect(decisions(records(h.writes)).some((x) => x.trigger?.event === 'check-pass')).toBe(true)
  })

  test('an ordinary tool step triggers nothing', async ($, on) => {
    const h = harness(on, {})
    await h.submit($, 'add retries to the uploader')
    await h.step($)
    await $.tool.call({ tool: 'Read', file_path: 'a.go' })
    await $.tool.call({ tool: 'Grep', pattern: 'x' })
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 1 })
    await h.complete($)
    expect(decisions(records(h.writes)).filter((x) => x.point === 'trigger').length).toBe(0)
    expect(h.judged.length).toBe(1)
  })

  test('a Haiku route past its context limit moves up before the next request, no judge call', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }), effortJudge: says('haiku', 'low') })
    await h.submit($, 'where is the output folder written?')
    h.setPrefix(90_000)
    await h.step($)
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 1 })
    await h.complete($)
    expect(h.steps.map((s) => s.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5'])
    expect(decisions(records(h.writes)).find((x) => x.point === 'trigger').trigger).toMatchObject({ event: 'context-growth', mandatory: true })
    expect(h.judged.length).toBe(1)
  })

  test('a worker over its budget is stopped from reading more', async ($, on) => {
    const h = harness(on, {})
    await h.submit($, 'explore the setup package')
    await $.agent.spawn({ subagentType: 'Explore', prompt: 'find x', description: 'x' })
    h.setPrefix(50_000)
    await h.step($, 'claude-haiku-5-5', 'w1')
    const read = await $.tool.call({ tool: 'Read', file_path: 'a.go', agentId: 'w1' })
    expect(read.deny ?? read.text).toContain('Budget reached')
  })
})

describe('Persistence, isolation, determinism', () => {
  test('a session switch and return restores the route and the task from the store: a follow-up needs no judge', async ($, on) => {
    const h = harness(on, { policy: 'legacy', judge: judge({ tier: 'T3', complexity: 'complex' }) })
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    const id = String(records(h.writes)[0].sessionId)
    h.setSession('other-session', 'claude-sonnet-5-5') // /resume into a plain Sonnet session: state resets
    await h.submit($, 'hello')
    h.setSession(id, 'claude-sonnet-5-5[1m]') // back: the router restores this session's snapshot
    await h.submit($, 'go ahead')
    expect(h.judged.length).toBe(1)
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    expect(h.steps[1].model).toBe('claude-opus-5-5')
  })

  test('another session starts clean: a plain Sonnet session next to an active one gets no route, no records', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T3', complexity: 'complex' }) })
    await h.submit($, 'design the cache layer')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    const before = records(h.writes).length
    expect(before).toBeGreaterThan(0)
    h.setSession('sess-2', 'claude-sonnet-5-5')
    await h.submit($, 'go ahead')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    await h.complete($)
    expect(h.steps[1].model).toBe('claude-sonnet-5-5')
    expect(h.judged.length).toBe(1)
    expect(records(h.writes).length).toBe(before)
  })

  test('the same events give byte-identical records', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T2', complexity: 'complex' }) })
    const run = async (id: string) => {
      h.setSession(id)
      for (const k of Object.keys(h.writes)) delete h.writes[k]
      await h.submit($, 'the integration test deadlocks under load')
      await h.step($)
      await h.complete($)
      return Object.values(h.writes).join('').replaceAll(id, 'SESSION')
    }
    const first = await run('det-1')
    const second = await run('det-2')
    expect(second).toBe(first)
  })
})
