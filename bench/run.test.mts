// The benchmark harness, end to end, with a fake claude and a local repository. No network and no model call.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GRADER_MODEL, grade, gradePrompt, parseGrade, referenceDiff } from './lib/grade-core.mts'
import { chargedUsd, classifyRun, isDone, isResult } from './lib/outcome.mts'
import { armEnv, armInvocation, armSpec, ARMS } from './arms.mts'
import { canonical, experimentProblems, loadExperiment, specHash } from './lib/experiment.mts'
import { loadTemplate, renderPrompt } from './lib/prompt.mts'
import { estimatedUsd, rowProblems } from './lib/result.mts'
import { RunQueue, WINDOW_MS, waitMs, windowSpend } from './lib/pacer.mts'
import { oneRun, runIdFor } from './lib/run-one.mts'
import { normalizeTask, problems } from './lib/task-repo.mts'
import { brier, ece, effortDistance, nll, replicaForecast, spearman, withinOne } from './lib/calibration.mts'
import { buildManifest, verifyManifest } from './lib/manifest.mts'
import { aggregate, countsOnly } from './lib/panel.mts'
import { bootstrapCI, discordant, holm, mcnemarExact, pairedDelta, paretoFrontier, routeSummary, routingRegret } from './lib/stats.mts'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'am-bench-test-'))
const SOURCE = path.join(ROOT, 'source')
const LOG = path.join(ROOT, 'claude-args.json')
const HIDDEN_MARK = 'HIDDEN REFERENCE TEST'
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: SOURCE, encoding: 'utf8' }).trim()
const env = { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
let task: any

function commitFile(file: string, text: string, message: string) {
  fs.writeFileSync(path.join(SOURCE, file), text)
  git('add', '.')
  git('commit', '-q', '-m', message)
  return git('rev-parse', 'HEAD')
}

before(() => {
  fs.mkdirSync(SOURCE)
  git('init', '-q')
  const base = commitFile('README.md', '# fixture\n', 'base')
  commitFile('add.js', 'export const add = (a, b) => a + b\n', 'first half of the reference')
  const reference = commitFile('add.test.js', `// ${HIDDEN_MARK}\nimport assert from 'node:assert/strict'\nimport { add } from './add.js'\nassert.equal(add(2, 3), 5)\n`, 'second half')
  task = { id: 'fixture', cohort: 'trivial', repo: SOURCE, license: 'MIT', base, reference, task: 'Add add.js.', hidden_tests: ['add.test.js'], accept: 'node add.test.js' }
  const bin = path.join(ROOT, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${path.resolve('bench/fixtures/fake-claude.mjs')}" "$@"\n`, { mode: 0o755 })
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
  process.env.CLAUDE_CONFIG_DIR = path.join(ROOT, 'config')
  process.env.FAKE_CLAUDE_LOG = LOG
})

after(() => {
  Object.assign(process.env, { PATH: env.PATH })
  for (const k of ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY'] as const) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
  delete process.env.FAKE_CLAUDE
  delete process.env.FAKE_CLAUDE_LOG
  fs.rmSync(ROOT, { recursive: true, force: true })
})

async function run(mode: string, over: Record<string, unknown> = {}, ctx: Record<string, unknown> = {}) {
  process.env.FAKE_CLAUDE = mode
  const out = path.join(ROOT, mode, 'results.jsonl')
  const row: any = await oneRun({ ...task, ...over }, 'sonnet', 1, { scratch: path.join(ROOT, 'scratch'), out, timeoutMs: 20_000, runCap: 3, repoFor: () => SOURCE, ...ctx })
  const diffFile = path.join(path.dirname(out), 'diffs', `${row.run_id}.diff`)
  return { row, diff: fs.existsSync(diffFile) ? fs.readFileSync(diffFile, 'utf8') : null }
}

test('a solved task passes the hidden tests, and the grader sees the agent test and never the hidden one', async () => {
  const { row, diff } = await run('solve')
  assert.equal(row.exit_reason, 'done')
  assert.equal(row.accepted, true)
  assert.equal(row.cost_usd_api_equiv, 0.25)
  assert.match(diff, /AGENT TEST/)
  assert.doesNotMatch(diff, new RegExp(HIDDEN_MARK))
  assert.equal(row.files_touched, 2)
})

test('work the agent committed reaches the grader', async () => {
  const { row, diff } = await run('solve-and-commit')
  assert.equal(row.accepted, true)
  assert.equal(row.commits_made, 1)
  assert.match(diff, /add = \(a, b\)/)
  assert.match(row.diff_shortstat, /1 file changed/)
})

test('a failed setup is no result, and a resume runs it again', async () => {
  const { row } = await run('solve', { setup: 'exit 7' })
  assert.equal(row.exit_reason, 'setup_error')
  assert.equal(row.setup_exit, 7)
  assert.equal(row.accepted, undefined)
  assert.equal(isResult(row), false)
  assert.equal(isDone(row), false)
})

test('a usage limit is no result, skips the tests, and a resume runs it again', async () => {
  const { row, diff } = await run('quota')
  assert.equal(row.exit_reason, 'quota')
  assert.equal(row.accepted, undefined)
  assert.equal(diff, null)
  assert.equal(isResult(row), false)
  assert.equal(isDone(row), false)
})

test('a test command that never returns is a harness error, not a rejection', async () => {
  const { row } = await run('solve', { accept: 'kill -9 $$' })
  assert.equal(row.accept_exit, null)
  assert.ok(row.harness_error)
  assert.equal(isResult(row), false)
})

test('an agent stopped at the time limit is still measured, and its cost counts as the cap', async () => {
  const { row } = await run('hang', {}, { timeoutMs: 300 })
  assert.equal(row.exit_reason, 'timeout')
  assert.equal(row.accepted, false)
  assert.equal(isResult(row), true)
  assert.equal(row.cost_usd_api_equiv, null)
  assert.deepEqual(chargedUsd(row.cost_usd_api_equiv, 3), { usd: 3, known: false })
  assert.deepEqual(chargedUsd(0.25, 3), { usd: 0.25, known: true })
})

test('an API key stays out of the agent process unless BENCH_AUTH=api', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  await run('solve')
  assert.equal(JSON.parse(fs.readFileSync(LOG, 'utf8')).apiKey, null)
  process.env.BENCH_AUTH = 'api'
  await run('solve')
  delete process.env.BENCH_AUTH
  assert.equal(JSON.parse(fs.readFileSync(LOG, 'utf8')).apiKey, 'test-key')
})

test('the grader pins a full model id, reads every reference commit, and leaves hidden tests out', async () => {
  const { diff } = await run('solve')
  const reference = referenceDiff(task, SOURCE)
  assert.match(reference, /add = \(a, b\)/, 'the first of two reference commits is included')
  assert.doesNotMatch(reference, new RegExp(HIDDEN_MARK))
  const prompt = gradePrompt(task.task, reference, diff)
  assert.doesNotMatch(prompt, new RegExp(HIDDEN_MARK))
  process.env.FAKE_CLAUDE = 'grade'
  const res = await grade(prompt, ROOT)
  assert.equal(parseGrade(res.reply).correctness, 4)
  const { args } = JSON.parse(fs.readFileSync(LOG, 'utf8'))
  assert.equal(args[args.indexOf('--model') + 1], GRADER_MODEL)
  assert.match(GRADER_MODEL, /^claude-[a-z]+-\d/)
})

test('classifyRun reads the agent exit', () => {
  const ok = { code: 0, json: {}, timedOut: false, stderr_tail: [] }
  assert.equal(classifyRun(ok), 'done')
  assert.equal(classifyRun({ ...ok, json: { is_error: true, result: 'Reached max budget' } }), 'agent_error')
  assert.equal(classifyRun({ ...ok, json: null, code: 1, stderr_tail: ['You hit your session limit'] }), 'quota')
  assert.equal(classifyRun({ ...ok, json: null, code: 1 }), 'agent_error')
  assert.equal(classifyRun({ ...ok, json: { result: 'I fixed the rate limit bug' } }), 'done', 'a success that mentions a limit is a success')
  assert.equal(classifyRun({ ...ok, timedOut: true, json: null, code: null }), 'timeout')
})

test('bootstrapCI resamples tasks, so repeats of one task do not narrow the interval', () => {
  const rows = [...Array.from({ length: 100 }, () => ({ task: 'a', ok: 1 })), ...Array.from({ length: 100 }, () => ({ task: 'b', ok: 0 }))]
  const mean = (s: typeof rows) => s.reduce((a, r) => a + r.ok, 0) / s.length
  assert.deepEqual(bootstrapCI(rows, (r) => r.task, mean), [0, 1])
  assert.deepEqual(bootstrapCI(rows, (r) => r.task, mean), bootstrapCI(rows, (r) => r.task, mean), 'seeded')
  assert.deepEqual(bootstrapCI([], (r: any) => r.task, mean), [null, null])
})

test('report: the declared non-inferiority rule evaluates for AutoMode arms, and non-results stay out', () => {
  const row = (id: string, arm: string, accepted: boolean, extra = {}) => ({ run_id: id, task_id: 't1', cohort: 'security', arm, accepted, cost_usd_api_equiv: 1, wall_s: 1, ...extra })
  const file = path.join(ROOT, 'report.jsonl')
  fs.writeFileSync(file, [row('a', 'auto', false), row('b', 'sonnet-high', true), row('c', 'auto', false, { exit_reason: 'quota' })].map((r) => JSON.stringify(r)).join('\n'))
  const r = spawnSync(process.execPath, ['bench/report.mts', file], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /AutoMode Auto: model and effort routing:\*\* FAILS \(security: 0 accepted vs best baseline 1\)/)
  assert.match(r.stdout, /Runs: 3 rows, 2 valid/)
  assert.match(r.stdout, /1 stopped by a usage limit or setup/)
})

test('a row has schema 3, states what was requested and what ran, and stores no prompt text', async () => {
  const { row } = await run('solve')
  assert.deepEqual(rowProblems(row), [])
  assert.equal(row.schema_version, 3)
  assert.equal(row.cost_basis, 'api-list-equivalent')
  assert.equal(row.reported_cost_usd, null)
  assert.equal(row.model.requestedModel, 'sonnet')
  assert.deepEqual(row.evidence.effective_models, ['claude-sonnet-5-5'])
  assert.deepEqual(row.evidence.effective_efforts, ['high'])
  assert.equal(row.evidence.compactions, 1)
  assert.equal(row.evidence.peak_prompt_tokens, 1600)
  assert.equal(row.evidence.tokens.thinking, 50)
  assert.ok(row.estimated_cost_usd > 0)
  assert.match(row.harness.git_sha, /^[0-9a-f]{40}$/)
  assert.match(row.prompt.rendered_sha256, /^[0-9a-f]{64}$/)
  assert.doesNotMatch(JSON.stringify(row), /Execution contract/)
})

test('a row that stops early still meets the schema', async () => {
  assert.deepEqual(rowProblems((await run('quota')).row), [])
  assert.deepEqual(rowProblems((await run('solve', { setup: 'exit 1' })).row), [])
  assert.deepEqual(rowProblems({ text: 'x' }).includes('a row must not store "text"'), true)
})

test('estimatedUsd is null when a model has no price row, never a partial sum', () => {
  const t = { input: 1e6, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
  const ev: any = { by_model: { 'claude-sonnet-5-5': t } }
  assert.equal(estimatedUsd(ev), 2)
  assert.equal(estimatedUsd({ ...ev, by_model: { ...ev.by_model, 'other-model': t } }), null)
  assert.equal(estimatedUsd(null), null)
})

test('run_id changes when the arm, the prompt or the task changes, and not with key order', () => {
  const t = loadTemplate('repo-change-v1')
  const a = runIdFor(task, 'sonnet-high', 1, t).runId
  assert.equal(a, runIdFor({ ...task }, 'sonnet-high', 1, t).runId)
  assert.notEqual(a, runIdFor(task, 'sonnet-medium', 1, t).runId)
  assert.notEqual(a, runIdFor(task, 'sonnet-high', 1, { ...t, sha256: 'other' }).runId)
  assert.notEqual(a, runIdFor({ ...task, base: 'c'.repeat(40) }, 'sonnet-high', 1, t).runId)
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), canonical({ a: [2, { c: 4, d: 3 }], b: 1 }))
  assert.equal(specHash({ a: 1, b: 2 }), specHash({ b: 2, a: 1 }))
})

test('the prompt template keeps the task text literal', () => {
  const t = loadTemplate('repo-change-v1')
  assert.ok(renderPrompt(t, 'use $& here').text.startsWith('use $& here'))
  assert.throws(() => loadTemplate('../secret'))
})

test('arm controls map to documented flags and variables', () => {
  assert.deepEqual(armEnv(ARMS['sonnet-default-effort']), { CLAUDE_CODE_EFFORT_LEVEL: 'unset' })
  assert.deepEqual(armEnv(ARMS['sonnet-medium-uncached']), { DISABLE_PROMPT_CACHING: '1' })
  assert.deepEqual(armEnv(ARMS['sonnet-medium-200k']), { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' })
  assert.deepEqual(armEnv(ARMS['sonnet-medium-compact-200k']), { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' })
  assert.equal(armSpec('sonnet-default-effort').model.reasoning.mode, 'provider-default')
  assert.equal(armSpec('haiku-max').model.reasoning.requestedEffort, 'max')
  assert.equal(armSpec('sonnet-medium-200k').model.context.policy, 'capped-200k')
  for (const family of ['haiku', 'sonnet', 'opus']) for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) assert.ok(ARMS[`${family}-${effort}`])
  const dir = fs.mkdtempSync(path.join(ROOT, 'arm-'))
  assert.equal(armInvocation('sonnet-default-effort', dir, 'p').args.includes('--effort'), false)
  const { args } = armInvocation('opus-max', dir, 'p')
  assert.equal(args[args.indexOf('--effort') + 1], 'max')
})

test('every experiment file loads, and a bad one names its fault', () => {
  for (const f of fs.readdirSync('bench/experiments')) assert.ok(loadExperiment(path.join('bench/experiments', f), Object.keys(ARMS)).arms.length, f)
  assert.deepEqual(experimentProblems({ schema_version: 1, id: 'x', track: 'automode-system', arms: ['nope'], repeats: 1, prompt_template: 't' }, []), ['unknown arm nope'])
  assert.ok(experimentProblems({}, []).length >= 4)
})

test('task schema 2 reads into the same shape, and a v1 file is unchanged', () => {
  const v1 = { id: 'a', accept: 'x', hidden_tests: ['t'] }
  assert.deepEqual(normalizeTask(v1), v1)
  const t = normalizeTask({ schema_version: 2, id: 'a', task: 'do', evaluation: { hidden_tests: ['t'], accept: ['one', 'two'], regression: ['r'], lint: ['l'], typecheck: ['c'] }, requirements: { risk_tags: ['SECRET-TAG'] } })
  assert.equal(t.accept, 'one && two')
  assert.equal(t.regression, 'r')
  assert.equal(problems({ ...t, repo: 'https://x', license: 'MIT', cohort: 'c', base: 'a'.repeat(40), reference: 'b'.repeat(40), limits: { wall_seconds: 0 } }).length, 1)
  assert.doesNotMatch(renderPrompt(loadTemplate('repo-change-v1'), t.task).text, /SECRET-TAG/)
})

test('task regression and typecheck commands are recorded', async () => {
  const { row } = await run('solve', { regression: 'true', typecheck: 'false' })
  assert.equal(row.regression_ok, true)
  assert.equal(row.typecheck_ok, false)
})

test('the run script: a resume skips finished rows, reruns a usage limit, and the budget survives', () => {
  const dir = path.join(ROOT, 'cli')
  const tasks = path.join(dir, 'tasks')
  fs.mkdirSync(tasks, { recursive: true })
  fs.writeFileSync(path.join(tasks, 'fixture.json'), JSON.stringify(task))
  const out = path.join(dir, 'results.jsonl')
  const cli = (mode: string, ...more: string[]) => spawnSync(process.execPath, ['bench/run.mts', '--quota-wait-min', '0', '--quota-retries', '1', '--window-usd', '0', '--tasks-dir', tasks, '--arms', 'sonnet-high,sonnet-medium', '--repeats', '1', '--parallel', '1', '--scratch', path.join(dir, 'scratch'), '--out', out, '--run-cap-usd', '3', ...more],
    { encoding: 'utf8', env: { ...process.env, FAKE_CLAUDE: mode, BENCH_ALLOW_LOCAL: '1', BENCH_CACHE_DIR: path.join(dir, 'repos'), LEDGER_FILE: path.join(dir, 'ledger.jsonl') } })
  const quota = cli('quota')
  assert.equal(quota.status, 0, quota.stderr)
  assert.match(quota.stdout, /USAGE LIMIT, will rerun/)
  assert.match(quota.stdout, /did not clear/)
  const first = cli('solve', '--budget-usd', '0.25')
  assert.match(first.stdout, /2 to run/)
  assert.match(first.stdout, /Budget \$0.25 reached/)
  const second = cli('solve', '--budget-usd', '0.25')
  assert.match(second.stdout, /1 to run/)
  assert.match(second.stdout, /Budget \$0.25 reached/, 'spend from the first run still counts')
  const third = cli('solve')
  assert.match(third.stdout, /1 to run/)
  assert.match(cli('solve').stdout, /0 to run/)
})

test('pacer: the rolling window counts recent spend and says when room returns', () => {
  const now = Date.parse('2026-10-31T12:00:00Z')
  const at = (minAgo: number, usd: number) => ({ at: new Date(now - minAgo * 60_000).toISOString(), usd })
  const entries = [at(400, 100), at(200, 6), at(30, 5)]
  assert.equal(windowSpend(entries, now), 11, 'spend older than 5 hours is out')
  assert.equal(waitMs(entries, now, null), 0)
  assert.equal(waitMs(entries, now, 12), 0)
  assert.equal(waitMs(entries, now, 10), WINDOW_MS - 200 * 60_000, 'the oldest $6 must leave')
  assert.equal(waitMs(entries, now, 4), WINDOW_MS - 30 * 60_000, 'all of it must leave')
})

test('pacer: a usage limit puts the run back first, pauses, and gives up after the retries', () => {
  const q = new RunQueue(['a', 'b'], 1)
  const first = q.take()
  assert.equal(q.limitHit(first, 1000, 500), true)
  assert.equal(q.pausedUntil, 1500)
  assert.equal(q.take(), 'a')
  assert.equal(q.limitHit('a', 2000, 500), false)
  assert.equal(q.size, 2)
})

test('the run script waits or stops at a full window, and a resume continues', () => {
  const dir = path.join(ROOT, 'window')
  const tasks = path.join(dir, 'tasks')
  fs.mkdirSync(tasks, { recursive: true })
  fs.writeFileSync(path.join(tasks, 'fixture.json'), JSON.stringify(task))
  const r = spawnSync(process.execPath, ['bench/run.mts', '--tasks-dir', tasks, '--arms', 'sonnet-high,sonnet-medium', '--repeats', '1', '--window-usd', '0.2', '--stop-at-window', '--scratch', path.join(dir, 's'), '--out', path.join(dir, 'r.jsonl')],
    { encoding: 'utf8', env: { ...process.env, FAKE_CLAUDE: 'solve', BENCH_ALLOW_LOCAL: '1', BENCH_CACHE_DIR: path.join(dir, 'repos'), LEDGER_FILE: path.join(dir, 'ledger.jsonl') } })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.match(/accepted/g)?.length, 1, 'one run fits, then the window is full')
  assert.match(r.stdout, /usage window is full/)
})

test('timing is split by phase, and the row records the auth mode', async () => {
  const { row } = await run('solve')
  assert.ok(row.latency.total_ms >= row.latency.setup_ms + row.latency.agent_ms)
  assert.ok(row.latency.agent_ms > 0)
  assert.equal(row.auth, 'subscription')
})

test('mcnemarExact matches hand-computed values', () => {
  assert.equal(mcnemarExact(0, 0), 1)
  assert.equal(mcnemarExact(0, 5), 0.0625)
  assert.equal(mcnemarExact(1, 6), 0.125)
  assert.equal(mcnemarExact(6, 1), 0.125)
  assert.equal(mcnemarExact(3, 3), 1)
  assert.ok(Math.abs(mcnemarExact(2, 12) - 0.012939453125) < 1e-12)
})

test('holm matches a worked example and keeps the input order', () => {
  const h = holm([0.04, 0.01, 0.03])
  for (const [i, want] of [0.06, 0.03, 0.06].entries()) assert.ok(Math.abs(h[i] - want) < 1e-12)
  assert.deepEqual(holm([0.9, 0.9]), [1, 1])
  assert.deepEqual(holm([]), [])
})

test('the bootstrap resamples repeats within tasks and stays inside its cohorts', () => {
  const rows = [{ t: 'a', c: 'x', ok: 1 }, { t: 'a', c: 'x', ok: 0 }, { t: 'b', c: 'y', ok: 1 }, { t: 'b', c: 'y', ok: 1 }]
  const m = (s: typeof rows) => s.reduce((a, r) => a + r.ok, 0) / s.length
  const [lo, hi] = bootstrapCI(rows, (r) => r.t, m, { cohortOf: (r) => r.c })
  assert.equal(hi, 1)
  assert.ok(lo >= 0.5, 'stratification keeps the all-solved cohort in every draw')
})

test('pairedDelta compares only shared tasks and keeps a task pair together', () => {
  const r = (t: string, ok: number) => ({ t, ok })
  const a = [r('p', 0), r('q', 1), r('only-a', 1)]
  const b = [r('p', 1), r('q', 1)]
  const d = pairedDelta(a, b, (x) => x.t, (rs) => rs.reduce((s, x) => s + x.ok, 0) / rs.length)
  assert.equal(d.tasks, 2)
  assert.equal(d.delta, 0.5)
  assert.deepEqual(d.ci, [0, 1])
  const fixed = pairedDelta([r('p', 0), r('q', 0), r('s', 0)], [r('p', 1), r('q', 1), r('s', 1)], (x) => x.t, (rs) => rs[0].ok)
  assert.deepEqual(fixed.ci, [1, 1], 'an always-better arm has no spread, however hard the tasks are')
})

test('discordant takes the majority of repeats and treats a tie as not solved', () => {
  const r = (t: string, ok: boolean) => ({ t, ok })
  const d = discordant([r('a', true), r('a', true), r('a', false), r('b', true), r('b', false)], [r('a', false), r('b', true), r('x', true)], (x) => x.t, (x) => x.ok)
  assert.deepEqual(d, { onlyA: 1, onlyB: 1 })
})

test('paretoFrontier drops dominated arms and keeps ties', () => {
  const p = (id: string, quality: number, cost: number) => ({ id, quality, cost })
  assert.deepEqual(paretoFrontier([p('cheap', 0.5, 1), p('strong', 0.9, 5), p('bad', 0.5, 2), p('twin', 0.5, 1)]).map((x) => x.id), ['cheap', 'strong', 'twin'])
})

test('routing regret and the weight-free measures', () => {
  const o = (arm: string, quality: number, cost: number, wall = 0) => ({ arm, quality, cost, wall })
  const t = [o('auto', 1, 2), o('sonnet', 1, 1), o('opus', 1, 5)]
  assert.ok(Math.abs(routingRegret(t, 'auto', 0.1, 0) - 0.1) < 1e-12)
  assert.equal(routingRegret(t, 'sonnet', 0.1, 0), 0)
  assert.equal(routingRegret([o('auto', 1, 1)], 'auto', 0.1, 0), null)
  const failed = [o('auto', 0, 1), o('opus', 1, 5)]
  const s = routeSummary([t, failed], 'auto')
  assert.deepEqual(s, { tasks: 2, pareto_share: 0.5, median_excess_usd: 1, failures: 1, failures_another_arm_solved: 1, solved: 1, solved_where_cheaper_arm_also_solved: 1 })
})

test('a manifest detects a changed input', () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'manifest-'))
  const file = path.join(dir, 'r.jsonl')
  fs.writeFileSync(file, JSON.stringify({ experiment: 'stage-a', spec_hash: 'h', harness: { git_sha: 'abc' }, pricing_snapshot: '2026-10-17', cost_basis: 'api-list-equivalent' }) + '\n')
  const m = buildManifest([file])
  assert.deepEqual(m.experiments, ['stage-a'])
  assert.equal(m.files[0].rows, 1)
  assert.deepEqual(verifyManifest(m, dir), [])
  fs.appendFileSync(file, '{}\n')
  assert.deepEqual(verifyManifest(m, dir), ['r.jsonl'])
})

