// Tests for workflows/run.js. The test runs the script body with mocked workflow globals
// (agent, parallel, phase, log), so no model is called.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { workflowArgs } from '../hooks/lib/stages.ts'
import { demandOf } from '../hooks/lib/optimizer.ts'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SRC = fs.readFileSync(path.join(ROOT, 'workflows', 'run.js'), 'utf8').replace('export const meta', 'const meta')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const script = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', SRC)

const ws = (id, files, depends_on = []) => ({ id, goal: id, files, steps: ['do it'], tests: [], depends_on })
const PLAN = (over = {}) => ({
  summary: 'add retries', complexity_check: 'standard', risk_class: 'S1', decisions: ['wrap the call'], assumptions: [],
  forbidden_changes: [], missing_evidence: [], evidence_blocking: false, workstreams: [ws('main', ['src/upload.go'])],
  acceptance_criteria: ['retries 3 times'], validation_commands: ['go test ./...'], risks: [], review_required: false, ...over,
})
const NO_ESC = { needed: false, question: '', evidence: [] }
const IMPL = (id, over = {}) => ({ id, status: 'done', files_changed: ['src/upload.go'], tests_added: [], commands_run: [], deviations: [], unresolved: [], escalation: NO_ESC, notes: 'great work', ...over })
const CHECK = (outcome, exit_code = outcome === 'fail' ? 1 : 0) => ({ cmd: 'go test ./...', exit_code, outcome, failure_summary: '' })
const VERIFY = (checks, status = 'pass') => ({ status, checks, fixes_made: [], regressions: [], remaining_failures: [], diff_stat: '' })
const PASS = VERIFY([CHECK('pass')])
const FAIL = VERIFY([CHECK('fail')], 'fail')
const REVIEW = { verdict: 'approve', findings: [] }
const finding = (where, what = 'x') => ({ where, what, confidence: 'high' })
const DISC = (files = ['src/upload.go:10', 'src/upload_test.go:5'], over = {}) =>
  ({ findings: files.map((f) => finding(f)), interfaces: ['Uploader'], tests: [], commands: ['go test ./...'], constraints: [], open_questions: [], ...over })

// run executes the workflow. `answer(role, opts, prompt)` returns each agent's result.
async function run(args, answer) {
  const calls = []
  const agent = async (prompt, opts) => {
    const role = opts.agentType.split(':')[1]
    calls.push({ role, model: opts.model, effort: opts.effort, label: opts.label, prompt })
    return answer(role, opts, prompt, calls)
  }
  const parallel = (fns) => Promise.all(fns.map((f) => f()))
  const result = await script(args, agent, parallel, () => {}, () => {})
  return { result, calls }
}
const defaults = (over = {}) => (role, opts) => {
  if (over[role] !== undefined) return typeof over[role] === 'function' ? over[role](opts) : over[role]
  return { explorer: DISC(), architect: opts.label?.startsWith('escalate') ? { answer: 'use v2', plan_changes: [], stop: false, stop_reason: '' } : PLAN(), implementer: IMPL('main'), verifier: PASS, reviewer: REVIEW }[role]
}
const seq = (calls) => calls.map((c) => `${c.role}/${c.model}`)

test('every role runs its pinned model and effort; no agent runs below medium', async () => {
  const { calls } = await run({ task: 'add retries to the uploader', reviewPolicy: 'always' }, defaults())
  const pairs = Object.fromEntries(calls.map((c) => [c.role, `${c.model}/${c.effort}`]))
  assert.deepEqual(pairs, { explorer: 'haiku/medium', architect: 'opus/high', implementer: 'sonnet/high', verifier: 'sonnet/medium', reviewer: 'opus/high' })
  const { calls: small } = await run({ task: 'add retries to the uploader', sonnetPlanSmall: true }, defaults())
  assert.equal(small.find((c) => c.label === 'plan').effort, 'high', 'the Sonnet planner')
  assert.ok([...calls, ...small].every((c) => c.effort !== 'low'))
})

test('default: S1 plans on Opus even for a small change', async () => {
  const { calls } = await run({ task: 'add retries to the uploader', reviewPolicy: 'risk' }, defaults())
  assert.equal(calls.find((c) => c.label === 'plan').model, 'opus')
})

test('opt-in sonnetPlanSmall, risk policy, small clean change: no Opus call at all', async () => {
  const { result, calls } = await run({ task: 'add retries to the uploader', reviewPolicy: 'risk', sonnetPlanSmall: true }, defaults())
  assert.equal(result.band, 'S1')
  assert.deepEqual(seq(calls), ['explorer/haiku', 'architect/sonnet', 'implementer/sonnet', 'verifier/sonnet'])
  assert.equal(result.review.verdict, 'skipped')
})

test('S1, always policy: one Opus review', async () => {
  const { result, calls } = await run({ task: 'add retries to the uploader', reviewPolicy: 'always' }, defaults())
  assert.ok(calls.some((c) => c.role === 'reviewer' && c.model === 'opus'))
  assert.deepEqual(result.review_reasons, ['policy always'])
})

test('opt-in sonnetPlanSmall still uses Opus for more than 2 files or open questions', async () => {
  const many = await run({ task: 'add retries', sonnetPlanSmall: true }, defaults({ explorer: DISC(['a/x.go:1', 'b/y.go:1', 'c/z.go:1']) }))
  assert.equal(many.calls.find((c) => c.label === 'plan').model, 'opus')
  const unsure = await run({ task: 'add retries', sonnetPlanSmall: true }, defaults({ explorer: DISC(undefined, { open_questions: ['which client?'] }) }))
  assert.equal(unsure.calls.find((c) => c.label === 'plan').model, 'opus')
})

