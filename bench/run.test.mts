// The benchmark harness, end to end, with a fake claude and a local repository. No network and no model call.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GRADER_MODEL, grade, gradePrompt, parseGrade, referenceDiff } from './lib/grade-core.mts'
import { chargedUsd, classifyRun, isDone, isResult } from './lib/outcome.mts'
import { oneRun } from './lib/run-one.mts'
import { bootstrapCI } from './lib/stats.mts'

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
