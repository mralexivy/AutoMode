// Tests for scripts/am-usage.mjs --trace on fixture transcripts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const USAGE = path.join(ROOT, 'scripts', 'am-usage.mjs')

const line = (id, model, usage, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, usage, content: [{ type: 'text', text: 'SECRET PROMPT TEXT' }] } })

function fixture() {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'am-usage-'))
  const proj = path.join(config, 'projects', 'p')
  const sid = '11111111-2222-3333-4444-555555555555'
  const sub = path.join(proj, sid, 'subagents', 'workflows', 'wf_1')
  fs.mkdirSync(sub, { recursive: true })
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), [
    line('m1', 'claude-sonnet-5-5', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }, '2026-10-19T10:00:00Z'),
    line('m1', 'claude-sonnet-5-5', { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }, '2026-10-19T10:00:04Z'),
  ].join('\n'))
  // A subagent whose usage reports no cache fields at all.
  fs.writeFileSync(path.join(sub, 'agent-a.jsonl'), line('m2', 'claude-opus-5-5', { input_tokens: 3, output_tokens: 1000 }, '2026-10-19T10:00:10Z'))
  fs.writeFileSync(path.join(sub, 'agent-a.meta.json'), JSON.stringify({ agentType: 'automode:architect', workflowPhase: 'Plan', description: 'plan' }))
  return { config, sid }
}