test('security wording in the task raises to S3 with mandatory review, even on risk policy', async () => {
  const { result, calls } = await run({ task: 'rotate the OAuth token on expiry', reviewPolicy: 'risk' }, defaults())
  assert.equal(result.band, 'S3')
  assert.equal(calls.find((c) => c.label === 'plan').model, 'opus')
  assert.ok(result.review_reasons.includes('band S3'))
  assert.equal(calls.filter((c) => c.role === 'explorer').length, 3, 'S3 uses 3 disjoint lenses')
})

test('a migration path in the plan raises the band after planning', async () => {
  const { result } = await run({ task: 'add a column', reviewPolicy: 'risk' },
    defaults({ architect: PLAN({ workstreams: [ws('m', ['db/migrations/0042_add.sql'])] }) }))
  assert.equal(result.band, 'S3')
  assert.ok(result.band_reasons.some((r) => r.includes('migration')))
})

test('the band never goes down', async () => {
  const { result } = await run({ task: 'change the README wording', tier: 'critical' }, defaults({ architect: PLAN({ risk_class: 'S0' }) }))
  assert.equal(result.band, 'S3')
})

test('trivial tier is S0: no discovery, Sonnet plans, no review', async () => {
  const { result, calls } = await run({ task: 'fix the typo in the README', tier: 'trivial', reviewPolicy: 'always' }, defaults({ architect: PLAN({ risk_class: 'S0' }) }))
  assert.equal(result.band, 'S0')
  assert.deepEqual(seq(calls), ['architect/sonnet', 'implementer/sonnet', 'verifier/sonnet'])
})

test('handoff mode: no explorer, the architect reads files itself', async () => {
  const { result, calls } = await run({ task: 'add retries in src/upload.go', mode: 'handoff' }, defaults())
  assert.equal(result.mode, 'handoff')
  assert.ok(!calls.some((c) => c.role === 'explorer'))
  assert.match(calls.find((c) => c.label === 'plan').prompt, /No discovery ran/)
})

test('large discovery: valid JSON, constraints kept, omitted findings listed by pointer', async () => {
  const big = () => ({
    findings: Array.from({ length: 25 }, (_, i) => finding(`src/f${i}.go:${i}`, 'y'.repeat(400))),
    interfaces: [], tests: [], commands: [], open_questions: [],
    constraints: ['MUST keep the v1 wire format'],
  })
  const { result, calls } = await run({ task: 'refactor', tier: 'complex' }, defaults({ explorer: big }))
  const prompt = calls.find((c) => c.label === 'plan').prompt
  const json = prompt.split('Discovery summaries (JSON, from read-only Haiku agents):\n')[1].split('\n\n')[0]
  assert.ok(json.length <= 24000)
  const parsed = JSON.parse(json)
  for (const lens of ['code', 'tests', 'constraints']) assert.deepEqual(parsed[lens].constraints, ['MUST keep the v1 wire format'])
  assert.ok(parsed.code.findings[0].what.length <= 300)
  assert.match(prompt, /Findings left out point at: src\/f\d+\.go:\d+/)
  assert.ok(result.notes.some((n) => n.includes('constraints are dropped last')))
})

test('missing evidence: exactly one targeted discovery and one re-plan', async () => {
  let plans = 0
  const { result, calls } = await run({ task: 'add retries' }, defaults({
    architect: () => (++plans === 1 ? PLAN({ missing_evidence: ['which HTTP client?'], evidence_blocking: true }) : PLAN()),
    planner: undefined,
  }))
  assert.equal(calls.filter((c) => c.label === 'discover:missing-evidence').length, 1)
  assert.equal(calls.filter((c) => c.label?.startsWith('plan')).length, 2)
  assert.equal(result.evidence_incomplete, false)
})

test('evidence still missing after one round: flagged, and review becomes mandatory', async () => {
  const { result, calls } = await run({ task: 'add retries', reviewPolicy: 'risk' },
    defaults({ architect: PLAN({ missing_evidence: ['which HTTP client?'], evidence_blocking: true }) }))
  assert.equal(calls.filter((c) => c.label === 'discover:missing-evidence').length, 1, 'never a loop')
  assert.equal(result.evidence_incomplete, true)
  assert.ok(result.review_reasons.includes('plan evidence incomplete'))
})

test('non-blocking missing evidence: no re-plan, the gaps go to the reviewer', async () => {
  const { result, calls } = await run({ task: 'add retries', reviewPolicy: 'always' },
    defaults({ architect: PLAN({ missing_evidence: ['retry backoff base?'], evidence_blocking: false }) }))
  assert.equal(calls.filter((c) => c.label === 'discover:missing-evidence').length, 0)
  assert.equal(calls.filter((c) => c.label?.startsWith('plan')).length, 1)
  assert.equal(result.evidence_incomplete, false)
  assert.match(calls.find((c) => c.role === 'reviewer').prompt, /could not establish[\s\S]*retry backoff base/)
})

