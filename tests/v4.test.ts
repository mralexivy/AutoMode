// Mod tests for the V4 router (hooks/v4.ts through hooks/register.ts) under `claude plugin test`.
// The test's hooks stand for the engine: config, model, judge, requests, spawns, tools, files.
import { describe, expect, test } from 'claude-code/testing'
import { harness, judge, records, says } from './harness.ts'

describe('V4: activation and modes', () => {
  test('inactive session (plain Sonnet): no judge, no context, no rewrite, no records', async ($, on) => {
    const h = harness(on, { model: 'claude-sonnet-5-5' })
    const out = await h.submit($, 'add retries to the uploader')
    await h.step($)
    await h.complete($)
    expect(h.judged.length).toBe(0)
    expect(out.context.length).toBe(0)
    expect(h.steps[0].model).toBe('claude-sonnet-5-5')
    expect(records(h.writes).length).toBe(0)
  })

  test('shadow: zero interference on the request, the decision recorded after the turn', async ($, on) => {
    const h = harness(on, { policy: 'legacy', mode: 'shadow', judge: judge({ tier: 'T3', complexity: 'complex' }) })
    const out = await h.submit($, 'redesign the plugin install flow across setup and the marketplace')
    expect(out.context.length).toBe(0)
    expect(h.judged.length).toBe(0) // the judge runs after the turn, off the critical path
    await h.step($)
    expect(h.steps[0].model).toBe('claude-sonnet-5-5')
    expect(h.steps[0].effort).toBe('medium')
    expect(h.registered.length).toBe(0) // no tools in shadow: tool definitions would change the request
    await h.complete($)
    expect(h.judged.length).toBe(1)
    const r = records(h.writes)
    expect(r.find((x) => x.kind === 'decision')).toMatchObject({ kind: 'decision', mode: 'shadow', applied: false, effective: { tier: 'T3' }, actual: { model: 'claude-sonnet-5-5' } })
    // The request is recorded as the app sent it: shadow never rewrites.
    expect(r.find((x) => x.kind === 'request')).toMatchObject({ app: { model: 'claude-sonnet-5-5', effort: 'medium' }, sent: { model: 'claude-sonnet-5-5', effort: 'medium' }, effortApplied: false })
  })

  test('kill switch AUTOMODE_ROUTER=off: nothing runs even with mode auto', async ($, on) => {
    const h = harness(on, { mode: 'auto', env: { AUTOMODE_ROUTER: 'off' } })
    const out = await h.submit($, 'add retries')
    expect(h.judged.length).toBe(0)
    expect(out.context.length).toBe(0)
  })
})

describe('V4 legacy: a warm return', () => {
  test('the turns the old cache lacks are priced: legacy passes what that cache holds', async ($, on) => {
    let n = 0
    const tiers = [{ tier: 'T3', complexity: 'complex' }, { tier: 'T1', complexity: 'standard', newTask: true, confidence: 0.95 }, { tier: 'T3', complexity: 'complex', newTask: true }]
    const h = harness(on, { policy: 'legacy', judge: () => judge(tiers[n++]) })
    h.setPrefix(10_000)
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'add a --verbose flag to the usage command')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    h.setPrefix(100_000)
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2', index: 1 })
    await h.complete($, 'claude-sonnet-5-5', undefined, 'done', { turnId: 't2' })
    await h.submit($, 'design the eviction policy for the record store')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't3' })
    await h.complete($, 'claude-sonnet-5-5', undefined, 'done', { turnId: 't3' })
    const last = records(h.writes).filter((x) => x.kind === 'decision' && x.point === 'prompt').at(-1)
    expect(last.effective.check.economics.writePenaltyUsd).toBeGreaterThan(0.5) // 90k written on Opus, not read
  })
})