test('report: paired, Pareto and routing sections come from the rows, and a small study says pilot', () => {
  const row = (id: string, t: string, arm: string, accepted: boolean, cost: number) => ({ run_id: id, task_id: t, cohort: 'feature', arm, accepted, cost_usd_api_equiv: cost, wall_s: 10 })
  const file = path.join(ROOT, 'paired.jsonl')
  const rows = ['t1', 't2', 't3', 't4'].flatMap((t, i) => [row(`a${i}`, t, 'auto', true, 1), row(`b${i}`, t, 'sonnet-high', i < 2, 2)])
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'))
  const manifest = path.join(ROOT, 'paired.manifest.json')
  const r = spawnSync(process.execPath, ['bench/report.mts', '--manifest', manifest, file], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Pilot: 4 tasks/)
  assert.match(r.stdout, /\| 4 \| \+50 pts .*\| -\$1\.00 .*\| 0 \| 2 \| 0\.500 \|/)
  assert.match(r.stdout, /Solved rate and mean cost: auto/)
  assert.equal(JSON.parse(fs.readFileSync(manifest, 'utf8')).files[0].rows, 8)
})

const scored = (n: number, vs = 'equal', defects: string[] = []) => ({ correctness: n, completeness: n, scope: n, tests: n, maintainability: n, vs_reference: vs, defects })