test('verification: a failing check beats a "pass" narrative', async () => {
  const lying = VERIFY([CHECK('fail')], 'pass')
  const { result, calls } = await run({ task: 'add retries', reviewPolicy: 'risk' }, defaults({ verifier: lying }))
  assert.equal(result.verification.result, 'fail')
  assert.equal(calls.filter((c) => c.role === 'verifier').length, 2)
  assert.ok(result.review_reasons.includes('verification fail'))
  assert.ok(result.notes.some((n) => n.includes('The checks win')))
})

const check = (cmd, exit_code, outcome, over = {}) => ({ cmd, exit_code, outcome, failure_summary: '', ...over })
const verdict = async (c) => (await run({ task: 'add retries' }, defaults({ verifier: VERIFY([check('go test ./...', 0, 'pass'), c]) }))).result.verification.result

test('verification: a grep that must find nothing passes on exit 1 when it expects 1', async () => {
  const { result, calls } = await run({ task: 'add retries' }, defaults({ verifier: VERIFY([check('grep -rn oldName src', 1, 'pass', { expected_exit: 1 })]) }))
  assert.equal(result.verification.result, 'pass')
  assert.equal(calls.filter((c) => c.role === 'verifier').length, 1, 'no second verify round')
})

test('verification: expected_exit is an exact match, so grep exit 2 (an error) and a found match both fail', async () => {
  assert.equal(await verdict(check('grep -rn oldName src', 2, 'pass', { expected_exit: 1 })), 'fail')
  assert.equal(await verdict(check('grep -rn oldName src', 0, 'pass', { expected_exit: 1 })), 'fail')
})

test('verification: expected_exit counts only for one plain grep, rg or diff', async () => {
  for (const cmd of ['npm test', 'go test ./...', 'make', 'grep -q x a && npm test', 'grep x a; npm test', 'grep x a | wc -l', 'npm test | grep ok']) {
    assert.equal(await verdict(check(cmd, 1, 'pass', { expected_exit: 1 })), 'fail', cmd)
  }
  for (const cmd of ['rg oldName src', 'diff a b', "grep -E 'old|older' src/a.go"]) {
    assert.equal(await verdict(check(cmd, 1, 'pass', { expected_exit: 1 })), 'pass', cmd)
  }
  assert.equal(await verdict(check('grep x a', 2, 'pass', { expected_exit: 2 })), 'fail', 'exit 2 is a grep error')
})

test('verification: without expected_exit the default is 0, so any nonzero exit fails', async () => {
  assert.equal(await verdict(check('make test', 2, 'pass')), 'fail')
  assert.equal(await verdict(check('grep -rn oldName src', 1, 'pass')), 'fail')
})

test('verification: outcome "fail" beats a matching expected_exit', async () => {
  assert.equal(await verdict(check('grep -rn oldName src', 1, 'fail', { expected_exit: 1 })), 'fail')
})

test('verification: `! grep` passes on 0 and fails on 1', async () => {
  assert.equal(await verdict(check('! grep -rn oldName src', 0, 'pass')), 'pass')
  assert.equal(await verdict(check('! grep -rn oldName src', 1, 'fail')), 'fail')
})

test('verification: a skipped check with a nonzero exit does not fail the run', async () => {
  assert.equal(await verdict(check('make slow', 1, 'skipped')), 'pass')
})

test('verification: the verifier hears about expected_exit', async () => {
  const { calls } = await run({ task: 'add retries' }, defaults())
  assert.match(calls.find((c) => c.role === 'verifier').prompt, /expected_exit/)
})

test('verification: no checks is unverified and forces review', async () => {
  const { result } = await run({ task: 'add retries', reviewPolicy: 'risk' }, defaults({ verifier: VERIFY([]) }))
  assert.equal(result.verification.result, 'unverified')
  assert.ok(result.review_reasons.includes('verification unverified'))
})

test('verification: pre-existing failures do not fail the change', async () => {
  const { result } = await run({ task: 'add retries' }, defaults({ verifier: VERIFY([CHECK('pass'), CHECK('pre-existing', 1)]) }))
  assert.equal(result.verification.result, 'pass')
})

test('review input is evidence-first: no implementer notes', async () => {
  const { calls } = await run({ task: 'add retries', reviewPolicy: 'always' }, defaults())
  const p = calls.find((c) => c.role === 'reviewer').prompt
  assert.match(p, /Original task:\nadd retries/)
  assert.match(p, /Verification checks, as run/)
  assert.doesNotMatch(p, /great work/)
})

test('task graph: dependencies order the build, shared files never run together', async () => {
  const plan = PLAN({ workstreams: [ws('a', ['x.go']), ws('b', ['y.go'], ['a']), ws('c', ['x.go'])] })
  const { result, calls } = await run({ task: 'refactor', tier: 'complex', maxConcurrency: 2 },
    defaults({ architect: plan, implementer: (o) => IMPL(o.label.split(':')[1]) }))
  const order = calls.filter((c) => c.role === 'implementer').map((c) => c.label)
  assert.deepEqual(order, ['build:a', 'build:b', 'build:c'])
  assert.ok(result.build.every((b) => b.status === 'done'))
})

test('task graph: concurrency is capped at 2', async () => {
  let live = 0, peak = 0
  const plan = PLAN({ workstreams: ['a', 'b', 'c', 'd'].map((id) => ws(id, [`${id}.go`])) })
  await run({ task: 'refactor', tier: 'complex', maxConcurrency: 9 }, defaults({
    architect: plan,
    implementer: async (o) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return IMPL(o.label.split(':')[1]) },
  }))
  assert.equal(peak, 2)
})