describe('V4 auto: model and effort routing', () => {
  test('a lookup routes to Haiku at a low-switch-penalty point, with the owner recorded', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }), effortJudge: says('haiku', 'medium') })
    const out = await h.submit($, 'where is the output folder written?')
    expect(out.context.length).toBe(0) // ordinary work: no injected text, no overhead
    await h.step($)
    expect(h.steps[0].model).toBe('claude-haiku-5-5')
    expect(h.steps[0].effort).toBe('medium') // legacy: Haiku low is only 'likely' adequate, so its retry makes medium cheaper; auto: the verdict's effort
  })

  test('architecture routes to Opus, and a follow-up keeps the route without a judge call', async ($, on) => {
    const h = harness(on, { policy: 'legacy', judge: judge({ tier: 'T3', complexity: 'complex', effort: 'high' }) })
    await h.submit($, 'design how routing decisions reach Langfuse across services')
    await h.step($)
    expect(h.steps[0].model).toBe('claude-opus-5-5')
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'go ahead')
    expect(h.judged.length).toBe(1)
    await h.step($, 'claude-opus-5-5')
    expect(h.steps[1].model).toBe('claude-opus-5-5')
  })

  test('a user override wins and is recorded as the owner', async ($, on) => {
    const h = harness(on, {})
    await h.submit($, 'add a flag for the cache TTL')
    await h.step($)
    await h.complete($)
    const out = await h.submit($, 'am:opus review this again')
    expect(out.context[0]).toContain('user-override')
    await h.step($)
    expect(h.steps[1].model).toBe('claude-opus-5-5')
  })

  test('judge failure: a conservative route and required checks, and the prompt is never blocked', async ($, on) => {
    const h = harness(on, { policy: 'legacy', judge: null })
    const out = await h.submit($, 'add retries to the uploader')
    expect(out.context.join('\n')).toContain('run the relevant tests or build')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
    await h.complete($)
    const d = records(h.writes).find((x) => x.kind === 'decision')
    expect(d.method).toBe('fallback')
    expect(d.risk.effective).toBe('elevated')
    expect(records(h.writes).find((x) => x.kind === 'model-call')).toMatchObject({ purpose: 'judge', ok: false })
  })

  test('critical risk from the task sets a Sonnet-high floor and a review requirement, not Opus', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T1', risk: 'critical', riskWhy: 'changes auth scopes' }) })
    const out = await h.submit($, 'pin the OAuth scopes in internal/auth/scopes.go')
    expect(out.context[0]).toContain('T2 sonnet high') // bounded critical work: Sonnet high plus a mandatory Opus review
    expect(out.context[0]).toContain('automode:reviewer')
    expect(out.context.join('\n')).toContain('Independent review required')
  })

  test('topic words alone do not raise risk', async ($, on) => {
    const h = harness(on, {})
    const out = await h.submit($, 'add a token counter to the usage report')
    expect(out.context.join('\n')).not.toContain('automode:reviewer')
    await h.step($)
    expect(h.steps[0].model).toBe('claude-sonnet-5-5')
  })

  test('effort changes wait for a low-penalty point on Vertex', async ($, on) => {
    const h = harness(on, { env: { CLAUDE_CODE_USE_VERTEX: '1' }, judge: (p) => (p.includes('rename') ? judge({ effort: 'low', newTask: true }) : judge({ effort: 'medium' })) })
    await h.submit($, 'add retries to the uploader')
    await h.step($)
    await h.complete($)
    await h.submit($, 'rename the retry constant')
    await h.step($)
    expect(h.steps[1].effort).toBe('medium') // warm cache on Vertex: the effort split would rewrite it
  })
})

describe('V4 auto: escalation, guards, workers', () => {
  test('the same failing check twice after an edit escalates with evidence', async ($, on) => {
    const h = harness(on, {})
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await $.tool.call({ tool: 'Edit', file_path: 'parser.go', old_string: 'a', new_string: 'b' })
    const second = await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    expect(JSON.stringify(second)).toContain('escalated to T2')
    await h.step($)
    expect(h.steps[1].effort).toBe('high')
  })

  test('read-only agents cannot write, directly or through Bash', async ($, on) => {
    const h = harness(on, {})
    await h.submit($, 'explore the setup package')
    await $.agent.spawn({ subagentType: 'Explore', prompt: 'find x', description: 'x' })
    expect(h.spawned[0]).toEqual({ subagentType: 'automode:explorer', model: 'haiku' })
    const edit = await $.tool.call({ tool: 'Edit', file_path: 'a.go', old_string: 'a', new_string: 'b', agentId: 'w1' })
    expect(edit.deny ?? edit.text).toContain('read-only')
    const bash = await $.tool.call({ tool: 'Bash', command: 'echo x > a.go', agentId: 'w1' })
    expect(bash.deny ?? bash.text).toContain('read-only')
  })

  test('subagents cannot run git writes or destructive commands; the main session can', async ($, on) => {
    const h = harness(on, {})
    await h.submit($, 'fix the parser bug')
    const denied = async (command: string, agentId?: string) => {
      const r = await $.tool.call({ tool: 'Bash', command, ...(agentId ? { agentId } : {}) })
      return String(r.deny ?? '').includes('git writes')
    }
    expect(await denied('git commit -m x', 'a1')).toBe(true)
    expect(await denied('git push origin main', 'a1')).toBe(true)
    expect(await denied('rm -rf build', 'a1')).toBe(true)
    expect(await denied('git status --short', 'a1')).toBe(false)
    expect(await denied('git restore --staged x', 'a1')).toBe(false)
    expect(await denied('git commit -m x')).toBe(false)
  })

  test('Explore is not redirected in shadow mode or when the call names a model', async ($, on) => {
    const h = harness(on, { mode: 'shadow' })
    await $.agent.spawn({ subagentType: 'Explore', prompt: 'find x', description: 'x' })
    expect(h.spawned[0].subagentType).toBe('Explore')
  })

  test('isolated worker: the router asks for the Haiku explorer, the hook pins Haiku and validates the report', async ($, on) => {
    const report = '{"findings":[{"what":"installs","where":"plugins.go:132","confidence":"high"}],"relevant_files":["src/setup/plugins.go"],"omitted":[],"complete":true}'
    const h = harness(on, { judge: judge({ strategy: 'isolated-worker' }), workerAnswer: report })
    const out = await h.submit($, 'map how plugins are installed across the setup package')
    expect(out.context[0]).toContain('subagent_type "automode:explorer"')
    const res = await $.tool.call({ tool: 'Agent', subagent_type: 'automode:explorer', description: 'src/setup', prompt: 'find install paths' })
    expect(h.spawned[0]).toEqual({ subagentType: 'automode:explorer', model: 'haiku' })
    expect(JSON.stringify(res.context ?? [])).not.toContain('did not return the report format')
  })

  test('isolated worker: a partial or invalid report is flagged, never silently trusted', async ($, on) => {
    const h = harness(on, { judge: judge({ strategy: 'isolated-worker' }), workerAnswer: '{"findings":[],"relevant_files":[],"omitted":["src/setup/mcp.go: budget"],"complete":false}' })
    await h.submit($, 'map how plugins are installed across the setup package')
    const partial = await $.tool.call({ tool: 'Agent', subagent_type: 'automode:explorer', description: 'x', prompt: 'p' })
    expect(JSON.stringify(partial.context)).toContain('partial')
  })

  test('a critical consequence sets review and a Sonnet-high floor; Opus comes from the demand, not the label', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T1', complexity: 'complex', risk: 'critical', riskWhy: 'auth redesign' }) })
    const out = await h.submit($, 'redesign how sessions and credentials are stored across services')
    expect(out.context[0]).toContain('T2 sonnet high')
    expect(out.context.join('\n')).toContain('automode:reviewer')
  })

  test('a hard critical design (judge T3, complex) runs on Opus', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T3', complexity: 'complex', risk: 'critical', riskWhy: 'auth redesign' }) })
    const out = await h.submit($, 'redesign how sessions and credentials are stored across services')
    expect(out.context[0]).toContain('opus')
  })

  test('compaction keeps the task state and makes the next prompt re-attach it', async ($, on) => {
    const h = harness(on, { judge: judge({ risk: 'critical', riskWhy: 'migration' }) })
    await h.submit($, 'write the data migration for users\n- must keep existing ids')
    const c = await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'x', toolUses: [] }] })
    expect(JSON.stringify(c)).toContain('S'.repeat(50))
    const out = await h.submit($, 'continue')
    expect(out.context.join('\n')).toContain('[AutoMode task state]')
    expect(out.context.join('\n')).toContain('must keep existing ids')
  })
})