test('panel: the median resists one odd judge, and disagreement goes to a person', () => {
  const calm = aggregate({ a: scored(4), b: scored(4), c: scored(5) })
  assert.equal(calm.grade.correctness, 4)
  assert.equal(calm.disputed, false)
  const split = aggregate({ a: scored(1, 'worse'), b: scored(4), c: scored(4) })
  assert.equal(split.grade.correctness, 4)
  assert.equal(split.grade.vs_reference, 'equal')
  assert.ok(split.reasons.includes('vs_reference differs') && split.reasons.includes('tests differs by 2 or more'))
  assert.equal(aggregate({ a: scored(3), b: null }).disputed, true)
  assert.equal(aggregate({ a: null }).grade, null)
  assert.equal(aggregate({ a: scored(2), b: scored(3) }).grade.scope, 2, 'an even panel leans strict')
})

test('grade rows never keep the text of a defect', () => {
  const g = countsOnly(scored(3, 'equal', ['a defect, in model words']))
  assert.equal(g.defect_count, 1)
  assert.doesNotMatch(JSON.stringify(g), /model words/)
  assert.equal(countsOnly(null), null)
  assert.doesNotMatch(JSON.stringify(aggregate({ a: scored(3, 'equal', ['model words']) })), /model words/)
})

test('calibration measures match worked values', () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1)
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1)
  assert.equal(spearman([1, 1, 1], [1, 2, 3]), null)
  assert.ok(Math.abs(spearman([1, 2, 2, 3], [1, 2, 3, 4]) - 0.9486832980505138) < 1e-12)
  assert.equal(withinOne([1, 5], [2, 3]), 0.5)
  const f = [{ p: 0.8, correct: true }, { p: 0.8, correct: false }]
  assert.ok(Math.abs(brier(f) - 0.34) < 1e-12)
  assert.ok(Math.abs(ece(f) - 0.3) < 1e-12)
  assert.ok(Math.abs(nll(f) - (-(Math.log(0.8) + Math.log(0.2)) / 2)) < 1e-12)
  assert.equal(effortDistance('xhigh', ['low', 'medium']), 2)
  assert.equal(effortDistance('high', ['high']), 0)
  assert.equal(replicaForecast(['high'], ['high']), null)
  assert.deepEqual(replicaForecast(['high', 'high', 'low', 'high'], ['high']), { p: 0.75, correct: true })
})