test('task graph: a failed workstream skips its dependents and forces review', async () => {
  const plan = PLAN({ workstreams: [ws('a', ['x.go']), ws('b', ['y.go'], ['a']), ws('c', ['z.go'], ['b'])] })
  const { result, calls } = await run({ task: 'refactor', reviewPolicy: 'risk' }, defaults({
    architect: plan,
    implementer: (o) => (o.label === 'build:a' ? IMPL('a', { status: 'blocked', unresolved: ['no API'] }) : IMPL(o.label.split(':')[1])),
  }))
  assert.deepEqual(result.build.map((b) => b.status), ['failed', 'skipped', 'skipped'])
  assert.match(result.build[1].stop_reason, /dependency a failed/)
  assert.ok(!calls.some((c) => c.label === 'build:b'))
  assert.ok(result.review_reasons.includes('a workstream did not finish'))
})

test('task graph: a dependency cycle is skipped, not run', async () => {
  const plan = PLAN({ workstreams: [ws('a', ['x.go'], ['b']), ws('b', ['y.go'], ['a'])] })
  const { result, calls } = await run({ task: 'refactor' }, defaults({ architect: plan }))
  assert.ok(!calls.some((c) => c.role === 'implementer'))
  assert.deepEqual(result.build.map((b) => b.stop_reason), ['dependency cycle', 'dependency cycle'])
})

test('task graph off (ablation): plan order, one at a time', async () => {
  const plan = PLAN({ workstreams: [ws('b', ['y.go'], ['a']), ws('a', ['x.go'])] })
  const { calls } = await run({ task: 'refactor', dag: false }, defaults({ architect: plan, implementer: (o) => IMPL(o.label.split(':')[1]) }))
  assert.deepEqual(calls.filter((c) => c.role === 'implementer').map((c) => c.label), ['build:b', 'build:a'])
})

test('escalation: one Opus answer, one rerun, and review becomes mandatory', async () => {
  let n = 0
  const { result, calls } = await run({ task: 'add retries', reviewPolicy: 'risk' }, defaults({
    implementer: () => (++n === 1 ? IMPL('main', { escalation: { needed: true, question: 'v1 or v2 client?', evidence: ['a.go:1'] } }) : IMPL('main')),
  }))
  assert.ok(calls.some((c) => c.label === 'escalate:main' && c.model === 'opus'))
  assert.ok(calls.some((c) => c.label === 'build:main:after-escalation'))
  assert.equal(result.build[0].status, 'done')
  assert.ok(result.review_reasons.some((r) => r.includes('escalated')))
})

test('escalation: the architect can stop a workstream', async () => {
  const { result } = await run({ task: 'add retries' }, defaults({
    implementer: IMPL('main', { escalation: { needed: true, question: 'drop the table?', evidence: [] } }),
    architect: (o) => (o.label.startsWith('escalate') ? { answer: '', plan_changes: [], stop: true, stop_reason: 'destructive' } : PLAN()),
  }))
  assert.equal(result.build[0].status, 'failed')
  assert.match(result.build[0].stop_reason, /destructive/)
})

test('escalation: at most 2 per run', async () => {
  const plan = PLAN({ workstreams: ['a', 'b', 'c'].map((id) => ws(id, [`${id}.go`])) })
  const esc = (id) => IMPL(id, { escalation: { needed: true, question: `q ${id}`, evidence: [] } })
  const { result, calls } = await run({ task: 'refactor' }, defaults({
    architect: (o) => (o.label.startsWith('escalate') ? { answer: 'a', plan_changes: [], stop: false, stop_reason: '' } : plan),
    implementer: (o) => (o.label.endsWith('after-escalation') ? IMPL(o.label.split(':')[1]) : esc(o.label.split(':')[1])),
  }))
  assert.equal(calls.filter((c) => c.label.startsWith('escalate')).length, 2)
  assert.match(result.build[2].stop_reason, /escalation limit/)
})

test('a null agent result is retried once and traced', async () => {
  let n = 0
  const { result } = await run({ task: 'add retries' }, defaults({ explorer: () => (++n === 1 ? null : DISC()) }))
  const ex = result.trace.filter((t) => t.role === 'explorer')
  assert.deepEqual(ex.map((t) => t.status), ['null_result', 'ok'])
  assert.equal(ex[1].retry_reason, 'null_result')
  assert.equal(ex[0].artifact_hash, null)
  assert.match(ex[1].artifact_hash, /^[0-9a-f]{8}$/)
})

test('fail-open: failed explorers switch to handoff, a failed Opus plan falls back to Sonnet with mandatory review', async () => {
  const { result, calls } = await run({ task: 'add retries', reviewPolicy: 'risk' }, defaults({
    explorer: null,
    architect: (o) => (o.model === 'opus' ? null : PLAN()),
  }))
  assert.equal(result.mode, 'handoff')
  assert.ok(calls.some((c) => c.label === 'plan:fallback' && c.model === 'sonnet'))
  assert.ok(result.review_reasons.includes('Opus plan unavailable'))
})

test('no plan at all: the workflow stops and changes nothing', async () => {
  const { result, calls } = await run({ task: 'add retries' }, defaults({ architect: null }))
  assert.match(result.error, /no planning call returned a plan/)
  assert.ok(!calls.some((c) => c.role === 'implementer'))
})