describe('V4 auto: effort engine (effortless integration)', () => {
  test('effort is sent even when the app names none, on Haiku too', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }), effortJudge: says('haiku', 'medium') })
    await h.submit($, 'where is the output folder written?')
    await h.step($, 'claude-sonnet-5-5', undefined, { effort: undefined })
    expect(h.steps[0].model).toBe('claude-haiku-5-5')
    expect(h.steps[0].effort).toBe('medium')
    await h.complete($, 'claude-haiku-5-5')
    const req = records(h.writes).find((r) => r.kind === 'request')
    expect(req).toMatchObject({ app: { model: 'claude-sonnet-5-5', effort: null }, sent: { model: 'claude-haiku-5-5', effort: 'medium' }, effortApplied: true, owner: 'judge' })
    expect(req.usd.basis).toBe('measured')
  })

  test('same model, effort changes per prompt: Sonnet medium, then high, then medium', async ($, on) => {
    let n = 0
    const tiers = [{ tier: 'T1', effort: 'medium' }, { tier: 'T2', effort: 'medium' }, { tier: 'T1', effort: 'medium', newTask: false }]
    const h = harness(on, { policy: 'legacy', judge: () => judge({ ...tiers[Math.min(n++, 2)], confidence: 0.95 }) })
    const efforts: unknown[] = []
    for (const text of ['add a flag to the setup command', 'the cleanup test fails only in CI, find out why', 'now rename the flag to --dry-run']) {
      await h.submit($, text)
      await h.step($, 'claude-sonnet-5-5', undefined, { turnId: `t${efforts.length}` })
      efforts.push(h.steps[h.steps.length - 1].effort)
      await h.complete($)
    }
    expect(h.steps.every((s) => s.model === 'claude-sonnet-5-5')).toBe(true)
    expect(efforts).toEqual(['medium', 'high', 'medium'])
  })

  test('the optimizer picks xhigh where the demand justifies it', async ($, on) => {
    const h = harness(on, { policy: 'legacy', judge: judge({ tier: 'T2', complexity: 'complex', effort: 'medium' }) }) // pins the legacy optimizer's xhigh
    await h.submit($, 'the integration test deadlocks under load; find and fix the cause')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'xhigh' })
    await h.complete($)
    const dec = records(h.writes).find((r) => r.kind === 'decision')
    expect(dec.optimizer.best).toBe('sonnet/xhigh')
    expect(dec.optimizer.top.length).toBeGreaterThan(0)
    expect(dec.strategy.estimates.map((e: any) => e.strategy)).toEqual(['direct', 'isolated-worker'])
  })

  test('outcome records count the turn requests', async ($, on) => {
    const h = harness(on, {})
    await h.submit($, 'add retries to the uploader')
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 0 })
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 1 })
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 2 })
    await h.complete($)
    const r = records(h.writes)
    expect(r.filter((x) => x.kind === 'request').length).toBe(3)
    expect(r.find((x) => x.kind === 'outcome').requests).toBe(3)
  })

  test('a redo raises the route one step and keeps it up for the next prompts', async ($, on) => {
    const h = harness(on, { policy: 'legacy', judge: judge({ tier: 'T1', newTask: false, confidence: 0.95 }) })
    await h.submit($, 'add a flag to the setup command')
    await h.step($)
    await h.complete($)
    await h.submit($, "that's wrong, the flag is ignored")
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    expect(h.steps[1].effort).toBe('high')
    await h.complete($)
    const dec = records(h.writes).filter((r) => r.kind === 'decision')[1]
    expect(dec.effective.floor).toBe('T2')
  })

  test('a lower pick typed mid-turn waits for the turn to end', async ($, on) => {
    let n = 0
    const h = harness(on, { policy: 'legacy', judge: () => judge(n++ === 0 ? { tier: 'T2', effort: 'medium' } : { tier: 'T1', effort: 'medium', newTask: false, confidence: 0.95 }) })
    await h.submit($, 'the cleanup test fails only in CI, find out why')
    await h.step($)
    expect(h.steps[0].effort).toBe('high')
    await $.prompt.submit({ text: 'also print the path it removes', wait: false, turnId: 't1', origin: { kind: 'composer' } })
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 1 })
    expect(h.steps[1].effort).toBe('high')
    await h.complete($)
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    expect(h.steps[2].effort).toBe('medium')
  })

  test('plan mode raises the demand; leaving it lets the route step down', async ($, on) => {
    const h = harness(on, { policy: 'legacy', judge: judge({ tier: 'T2', complexity: 'standard', effort: 'medium' }) }) // pins the legacy plan raise
    await $.prompt.attachment({ type: 'plan_mode', text: 'plan mode', origin: { kind: 'engine' }, detail: { reminder: 'full' } })
    await h.submit($, 'plan how to split the setup package')
    await h.step($)
    const planned = h.steps[0].effort
    expect(['xhigh', 'max']).toContain(planned)
    await h.complete($)
    await $.prompt.attachment({ type: 'plan_mode_exit', text: 'exit', origin: { kind: 'engine' }, detail: { hasPlan: true } })
    const r = records(h.writes)
    expect(r.filter((x) => x.kind === 'plan-mode').map((x) => x.on)).toEqual([true])
  })

  test('a second exploration in the task is told what the first one covered', async ($, on) => {
    const report = '{"findings":[],"relevant_files":["src/setup/plugins.go"],"omitted":[],"complete":true}'
    const h = harness(on, { workerAnswer: report })
    await h.submit($, 'map how plugins install')
    await $.tool.call({ tool: 'Agent', subagent_type: 'automode:explorer', prompt: 'map plugins', description: 'map' })
    await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', prompt: 'find the marketplace code', description: 'find' })
    expect(h.agentPrompts[1]).toContain('src/setup/plugins.go')
    await h.complete($)
    expect(records(h.writes).some((r) => r.kind === 'reuse')).toBe(true)
  })

  test('changed lines from edits raise observed risk past the diff threshold', async ($, on) => {
    const h = harness(on, {})
    await h.submit($, 'add retries to the uploader')
    await $.tool.call({ tool: 'Write', file_path: 'big.go', content: 'x\n'.repeat(450) })
    const out = await h.submit($, 'go ahead')
    expect(out.context.join('\n')).toContain('automode:reviewer')
  })

  test('a repeated defect on Sonnet consults an Opus architect when a switch costs more, then switches on the next repeat', async ($, on) => {
    const h = harness(on, { policy: 'legacy', judge: judge({ tier: 'T2', complexity: 'standard' }) })
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await $.tool.call({ tool: 'Edit', file_path: 'parser.go', old_string: 'a', new_string: 'b' })
    const second = await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    expect(JSON.stringify(second)).toContain('automode:architect')
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 1 })
    expect(h.steps[1].model).toBe('claude-sonnet-5-5')
    await $.tool.call({ tool: 'Edit', file_path: 'parser.go', old_string: 'b', new_string: 'c' })
    const third = await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    expect(JSON.stringify(third)).toContain('escalated to T3')
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 2 })
    expect(h.steps[2].model).toBe('claude-opus-5-5')
  })
})