test('--trace --json gives one row per transcript with stage, role, and nulls for missing fields', () => {
  const { config, sid } = fixture()
  const r = spawnSync(process.execPath, [USAGE, sid, '--trace', '--json'], { env: { ...process.env, CLAUDE_CONFIG_DIR: config }, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const report = JSON.parse(r.stdout)
  assert.equal(report.trace.length, 2)
  const main = report.trace.find((t) => t.stage === 'main')
  assert.equal(main.calls, 1, 'streamed lines with one message id count once')
  assert.equal(main.output, 7)
  assert.equal(main.cache_read, 100)
  assert.equal(main.duration_s, 4)
  const plan = report.trace.find((t) => t.stage === 'Plan')
  assert.equal(plan.role, 'automode:architect')
  assert.equal(plan.label, 'plan')
  assert.equal(plan.cache_read, null, 'unknown, never a fabricated 0')
  assert.equal(plan.cache_write, null)
  assert.ok(plan.est_usd > 0)
  assert.doesNotMatch(r.stdout, /SECRET PROMPT TEXT/, 'no prompt or message text in the report')
})

test('--trace text output marks unknown values', () => {
  const { config, sid } = fixture()
  const r = spawnSync(process.execPath, [USAGE, sid, '--trace'], { env: { ...process.env, CLAUDE_CONFIG_DIR: config }, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /\| Plan \| automode:architect \| plan \| claude-opus-5-5 \| 1 \| 3 \| 1,000 \| unknown \| unknown \|/)
})

test('--routes: per-request routes with transcript confirmation, no prompt text', () => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'am-routes-'))
  const sid = '99999999-2222-3333-4444-555555555555'
  const proj = path.join(config, 'projects', 'p')
  const data = path.join(config, 'plugins', 'data', 'automode')
  fs.mkdirSync(proj, { recursive: true })
  fs.mkdirSync(data, { recursive: true })
  const apiReq = (model, effort) => JSON.stringify({ type: 'api-request', params: { model, output_config: { effort } } })
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), [apiReq('claude-haiku-5-5', 'low'), apiReq('claude-sonnet-5-5', 'high'), apiReq('claude-sonnet-5-5', 'medium')].join('\n'))
  const req = (i, model, effort, appEffort, thinking) => ({ v: 1, kind: 'request', sessionId: sid, turnId: `t${i}`, index: 0, taskId: 'x', app: { model: 'claude-sonnet-5-5[1m]', effort: appEffort }, sent: { model, effort }, owner: 'judge', effortApplied: true, effortWhy: 'shared', answered: { model, thinking }, usage: { input: 1, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, usd: { value: 0.001, basis: 'measured', source: 't' } })
  fs.writeFileSync(path.join(data, 'decisions.jsonl'), [
    req(0, 'claude-haiku-5-5', 'low', null, 0), req(1, 'claude-sonnet-5-5', 'high', 'medium', 40), req(2, 'claude-sonnet-5-5', 'medium', 'medium', null),
    { v: 1, kind: 'decision', sessionId: sid, effective: { model: 'claude-sonnet-5-5', effort: 'medium', owner: 'judge', reason: 'r', check: { verdict: 'switch' } }, strategy: { chosen: 'direct', basis: 'estimate', estimates: [{ strategy: 'direct', p50: 0.1, p75: 0.1 }] } },
    { v: 1, kind: 'escalation', sessionId: sid, action: 'consult-opus', via: 'architect' },
    // Policy section: one prompt where the other policy differs, one inadequate route, a cancel and a counted failure.
    { v: 1, kind: 'decision', point: 'prompt', policy: 'legacy', sessionId: sid, effective: { model: 'claude-opus-5-5', effort: 'xhigh', owner: 'judge', reason: 'r' }, compare: { policy: 'v4.1', route: 'opus/high', band: 3 }, override: { source: 'typed-command', scope: 'turn' }, transition: 'repository', inadequate: { need: 3, shortfall: 1, route: 'sonnet/high' } },
    { v: 1, kind: 'provider-failure', sessionId: sid, model: 'claude-opus-5-5', family: 'opus', class: 'user-cancel', breaker: 'ignored' },
    { v: 1, kind: 'provider-failure', sessionId: sid, model: 'claude-opus-5-5', family: 'opus', class: 'no-response', breaker: 'counting' },
    { v: 1, kind: 'interrupt', sessionId: sid, undone: true },
    { v: 1, kind: 'provider-error', sessionId: sid, class: 'rate_limit', action: 'breaker' },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n')
  const r = spawnSync(process.execPath, [USAGE, sid, '--routes', '--json'], { env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_DATA: '' }, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const rep = JSON.parse(r.stdout)
  assert.equal(rep.requests, 3)
  assert.deepEqual(rep.confirmation[0], { sessionId: sid, checked: 3, confirmed: 3, mismatched: 0, file: `${sid}.jsonl` })
  assert.equal(rep.byRoute['sonnet-5-5/high'].effortChanged, 1)
  assert.equal(rep.byRoute['haiku-5-5/low'].thinkingKnown, 1)
  assert.equal(rep.escalations['consult-opus via architect'], 1)
  assert.deepEqual(rep.policy.active, { legacy: 2 }, 'the older fixture decision has no point: it counts as a prompt decision')
  assert.deepEqual([rep.policy.compared, rep.policy.differ, rep.policy.xhighOrMax, rep.policy.inadequate, rep.policy.interruptsUndone], [1, 1, { active: 1, other: 0 }, 1, 1])
  assert.deepEqual(rep.policy.providerFailures.byClass, { 'user-cancel': 1, 'no-response': 1 })
  assert.deepEqual(rep.policy.overrides, { 'typed-command': 1 })
  assert.deepEqual(rep.policy.providerFailures.classified, { 'rate_limit -> breaker': 1 })
  assert.equal(rep.policy.alert, null, 'an alert needs at least 10 compared prompts')
  const text = spawnSync(process.execPath, [USAGE, sid, '--routes'], { env: { ...process.env, CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_DATA: '' }, encoding: 'utf8' }).stdout
  assert.match(text, /3\/3 main requests match/)
  assert.match(text, /not observable/)
  assert.match(text, /Policy: legacy 2; the other policy is recorded beside it on 1 prompts and differs on 1/)
  assert.match(text, /Inadequate routes \(no available model met the need\): 1/)
})