test('trace: one record per attempt with the required fields', async () => {
  const { result } = await run({ task: 'add retries', source_version: '1.0.0+abc', task_id: 't-1' }, defaults())
  assert.ok(result.trace.length >= 4)
  for (const t of result.trace) {
    for (const k of ['workflow_id', 'task_id', 'seq', 'stage', 'role', 'model_id', 'label', 'status', 'retry_reason', 'schema_version', 'artifact_hash', 'band', 'review_policy', 'source_version']) {
      assert.ok(k in t, `trace field ${k}`)
    }
    assert.equal(t.task_id, 't-1')
    assert.equal(t.source_version, '1.0.0+abc')
  }
  assert.ok(!('elapsed_ms' in result.trace[0]), 'scripts have no clock; durations come from am-usage')
})

test('trace: every record names its effort', async () => {
  const { result } = await run({ task: 'add retries', reviewPolicy: 'always' }, defaults())
  assert.deepEqual(Object.fromEntries(result.trace.map((t) => [t.role, t.effort])), { explorer: 'medium', architect: 'high', implementer: 'high', verifier: 'medium', reviewer: 'high' })
})

test('planModel and reviewModel: defaults stay Opus, a bad value is ignored', async () => {
  const { calls } = await run({ task: 'add retries', reviewPolicy: 'always', planModel: 'gpt', reviewModel: 'haiku' }, defaults())
  assert.equal(calls.find((c) => c.label === 'plan').model, 'opus')
  assert.equal(calls.find((c) => c.role === 'reviewer').model, 'opus')
})

test('planModel and reviewModel: Sonnet below S3, and the trace records the model that ran', async () => {
  const { result, calls } = await run({ task: 'add retries', reviewPolicy: 'always', planModel: 'sonnet', reviewModel: 'sonnet' }, defaults())
  assert.equal(calls.find((c) => c.label === 'plan').model, 'sonnet')
  assert.equal(calls.find((c) => c.role === 'reviewer').model, 'sonnet')
  assert.equal(result.trace.find((t) => t.role === 'reviewer').model_id, 'sonnet')
})

test('planModel and reviewModel: S3 and escalations stay on Opus', async () => {
  const s3 = await run({ task: 'rotate the OAuth token on expiry', planModel: 'sonnet', reviewModel: 'sonnet' }, defaults())
  assert.equal(s3.calls.find((c) => c.label === 'plan').model, 'opus')
  assert.equal(s3.calls.find((c) => c.role === 'reviewer').model, 'opus')
  let n = 0
  const esc = await run({ task: 'add retries', planModel: 'sonnet' }, defaults({
    implementer: () => (++n === 1 ? IMPL('main', { escalation: { needed: true, question: 'v1 or v2?', evidence: [] } }) : IMPL('main')),
  }))
  assert.equal(esc.calls.find((c) => c.label === 'escalate:main').model, 'opus')
})

test('missing task returns an error', async () => {
  const { result } = await run({}, defaults())
  assert.match(result.error, /args.task is required/)
})

// The router's own args, built by the function that writes them into the header.
const routerArgs = (over = {}) => ({
  ...workflowArgs({
    demand: demandOf({ tier: 'T2', complexity: 'standard', risk: 'none', confidence: 0.9 }), userAsked: false, risk: 'none', complexity: 'standard',
    reviewRequired: false, mode: 'discover', reviewPolicy: 'risk', maxConcurrency: 1, ...over,
  }),
  task: 'add retries to the uploader',
})

test('router args: a bounded task sends its real tier, and stages leave out discovery', () => {
  const a = routerArgs()
  assert.equal(a.tier, 'standard')
  assert.equal(a.mode, 'discover', 'the router still sends mode')
  assert.deepEqual(a.stages, ['implement', 'verify'])
  assert.equal(routerArgs({ risk: 'critical', complexity: 'complex' }).tier, 'critical')
  assert.equal(routerArgs({ risk: 'none', complexity: 'trivial' }).tier, 'trivial')
})

test('router args: am:run never runs below complex, and elevated risk never runs as trivial', () => {
  assert.equal(routerArgs({ risk: 'elevated', complexity: 'trivial' }).tier, 'standard')
  assert.equal(routerArgs({ userAsked: true, complexity: 'trivial' }).tier, 'complex')
  assert.equal(routerArgs({ userAsked: true, complexity: 'standard' }).tier, 'complex')
  assert.equal(routerArgs({ userAsked: true, risk: 'critical', complexity: 'standard' }).tier, 'critical')
})

test('router args: a required review is in the stages, with policy always', () => {
  const a = routerArgs({ reviewRequired: true })
  assert.ok(a.stages.includes('review'))
  assert.equal(a.reviewPolicy, 'always')
  assert.equal(routerArgs({ demand: null }).stages, undefined, 'no demand: the full workflow')
})

test('router args: stages win over mode, so the left-out stages really do not run', async () => {
  const { result, calls } = await run(routerArgs(), defaults())
  assert.deepEqual(seq(calls), ['architect/sonnet', 'implementer/sonnet', 'verifier/sonnet'])
  assert.equal(result.mode, 'handoff')
  assert.equal(result.review.verdict, 'skipped')
})

test('router args: stages with discover win over a handoff mode', async () => {
  const { result, calls } = await run({ ...routerArgs(), stages: ['discover', 'implement', 'verify'], mode: 'handoff' }, defaults())
  assert.equal(result.mode, 'discover')
  assert.equal(calls[0].role, 'explorer')
})