test('the calibration script refuses to invent uncertainty from one label per case', () => {
  const file = path.join(ROOT, 'answers.json')
  fs.writeFileSync(file, JSON.stringify({ answers: [{ id: 't01', arm: 'x', effort: 'low' }] }))
  const r = spawnSync(process.execPath, ['bench/calibration-report.mts', '--effort', file, '--arm', 'x'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /need at least two labels/)
})

test('report: quality scores are secondary and leave out disputed runs', () => {
  const file = path.join(ROOT, 'graded.jsonl')
  fs.writeFileSync(file, [{ run_id: 'a', task_id: 't', cohort: 'feature', arm: 'auto', accepted: true, cost_usd_api_equiv: 1, wall_s: 1 }, { run_id: 'b', task_id: 't', cohort: 'feature', arm: 'auto', accepted: true, cost_usd_api_equiv: 1, wall_s: 1 }].map((r) => JSON.stringify(r)).join('\n'))
  fs.writeFileSync(path.join(ROOT, 'graded.grades.jsonl'), [{ run_id: 'a', grade: scored(4), disputed: false }, { run_id: 'b', grade: scored(1), disputed: true }].map((r) => JSON.stringify(r)).join('\n'))
  const r = spawnSync(process.execPath, ['bench/report.mts', file], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /\| AutoMode Auto: model and effort routing \| 2 \| 1 \| 4\.00 \|/)
})