// User tier: the engine skips prompt.attachment and session.compact for a user-installed plugin on a Team or
// Enterprise login. The command hook writes the same facts to <data>/signals/<session>.json; the mod reads it.
describe('V4 auto: user-tier signals', () => {
  // The mod cannot see CLAUDE_PLUGIN_DATA, so the signals file sits at a fixed path under the config dir.
  const file = (id: string) => `/cfg/plugins/data/automode/signals/${id}.json`
  const setup = (id: string, extra: Record<string, any> = {}) => ({ sessionId: id, policy: 'legacy', judge: judge({ tier: 'T2', complexity: 'standard', effort: 'medium' }), ...extra, env: { CLAUDE_CONFIG_DIR: '/cfg', ...(extra.env ?? {}) } })
  const planRecords = (w: Record<string, string>) => records(w).filter((x) => x.kind === 'plan-mode')
  const compactions = (w: Record<string, string>) => records(w).filter((x) => x.kind === 'compaction')

  test('a plan signal raises the demand like the engine attachment, and says so in the status', async ($, on) => {
    const h = harness(on, setup('sig-plan'))
    h.writes[file('sig-plan')] = JSON.stringify({ seq: 1, permissionMode: 'plan', compactions: [] })
    await h.submit($, 'plan how to split the setup package')
    await h.step($)
    expect(['xhigh', 'max']).toContain(h.steps[0].effort)
    expect(planRecords(h.writes).map((x) => [x.on, x.via])).toEqual([[true, 'signal']])
    expect(h.statuses.some((s) => s.includes('· plan'))).toBe(true)
  })

  test('leaving plan mode is read from the next signal, and a replayed seq changes nothing', async ($, on) => {
    const h = harness(on, setup('sig-exit'))
    h.writes[file('sig-exit')] = JSON.stringify({ seq: 1, permissionMode: 'plan', compactions: [] })
    await h.submit($, 'plan how to split the setup package')
    await h.step($)
    await h.complete($)
    await h.submit($, 'plan it again') // the same file: seq 1 is not new
    h.writes[file('sig-exit')] = JSON.stringify({ seq: 2, permissionMode: 'default', compactions: [] })
    await h.submit($, 'now implement it')
    await h.step($) // records are written when a step ends
    expect(planRecords(h.writes).map((x) => x.on)).toEqual([true, false])
    expect(h.statuses[h.statuses.length - 1]).not.toContain('· plan')
  })

  test('a plan exit that lands after routing refreshes the status row (live B2: the stale "· plan" stayed)', async ($, on) => {
    const h = harness(on, setup('sig-stale'))
    h.writes[file('sig-stale')] = JSON.stringify({ seq: 1, permissionMode: 'plan', compactions: [] })
    await h.submit($, 'plan how to restructure the uploader into two packages')
    await h.step($)
    await h.complete($)
    await h.submit($, 'now implement the first package') // the file still says plan: the status says plan too
    expect(h.statuses[h.statuses.length - 1]).toContain('· plan')
    h.writes[file('sig-stale')] = JSON.stringify({ seq: 2, permissionMode: 'auto', compactions: [] })
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    expect(planRecords(h.writes).map((x) => x.on)).toEqual([true, false])
    expect(h.statuses[h.statuses.length - 1]).not.toContain('· plan')
  })

  test('the engine attachment and the signal together change plan mode once', async ($, on) => {
    const h = harness(on, setup('sig-both'))
    await $.prompt.attachment({ type: 'plan_mode', text: 'plan mode', origin: { kind: 'engine' }, detail: { reminder: 'full' } })
    h.writes[file('sig-both')] = JSON.stringify({ seq: 1, permissionMode: 'plan', compactions: [] })
    await h.submit($, 'plan how to split the setup package')
    await h.step($)
    expect(planRecords(h.writes).length).toBe(1)
  })

  test('a signal written while the judge runs reaches this prompt, with the full plan demand', async ($, on) => {
    // Live 2026-10-23: the command hook ends about 50 ms after the prompt, the mod's prompt.submit starts first
    // and the judge takes about a second. The router reads the file again after the judge, before the demand.
    let h: ReturnType<typeof harness>
    h = harness(on, setup('sig-judge', { judge: (p: string) => { h.writes[file('sig-judge')] = JSON.stringify({ seq: 1, permissionMode: 'plan', compactions: [] }); return judge({ tier: 'T2', complexity: 'standard', effort: 'medium' }) } }))
    await h.submit($, 'plan how to split the setup package')
    await h.step($)
    expect(['xhigh', 'max']).toContain(h.steps[0].effort)
    expect(planRecords(h.writes).map((x) => [x.on, x.via])).toEqual([[true, 'signal']])
  })

  test('the first prompt of a session: a signal that lands after routing re-optimizes at the first step and updates the status', async ($, on) => {
    const h = harness(on, setup('sig-first'))
    await h.submit($, 'plan how to restructure the uploader into two packages')
    expect(h.statuses[h.statuses.length - 1]).not.toContain('· plan')
    h.writes[file('sig-first')] = JSON.stringify({ seq: 1, permissionMode: 'plan', compactions: [] })
    await h.step($)
    expect(['xhigh', 'max']).toContain(h.steps[0].effort)
    expect(records(h.writes).some((x) => x.kind === 'decision' && x.point === 'trigger' && x.trigger?.event === 'plan-enter')).toBe(true)
    expect(h.statuses[h.statuses.length - 1]).toContain('· plan')
  })

  test('a signal that arrives after the prompt was routed re-optimizes at the first step', async ($, on) => {
    const h = harness(on, setup('sig-late'))
    await h.submit($, 'add retries to the uploader')
    await h.step($)
    await h.complete($) // the route is now running: S.current is set
    await h.submit($, 'plan how to restructure the uploader into two packages')
    h.writes[file('sig-late')] = JSON.stringify({ seq: 1, permissionMode: 'plan', compactions: [] })
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    expect(planRecords(h.writes).map((x) => x.on)).toEqual([true])
    expect(records(h.writes).some((x) => x.kind === 'decision' && x.point === 'trigger' && x.trigger?.event === 'plan-enter')).toBe(true)
  })

  test('a compaction signal counts once with the message-count signal, and tells the user once', async ($, on) => {
    const h = harness(on, setup('sig-compact'))
    await h.submit($, 'add retries to the uploader')
    await h.step($, 'claude-sonnet-5-5', undefined, { messageCount: 20 })
    h.writes[file('sig-compact')] = JSON.stringify({ seq: 1, permissionMode: 'default', compactions: [{ at: 5, via: 'PostCompact:manual' }] })
    await h.submit($, 'continue')
    await h.step($, 'claude-sonnet-5-5', undefined, { messageCount: 4 })
    expect(compactions(h.writes).length).toBe(1)
    expect(compactions(h.writes)[0].via).toContain('PostCompact:manual')
    expect(h.toasts.filter((t) => t.includes('user plugin')).length).toBe(1)
    h.writes[file('sig-compact')] = JSON.stringify({ seq: 2, permissionMode: 'default', compactions: [{ at: 5, via: 'PostCompact:manual' }, { at: 9, via: 'PostCompact:auto' }] })
    await h.submit($, 'and again')
    expect(h.toasts.filter((t) => t.includes('user plugin')).length).toBe(1)
  })

  test('no user-tier notice when the engine did call session.compact', async ($, on) => {
    const h = harness(on, setup('sig-org'))
    await h.submit($, 'add retries to the uploader')
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'x', toolUses: [] }] })
    h.writes[file('sig-org')] = JSON.stringify({ seq: 1, permissionMode: 'default', compactions: [{ at: 5, via: 'PostCompact:manual' }] })
    await h.submit($, 'continue')
    expect(h.toasts.filter((t) => t.includes('user plugin')).length).toBe(0)
  })

  test('a missing, corrupt, or foreign file changes nothing', async ($, on) => {
    const h = harness(on, setup('sig-bad'))
    await h.submit($, 'add retries to the uploader')
    h.writes[file('sig-bad')] = '{not json'
    await h.submit($, 'continue')
    h.writes[file('sig-bad')] = JSON.stringify({ seq: 'x', permissionMode: 7, compactions: 'no' })
    await h.submit($, 'continue again')
    expect(planRecords(h.writes).length + compactions(h.writes).length).toBe(0)
  })

  test('a compaction the message-count signal already counted is not counted again when the hook entry arrives later', async ($, on) => {
    const h = harness(on, setup('sig-dup'))
    await h.submit($, 'add retries to the uploader')
    await h.step($, 'claude-sonnet-5-5', undefined, { messageCount: 20 })
    await h.step($, 'claude-sonnet-5-5', undefined, { messageCount: 4, index: 1 }) // the count dropped: compaction noted
    await h.step($, 'claude-sonnet-5-5', undefined, { messageCount: 5, index: 2 }) // the next request consumes the flag
    h.writes[file('sig-dup')] = JSON.stringify({ seq: 1, permissionMode: 'default', compactions: [{ at: 1_000_000, via: 'PostCompact:auto' }] })
    await h.submit($, 'continue')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    expect(compactions(h.writes).length).toBe(1)
  })

  test('an explicit model override survives a plan signal that lands after routing', async ($, on) => {
    const h = harness(on, setup('sig-ovr'))
    await h.submit($, 'add a flag for the cache TTL')
    await h.step($)
    await h.complete($)
    await h.submit($, 'am:haiku plan how to restructure the uploader')
    h.writes[file('sig-ovr')] = JSON.stringify({ seq: 1, permissionMode: 'plan', compactions: [] })
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    expect(h.steps[1].model).toBe('claude-haiku-5-5')
    expect(records(h.writes).some((x) => x.kind === 'decision' && x.trigger?.event === 'plan-enter')).toBe(false)
  })

  test('a signals file that starts over at a lower seq is still read', async ($, on) => {
    const h = harness(on, setup('sig-restart'))
    h.writes[file('sig-restart')] = JSON.stringify({ seq: 5, permissionMode: 'plan', compactions: [] })
    await h.submit($, 'plan how to restructure the uploader into two packages')
    await h.step($)
    await h.complete($)
    h.writes[file('sig-restart')] = JSON.stringify({ seq: 1, permissionMode: 'auto', compactions: [] }) // pruned and rewritten
    await h.submit($, 'now implement the first package')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    expect(planRecords(h.writes).map((x) => x.on)).toEqual([true, false])
  })

  test('a plan exit read before routing does not re-optimize from the previous task', async ($, on) => {
    const h = harness(on, setup('sig-quiet'))
    h.writes[file('sig-quiet')] = JSON.stringify({ seq: 1, permissionMode: 'plan', compactions: [] })
    await h.submit($, 'plan how to restructure the uploader into two packages')
    await h.step($)
    await h.complete($)
    h.writes[file('sig-quiet')] = JSON.stringify({ seq: 2, permissionMode: 'auto', compactions: [] })
    await h.submit($, 'now implement the first package')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    expect(planRecords(h.writes).map((x) => x.on)).toEqual([true, false])
    expect(records(h.writes).some((x) => x.kind === 'decision' && x.trigger?.event === 'plan-exit')).toBe(false)
  })

  test('an empty CLAUDE_CONFIG_DIR means the default folder, as in the command hook', async ($, on) => {
    const h = harness(on, setup('sig-empty', { env: { CLAUDE_CONFIG_DIR: '', HOME: '/home/u' } }))
    h.writes['/home/u/.claude/plugins/data/automode/signals/sig-empty.json'] = JSON.stringify({ seq: 1, permissionMode: 'plan', compactions: [] })
    await h.submit($, 'plan how to split the setup package')
    await h.step($)
    expect(planRecords(h.writes).map((x) => x.on)).toEqual([true])
  })

  // One harness per test: the engine's hooks register before the first call.
  const ignored = (name: string, extra: Record<string, any>) => test(`${name} ignores the file`, async ($, on) => {
    const id = `sig-off-${name.replace(/\W/g, '')}`
    const h = harness(on, setup(id, extra))
    h.writes[file(id)] = JSON.stringify({ seq: 1, permissionMode: 'plan', compactions: [{ at: 5, via: 'PostCompact:manual' }] })
    await h.submit($, 'plan how to split the setup package')
    await h.step($)
    expect([planRecords(h.writes).length, compactions(h.writes).length]).toEqual([0, 0])
  })
  ignored('AUTOMODE_SIGNALS=off', { env: { AUTOMODE_SIGNALS: 'off' } })
  ignored('shadow mode', { mode: 'shadow' })
  ignored('plain Sonnet', { model: 'claude-sonnet-5-5' })
})