test('router args: an S2 task without architect or review plans on Sonnet and skips review', async () => {
  const { result, calls } = await run({ ...routerArgs({ complexity: 'complex' }) }, defaults({ architect: PLAN({ review_required: true }) }))
  assert.equal(result.band, 'S2')
  assert.equal(calls.find((c) => c.label === 'plan').model, 'sonnet')
  assert.equal(result.review.verdict, 'skipped', 'size and a bare request do not force a review the router left out')
})

test('router args: leaving out review still reviews the infra rule, the architect\'s S3 and a high risk', async () => {
  const text = await run({ ...routerArgs(), task: 'change the terraform deploy for prod' }, defaults())
  assert.ok(text.calls.some((c) => c.role === 'reviewer'), 'infra in the task text')
  const planned = await run(routerArgs(), defaults({ architect: PLAN({ workstreams: [ws('ci', ['.github/workflows/ci.yml'])] }) }))
  assert.ok(planned.calls.some((c) => c.role === 'reviewer'), 'infra in the plan files')
  const s3 = await run(routerArgs(), defaults({ architect: PLAN({ risk_class: 'S3' }) }))
  assert.ok(s3.calls.some((c) => c.role === 'reviewer'), 'the architect\'s S3')
  const high = await run(routerArgs(), defaults({ architect: PLAN({ risks: [{ risk: 'x', severity: 'high' }] }) }))
  assert.ok(high.calls.some((c) => c.role === 'reviewer'), 'a high-severity risk')
})

test('a Sonnet plan that reaches S3 gets one Opus re-plan, and the Opus plan is the one built', async () => {
  const auth = PLAN({ summary: 'sonnet plan', workstreams: [ws('m', ['src/auth/token.go'])] })
  const opus = PLAN({ summary: 'opus plan', workstreams: [ws('m', ['src/auth/token.go'])] })
  const { result, calls } = await run(routerArgs(), defaults({ architect: (o) => (o.model === 'opus' ? opus : auth) }))
  assert.deepEqual(calls.filter((c) => c.label.startsWith('plan')).map((c) => `${c.label}/${c.model}`), ['plan/sonnet', 'plan:opus/opus'])
  assert.match(calls.find((c) => c.label === 'plan:opus').prompt, /sonnet plan/)
  assert.equal(result.plan.summary, 'opus plan')
  assert.equal(result.band, 'S3')
  assert.equal(calls.filter((c) => c.role === 'reviewer').length, 1)
})

test('a planModel Sonnet plan that reaches S3 is planned again on Opus too', async () => {
  const { calls } = await run({ task: 'add retries', planModel: 'sonnet' }, defaults({ architect: PLAN({ workstreams: [ws('m', ['src/auth/token.go'])] }) }))
  assert.deepEqual(calls.filter((c) => c.label.startsWith('plan')).map((c) => c.model), ['sonnet', 'opus'])
})

test('an Opus plan that reaches S3 is not planned again, and a failed re-plan leaves the Sonnet plan', async () => {
  const auth = PLAN({ workstreams: [ws('m', ['src/auth/token.go'])] })
  const direct = await run({ task: 'add retries' }, defaults({ architect: auth }))
  assert.equal(direct.calls.filter((c) => c.label.startsWith('plan')).length, 1)
  const failed = await run(routerArgs(), defaults({ architect: (o) => (o.model === 'opus' ? null : auth) }))
  assert.equal(failed.result.band, 'S3')
  assert.ok(failed.calls.some((c) => c.role === 'implementer'))
})

test('router args: leaving out review still reviews rule-based S3, failed checks, escalation and blocking evidence', async () => {
  const s3 = await run({ ...routerArgs(), task: 'rotate the OAuth token on expiry' }, defaults())
  assert.ok(s3.result.review_reasons.includes('band S3'))
  const failed = await run(routerArgs(), defaults({ verifier: FAIL }))
  assert.ok(failed.result.review_reasons.includes('verification fail'))
  let n = 0
  const esc = await run(routerArgs(), defaults({
    implementer: () => (++n === 1 ? IMPL('main', { escalation: { needed: true, question: 'v1 or v2?', evidence: [] } }) : IMPL('main')),
  }))
  assert.ok(esc.result.review_reasons.some((r) => r.includes('escalated')))
  const gap = await run(routerArgs(), defaults({ architect: PLAN({ missing_evidence: ['which client?'], evidence_blocking: true }) }))
  assert.ok(gap.result.review_reasons.includes('plan evidence incomplete'))
})

test('no stages: S2, the architect\'s request and a high risk still force review', async () => {
  const s2 = await run({ task: 'refactor', tier: 'complex', reviewPolicy: 'risk' }, defaults())
  assert.ok(s2.result.review_reasons.includes('band S2'))
  const asked = await run({ task: 'refactor', reviewPolicy: 'risk' }, defaults({ architect: PLAN({ review_required: true }) }))
  assert.ok(asked.result.review_reasons.includes('architect requested review'))
})

test('band: cited files do not trigger the module or infra rules', async () => {
  const { result } = await run({ task: 'add retries' }, defaults({ explorer: DISC(['a/x/f.go:1', 'b/y/g.go:1', 'c/z/h.go:1', '.github/workflows/ci.yml:3']) }))
  assert.equal(result.band, 'S1')
  assert.ok(!result.band_reasons.some((r) => r.includes('modules') || r.includes('infrastructure')))
})

