// Tests for workflows/run.js. The test runs the script body with mocked workflow globals
// (agent, parallel, phase, log), so no model is called.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

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

test('verification: a nonzero exit code counts as a failure', async () => {
  const { result } = await run({ task: 'add retries' }, defaults({ verifier: VERIFY([{ cmd: 'make test', exit_code: 2, outcome: 'pass', failure_summary: '' }]) }))
  assert.equal(result.verification.result, 'fail')
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

test('missing task returns an error', async () => {
  const { result } = await run({}, defaults())
  assert.match(result.error, /args.task is required/)
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