// Claude Code 2.1.311 removes the [1m] suffix before a mod sees the model, so a model ID cannot turn AutoMode on.
// activation 'always' (the shipped default) starts AutoMode with the session, on whatever model the session runs.
describe('V4: activation always (the shipped default)', () => {
  test('a plain Sonnet session is routed: the judge runs and the decision is recorded', async ($, on) => {
    const h = harness(on, { model: 'claude-sonnet-5-5', policy: 'auto', mode: 'auto', config: { activation: 'always' }, judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }) })
    await h.submit($, 'where is the output folder written?')
    await h.step($)
    await h.complete($)
    expect(h.judged.length).toBe(1)
    expect(records(h.writes).some((x) => x.kind === 'decision')).toBe(true)
  })

  test('a session on any other model is routed too', async ($, on) => {
    const h = harness(on, { model: 'claude-opus-5-5', policy: 'auto', mode: 'auto', config: { activation: 'always' }, judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }) })
    await h.submit($, 'where is the output folder written?')
    expect(h.judged.length).toBe(1)
  })

  test('picker activation keeps the old rule: a plain Sonnet session stays untouched', async ($, on) => {
    const h = harness(on, { model: 'claude-sonnet-5-5', policy: 'auto', mode: 'auto', config: { activation: 'picker' }, judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }) })
    const out = await h.submit($, 'add retries to the uploader')
    await h.step($)
    expect(h.judged.length).toBe(0)
    expect(out.context.length).toBe(0)
    expect(records(h.writes).length).toBe(0)
  })

  test('picker activation still turns on for the AutoMode model ID', async ($, on) => {
    const h = harness(on, { model: 'claude-sonnet-5-5[1m]', policy: 'auto', mode: 'auto', config: { activation: 'picker' }, judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }) })
    await h.submit($, 'where is the output folder written?')
    expect(h.judged.length).toBe(1)
  })

  test('the kill switch and mode off still stop it, whatever the activation', async ($, on) => {
    const killed = harness(on, { model: 'claude-sonnet-5-5', mode: 'auto', config: { activation: 'always' }, env: { AUTOMODE_ROUTER: 'off' } })
    await killed.submit($, 'add retries')
    expect(killed.judged.length).toBe(0)
  })

  test('mode off in config stops it with activation always', async ($, on) => {
    const h = harness(on, { model: 'claude-sonnet-5-5', mode: 'off', config: { activation: 'always' } })
    const out = await h.submit($, 'add retries')
    expect(h.judged.length).toBe(0)
    expect(out.context.length).toBe(0)
  })
})