test('band: a module is a folder, so three files in one folder or at the root are not three modules', async () => {
  const one = await run({ task: 'add retries' }, defaults({ architect: PLAN({ workstreams: [ws('m', ['src/a.go', 'src/b.go', 'src/c.go'])] }) }))
  assert.equal(one.result.band, 'S1')
  const rootFiles = await run({ task: 'add retries' }, defaults({ architect: PLAN({ workstreams: [ws('m', ['a.go', 'b.go', 'c.go'])] }) }))
  assert.equal(rootFiles.result.band, 'S1')
})

test('band: open questions do not count as unknowns, only blocking evidence does', async () => {
  const open = await run({ task: 'add retries' }, defaults({ explorer: DISC(undefined, { open_questions: ['which client?', 'which retry?'] }) }))
  assert.equal(open.result.band, 'S1')
  const soft = await run({ task: 'add retries' }, defaults({ architect: PLAN({ missing_evidence: ['backoff base?'], evidence_blocking: false }) }))
  assert.equal(soft.result.band, 'S1')
  const blocking = await run({ task: 'add retries' }, defaults({ architect: PLAN({ missing_evidence: ['which client?'], evidence_blocking: true }) }))
  assert.equal(blocking.result.band, 'S2')
  assert.ok(blocking.result.band_reasons.some((r) => r.includes('open unknowns')))
})

test('band: an S3 path that an explorer cites still raises the band', async () => {
  const { result } = await run({ task: 'add retries' }, defaults({ explorer: DISC(['src/auth/token.go:1']) }))
  assert.equal(result.band, 'S3')
})

test('band: the module and infra rules fire on planned and on changed files', async () => {
  const planned = await run({ task: 'add retries' }, defaults({ architect: PLAN({ workstreams: [ws('m', ['a/x/f.go', 'b/y/g.go', 'c/z/h.go'])] }) }))
  assert.equal(planned.result.band, 'S2')
  assert.ok(planned.result.band_reasons.some((r) => r.includes('3 modules')))
  const infra = await run({ task: 'add retries' }, defaults({ architect: PLAN({ workstreams: [ws('m', ['.github/workflows/ci.yml'])] }) }))
  assert.equal(infra.result.band, 'S2')
  const changed = await run({ task: 'add retries' }, defaults({ implementer: IMPL('main', { files_changed: ['a/x/f.go', 'b/y/g.go', 'c/z/h.go'] }) }))
  assert.equal(changed.result.band, 'S2')
})

const FINDING = (over = {}) => ({ severity: 'major', kind: 'defect', area: 'correctness', file: 'a.go', detail: 'd', fix: 'f', ...over })
const reviewed = (findings, over = {}) => run({ task: 'add retries', reviewPolicy: 'always' }, defaults({ reviewer: { verdict: 'approve_with_notes', findings }, ...over }))
const labels = (calls) => calls.map((c) => c.label).filter((l) => l.startsWith('fix') || /after-review|gaps/.test(l))

test('review: blockers and correctness or security majors get one fix pass and one verification', async () => {
  for (const f of [FINDING({ severity: 'blocker', area: 'tests' }), FINDING(), FINDING({ area: 'security' })]) {
    const { result, calls } = await reviewed([f])
    assert.deepEqual(labels(calls), ['fix:review', 'verify:after-review'])
    assert.match(calls.find((c) => c.label === 'fix:review').prompt, /Defects \(JSON\)/)
    assert.equal(result.post_review_fix.computed, 'pass')
  }
})

test('review: a minor finding or a major outside correctness and security gets no fix pass', async () => {
  const { result, calls } = await reviewed([FINDING({ severity: 'minor' }), FINDING({ area: 'performance' })])
  assert.deepEqual(labels(calls), [])
  assert.equal(result.post_review_fix, null)
})

test('review: a finding with no kind counts as a defect', async () => {
  const { calls } = await reviewed([FINDING({ severity: 'blocker', kind: undefined })])
  assert.deepEqual(labels(calls), ['fix:review', 'verify:after-review'])
})

test('review: an evidence gap goes to the verifier, with no fix pass', async () => {
  const { result, calls } = await reviewed([FINDING({ severity: 'blocker', kind: 'evidence_gap', detail: 'is the client retried?' })])
  assert.deepEqual(labels(calls), ['verify:evidence-gaps'])
  assert.match(calls.find((c) => c.label === 'verify:evidence-gaps').prompt, /is the client retried/)
  assert.equal(result.post_review_fix.fix, null)
  assert.equal(result.post_review_fix.gaps, 1)
})

test('review: a minor evidence gap costs no verifier call', async () => {
  const { calls } = await reviewed([FINDING({ severity: 'minor', kind: 'evidence_gap' })])
  assert.deepEqual(labels(calls), [])
})

test('review: a gap pass can fail the run but cannot pass it', async () => {
  const gap = FINDING({ kind: 'evidence_gap' })
  const fails = await reviewed([gap], { verifier: (o) => (o.label === 'verify:evidence-gaps' ? FAIL : PASS) })
  assert.equal(fails.result.verification.result, 'fail')
  let n = 0
  const stays = await run({ task: 'add retries', reviewPolicy: 'always' }, defaults({
    reviewer: { verdict: 'approve_with_notes', findings: [gap] },
    verifier: (o) => (o.label === 'verify:evidence-gaps' ? PASS : ++n > 0 ? FAIL : PASS),
  }))
  assert.equal(stays.result.verification.result, 'fail', 'gap checks passing does not clear a failed verification')
  const empty = await reviewed([gap], { verifier: (o) => (o.label === 'verify:evidence-gaps' ? VERIFY([]) : PASS) })
  assert.equal(empty.result.verification.result, 'pass', 'a gap pass with no checks leaves the result alone')
})