describe('V4: workflow entry', () => {
  const critical = judge({ tier: 'T3', complexity: 'complex', risk: 'critical', strategy: 'engineering-workflow', confidence: 0.9 })
  const ask = 'rebuild the payments ledger across the billing services'

  test('autoWorkflow off: a judged workflow runs direct, and the record says what entry would have done', async ($, on) => {
    const h = harness(on, { judge: critical })
    const out = await h.submit($, ask)
    expect(out.context.join('\n').includes('Run Workflow')).toBe(false)
    await h.step($)
    await h.complete($)
    const d = records(h.writes).find((x) => x.kind === 'decision')
    expect(d.strategy.chosen).toBe('direct')
    expect(d.workflow).toMatchObject({ purpose: null, would: true })
    expect(records(h.writes).filter((x) => x.kind === 'workflow-entry').length).toBe(0)
  })

  test('autoWorkflow on: the same prompt enters the workflow with the real args and next_action', async ($, on) => {
    const h = harness(on, { judge: critical, config: { autoWorkflow: true } })
    const out = await h.submit($, ask)
    const text = out.context.join('\n')
    expect(text.includes('Run Workflow')).toBe(true)
    expect(text.includes('"tier":"critical"')).toBe(true)
    expect(text.includes('next_action')).toBe(true)
  })

  test('am:run works with autoWorkflow off, and a workflow never called is recorded', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T2', complexity: 'standard' }) })
    const out = await h.submit($, 'am:run add retries to the uploader')
    expect(out.context.join('\n').includes('Run Workflow')).toBe(true)
    expect(out.context.join('\n').includes('"tier":"complex"')).toBe(true)
    await h.step($)
    await h.complete($)
    expect(records(h.writes).find((x) => x.kind === 'workflow-entry')).toMatchObject({ source: 'user', called: false })
  })

  test('a chosen workflow that the main session calls is recorded as called', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T2', complexity: 'standard' }) })
    await h.submit($, 'am:run add retries to the uploader')
    await h.step($)
    await $.tool.call({ tool: 'Workflow', name: 'automode:run' } as never)
    await h.complete($)
    expect(records(h.writes).find((x) => x.kind === 'workflow-entry')).toMatchObject({ source: 'user', called: true })
  })
})

describe('V4: workflow calls that do not count', () => {
  test('another workflow, by tool call or by its agents, leaves the chosen one uncalled', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T2', complexity: 'standard' }) })
    await h.submit($, 'am:run add retries to the uploader')
    await h.step($)
    await $.tool.call({ tool: 'Workflow', name: 'other:flow' } as never)
    await $.agent.spawn({ subagentType: 'other:worker', prompt: 'x', description: 'x', model: 'sonnet', workflow: { runId: 'r1', agentIndex: 0 } } as never)
    await h.complete($)
    expect(records(h.writes).find((x) => x.kind === 'workflow-entry')).toMatchObject({ called: false })
  })

  test('an agent of this workflow counts as called', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T2', complexity: 'standard' }) })
    await h.submit($, 'am:run add retries to the uploader')
    await h.step($)
    await $.agent.spawn({ subagentType: 'automode:explorer', prompt: 'x', description: 'x', model: 'haiku', workflow: { runId: 'r1', agentIndex: 0 } } as never)
    await h.complete($)
    expect(records(h.writes).find((x) => x.kind === 'workflow-entry')).toMatchObject({ called: true })
  })
})

describe('V4: subagents take the task risk', () => {
  const risky = judge({ tier: 'T2', complexity: 'standard', risk: 'critical' })

  test('critical work: a general-purpose agent keeps the Opus parent unless it only reads', async ($, on) => {
    const h = harness(on, { policy: 'legacy', judge: risky })
    await h.submit($, 'rotate the signing keys for session tokens')
    await $.agent.spawn({ subagentType: 'general-purpose', prompt: 'fix the token check', description: 'x', parentModel: 'claude-opus-5-5' })
    expect(h.spawned.at(-1)?.model).toBe('opus')
    await $.agent.spawn({ subagentType: 'general-purpose', prompt: 'map the call sites', description: 'x', parentModel: 'claude-opus-5-5' })
    expect(h.spawned.at(-1)?.model).toBe('sonnet')
  })

  test('policy auto: a failed helper judge falls back to the policy effort, not to medium', async ($, on) => {
    const h = harness(on, { policy: 'auto', judge: risky, effortJudge: (p: string) => (p.includes('fix the token check') ? null : says('sonnet', 'high')(p)) })
    await h.submit($, 'rotate the signing keys for session tokens')
    const res = await $.agent.spawn({ subagentType: 'general-purpose', prompt: 'fix the token check', description: 'x', parentModel: 'claude-opus-5-5' })
    await h.step($, 'claude-opus-5-5', res.agentId, { turnId: 'a1' })
    expect(h.steps.at(-1)?.effort).toBe('high')
  })

  test('a diagnoser spawn on risky work runs on Sonnet and keeps its read-only guard', async ($, on) => {
    const h = harness(on, { policy: 'legacy', judge: risky })
    await h.submit($, 'rotate the signing keys for session tokens')
    const res = await $.agent.spawn({ subagentType: 'automode:diagnoser', prompt: 'why did it fail', description: 'x', parentModel: 'claude-opus-5-5' })
    expect(h.spawned.at(-1)?.model).toBe('sonnet')
    const denied = await $.tool.call({ tool: 'Write', file_path: 'a.go', content: 'x', agentId: res.agentId } as never)
    expect(String((denied as any).deny ?? '').includes('read-only')).toBe(true)
  })

  test('the main session asks for a diagnoser on risky work: the Agent call goes out on Sonnet', async ($, on) => {
    const h = harness(on, { policy: 'legacy', judge: risky })
    await h.submit($, 'rotate the signing keys for session tokens')
    await $.tool.call({ tool: 'Agent', subagent_type: 'automode:diagnoser', prompt: 'why', description: 'x' } as never)
    expect(h.spawned.at(-1)).toEqual({ subagentType: 'automode:diagnoser', model: 'sonnet' })
  })

  test('no risk: the diagnoser stays on Haiku', async ($, on) => {
    const h = harness(on, { policy: 'legacy', judge: judge({ tier: 'T1', complexity: 'standard', risk: 'none' }) })
    await h.submit($, 'tidy the helper names')
    await $.tool.call({ tool: 'Agent', subagent_type: 'automode:diagnoser', prompt: 'why', description: 'x' } as never)
    expect(h.spawned.at(-1)).toEqual({ subagentType: 'automode:diagnoser', model: 'haiku' })
  })
})