test('review: a defect and a gap share one fix pass and one verification', async () => {
  const { calls } = await reviewed([FINDING(), FINDING({ kind: 'evidence_gap', detail: 'open fact' })])
  assert.deepEqual(labels(calls), ['fix:review', 'verify:after-review'])
  assert.match(calls.find((c) => c.label === 'verify:after-review').prompt, /open fact/)
})

test('next_action: passing checks mean report, and no rework', async () => {
  const { result } = await run({ task: 'add retries' }, defaults())
  assert.equal(result.next_action.do, 'report')
  assert.match(result.next_action.why, /Do not edit/)
})

test('next_action: a failed fix pass or a failed review is reported as open', async () => {
  const blocker = { verdict: 'changes_required', findings: [FINDING({ severity: 'blocker' })] }
  const noFix = await run({ task: 'add retries', reviewPolicy: 'always' }, defaults({ reviewer: blocker, implementer: (o) => (o.label === 'fix:review' ? null : IMPL('main')) }))
  assert.match(noFix.result.next_action.why, /defect was not fixed/)
  const partial = await run({ task: 'add retries', reviewPolicy: 'always' }, defaults({ reviewer: blocker, implementer: (o) => IMPL('main', o.label === 'fix:review' ? { status: 'partial' } : {}) }))
  assert.match(partial.result.next_action.why, /defect was not fixed/)
  const noReview = await run({ task: 'add retries', reviewPolicy: 'always' }, defaults({ reviewer: null }))
  assert.equal(noReview.result.review.verdict, 'agent_failed')
  assert.match(noReview.result.next_action.why, /review did not run/)
})

test('next_action: an unverified review fix is reported as open', async () => {
  const blocker = { verdict: 'changes_required', findings: [FINDING({ severity: 'blocker' })] }
  const { result } = await run({ task: 'add retries', reviewPolicy: 'always' }, defaults({ reviewer: blocker, verifier: (o) => (o.label === 'verify:after-review' ? null : PASS) }))
  assert.match(result.next_action.why, /fix was not verified/)
})

test('next_action: a grep that expected exit 1 is not a failure to fix', async () => {
  const { result } = await run({ task: 'add retries' }, defaults({ verifier: VERIFY([check('grep -rn oldName src', 1, 'pass', { expected_exit: 1 })]) }))
  assert.equal(result.next_action.do, 'report')
})

test('next_action: real failures name the failed commands', async () => {
  const { result } = await run({ task: 'add retries' }, defaults({ verifier: VERIFY([check('make lint', 0, 'pass'), check('go test ./...', 1, 'fail')], 'fail') }))
  assert.deepEqual(result.next_action, { do: 'fix_failed_checks', failing: ['go test ./...'], why: result.next_action.why })
})

test('next_action: unverified or unfinished work is reported as such, not reworked', async () => {
  const { result } = await run({ task: 'add retries' }, defaults({ verifier: VERIFY([]) }))
  assert.equal(result.next_action.do, 'report')
  assert.match(result.next_action.why, /unverified/)
  const blocked = await run({ task: 'add retries' }, defaults({ implementer: IMPL('main', { status: 'blocked', unresolved: ['no API'] }) }))
  assert.match(blocked.result.next_action.why, /did not finish/)
})

test('stages: a bounded S1 task without discover, architect or review runs Sonnet plan, build and verify only', async () => {
  const { result, calls } = await run({ task: 'add retries to the uploader', reviewPolicy: 'always', stages: ['implement', 'verify'] }, defaults())
  assert.deepEqual(seq(calls), ['architect/sonnet', 'implementer/sonnet', 'verifier/sonnet'])
  assert.deepEqual(result.stages, ['implement', 'verify'])
  assert.equal(result.review.verdict, 'skipped', 'review left out and no mandatory rule fired')
})

test('stages: leaving out review never skips a mandatory review, and S3 always gets the Opus plan', async () => {
  const { result, calls } = await run({ task: 'rotate the OAuth token on expiry', stages: ['implement', 'verify'] }, defaults())
  assert.equal(result.band, 'S3')
  assert.equal(calls.find((c) => c.label === 'plan').model, 'opus')
  assert.ok(calls.some((c) => c.role === 'reviewer' && c.model === 'opus'))
})

test('stages: implement and verify cannot be left out', async () => {
  const { result, calls } = await run({ task: 'add retries to the uploader', stages: ['review'] }, defaults())
  assert.deepEqual(result.stages, ['implement', 'verify', 'review'])
  assert.ok(calls.some((c) => c.role === 'verifier'))
})

test('no stages argument: the full V2 workflow, unchanged', async () => {
  const { result, calls } = await run({ task: 'add retries to the uploader', reviewPolicy: 'risk' }, defaults())
  assert.deepEqual(result.stages, ['discover', 'architect', 'implement', 'verify', 'review'])
  assert.equal(calls[0].role, 'explorer')
  assert.equal(calls.find((c) => c.label === 'plan').model, 'opus')
})
