// The paid-run controls, end to end with the fake claude: a kill -9 mid-run, two runners at once, a usage limit, the
// gate, reuse and UNKNOWN rows. No network and no model call. Each case is an incident from 2026-11-02/03.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eventsFile, foldEvents, readEvents } from './lib/events.mts'
import { acquire, lockHeld, readLock } from './lib/lock.mts'
import { admit, expectedUsd, resetAt } from './lib/admission.mts'
import { gateProblem, planHash } from './lib/gate.mts'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'am-orch-'))
const SOURCE = path.join(ROOT, 'source')
const BIN = path.join(ROOT, 'bin')
const REAL_BIN = path.join(ROOT, 'real-bin')
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: SOURCE, encoding: 'utf8' }).trim()
let tasksDir = ''

before(() => {
  fs.mkdirSync(SOURCE)
  git('init', '-q')
  fs.writeFileSync(path.join(SOURCE, 'README.md'), '# fixture\n'); git('add', '.'); git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(SOURCE, 'add.js'), 'export const add = (a, b) => a + b\n')
  fs.writeFileSync(path.join(SOURCE, 'add.test.js'), "import assert from 'node:assert/strict'\nimport { add } from './add.js'\nassert.equal(add(2, 3), 5)\n")
  git('add', '.'); git('commit', '-q', '-m', 'reference')
  const reference = git('rev-parse', 'HEAD')
  tasksDir = path.join(ROOT, 'tasks')
  fs.mkdirSync(tasksDir)
  for (const id of ['one', 'two']) fs.writeFileSync(path.join(tasksDir, `${id}.json`), JSON.stringify({ id, cohort: 'trivial', repo: SOURCE, license: 'MIT', base, reference, task: 'Add add.js.', hidden_tests: ['add.test.js'], accept: 'node add.test.js' }))
  fs.mkdirSync(BIN)
  fs.writeFileSync(path.join(BIN, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${path.resolve('bench/fixtures/fake-claude.mjs')}" "$@"\n`, { mode: 0o755 })
  // A claude that looks real: it answers --version like the CLI and logs any other call, which must never happen.
  fs.mkdirSync(REAL_BIN)
  fs.writeFileSync(path.join(REAL_BIN, 'claude'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.314 (Claude Code)"; exit 0; fi\necho "$@" >> "${path.join(ROOT, 'paid-calls.log')}"\nexit 1\n`, { mode: 0o755 })
})
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const env = (dir: string, mode: string, more: Record<string, string> = {}, bin = BIN) => ({
  ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_CLAUDE: mode, FAKE_CLAUDE_CALLS: path.join(dir, 'calls.log'),
  CLAUDE_CONFIG_DIR: path.join(dir, 'config'), BENCH_ALLOW_LOCAL: '1', BENCH_CACHE_DIR: path.join(dir, 'repos'), LEDGER_FILE: path.join(dir, 'ledger.jsonl'), BENCH_LOCK_DIR: path.join(dir, 'lock'), ...more,
})
const args = (dir: string, ...more: string[]) => ['bench/run.mts', '--tasks-dir', tasksDir, '--arms', 'sonnet-high', '--tasks', 'one,two', '--repeats', '1', '--parallel', '1', '--window-usd', '0', '--scratch', path.join(dir, 'scratch'), '--out', path.join(dir, 'r.jsonl'), '--run-cap-usd', '3', ...more]
const cli = (dir: string, mode: string, more: string[] = [], e: Record<string, string> = {}, bin = BIN) => spawnSync(process.execPath, args(dir, ...more), { encoding: 'utf8', env: env(dir, mode, e, bin) })
const rows = (dir: string) => (fs.existsSync(path.join(dir, 'r.jsonl')) ? fs.readFileSync(path.join(dir, 'r.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const calls = (dir: string) => (fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean).length : 0)
const fresh = (name: string) => { const d = path.join(ROOT, name); fs.mkdirSync(d, { recursive: true }); return d }
const until = async (check: () => boolean, ms = 20_000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 50)) } }

test('kill -9 mid-run: the finished row stays, the run in flight is UNKNOWN and held, the rest runs', async () => {
  const dir = fresh('kill')
  const child = spawn(process.execPath, args(dir), { env: env(dir, 'slow', { FAKE_CLAUDE_MS: '1500' }), stdio: 'ignore' })
  const ev = eventsFile(path.join(dir, 'r.jsonl'))
  // Wait until the first run finished and the second is in flight, then kill the runner with no chance to clean up.
  await until(() => rows(dir).length === 1 && readEvents(ev).filter((e) => e.state === 'RUNNING').length === 2)
  child.kill('SIGKILL')
  await new Promise((r) => child.on('exit', r))
  const state = foldEvents(readEvents(ev))
  assert.deepEqual([...state.values()].map((e) => e.state).sort(), ['COMPLETED', 'UNKNOWN'])
  const callsBefore = calls(dir)
  const resume = cli(dir, 'solve')
  assert.equal(resume.status, 0, resume.stderr)
  assert.match(resume.stdout, /1 already done .*1 unknown \(held: --retry-unknown\), 0 to run/)
  assert.equal(calls(dir), callsBefore, 'nothing reran: the finished row is kept and the unknown one waits')
  const retry = cli(dir, 'solve', ['--retry-unknown'])
  assert.match(retry.stdout, /1 to run/)
  assert.equal(rows(dir).length, 2)
  assert.equal(new Set(rows(dir).map((r) => r.run_id)).size, 2, 'no repetition ran twice')
  assert.match(cli(dir, 'solve').stdout, /0 to run/)
})

test('two runners at once: the second refuses while the first holds the lock', async () => {
  const dir = fresh('dual')
  const first = spawn(process.execPath, args(dir), { env: env(dir, 'slow', { FAKE_CLAUDE_MS: '1500' }), stdio: 'ignore' })
  await until(() => !!readLock(path.join(dir, 'lock', 'paid.lock')))
  const second = cli(dir, 'solve')
  assert.equal(second.status, 3)
  assert.match(second.stderr, /holds the benchmark lock/)
  await new Promise((r) => first.on('exit', r))
  assert.equal(rows(dir).length, 2)
  assert.equal(readLock(path.join(dir, 'lock', 'paid.lock')), null, 'the lock is released at the end')
})

test('a stale lock (dead owner) is taken over; a live one is not', () => {
  const dir = fresh('stale')
  const file = path.join(dir, 'paid.lock')
  fs.writeFileSync(file, JSON.stringify({ pid: 999_999, host: os.hostname(), experiment: 'x', started: new Date().toISOString(), heartbeat: new Date().toISOString() }))
  const got = acquire('y', file)
  assert.equal(got.ok, true)
  assert.equal('tookOver' in got && got.tookOver?.pid, 999_999)
  assert.equal(lockHeld(readLock(file)), false, 'my own lock does not block me')
  if ('release' in got) got.release()
})

test('a usage limit pauses at once: one session, exit 75, the stated reset saved, no busy loop', () => {
  const dir = fresh('quota')
  const t0 = Date.now()
  const r = cli(dir, 'quota-reset', ['--parallel', '1'])
  assert.equal(r.status, 75)
  assert.ok(Date.now() - t0 < 30_000, 'it does not wait in place')
  assert.equal(calls(dir), 1, 'no second session starts into a spent window')
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'r.status.json'), 'utf8'))
  assert.equal(status.state, 'quota_paused')
  assert.equal(status.reset_at, '2099-01-01T05:00:00.000Z')
  const resumed = cli(dir, 'solve')
  assert.match(resumed.stdout, /0 already done .*2 to run/, 'a cut-off row is no result and runs again')
})

test('the gate: with a real-looking claude, no preflight means no paid call at all', () => {
  const dir = fresh('gate')
  const r = cli(dir, 'solve', ['--experiment', 'rescue-final'], {}, REAL_BIN)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /Not starting: no preflight report/)
  assert.equal(fs.existsSync(path.join(ROOT, 'paid-calls.log')), false, 'claude was never called to work')
})

test('gateProblem: a changed plan, a failed check or an old report each block', () => {
  const plan = { experiment: 'e', runIds: ['a', 'b'], budget: 80, runCap: 6, policy: 'p' }
  const hash = planHash(plan)
  assert.equal(planHash({ ...plan, runIds: ['b', 'a'] }), hash, 'order does not matter')
  const ok = { experiment: 'e', plan_hash: hash, at: new Date().toISOString(), pass: true, checks: [], slots: null, estimate_usd: 1 }
  assert.equal(gateProblem(ok, hash), null)
  assert.match(gateProblem(ok, planHash({ ...plan, runIds: ['a', 'c'] }))!, /plan changed/)
  assert.match(gateProblem({ ...ok, pass: false, checks: [{ name: 'fixtures', ok: false, blocking: true, detail: '' }] }, hash)!, /fixtures/)
  assert.match(gateProblem({ ...ok, at: new Date(Date.now() - 25 * 3_600_000).toISOString() }, hash)!, /older than 24 hours/)
})

test('reuse: a finished row with the same run id in an earlier file is copied, not paid for', () => {
  const first = fresh('reuse-a')
  cli(first, 'solve')
  const second = fresh('reuse-b')
  const r = cli(second, 'solve', ['--reuse-from', path.join(first, 'r.jsonl')])
  assert.match(r.stdout, /2 already done \(2 reused\)/)
  assert.equal(calls(second), 0)
  assert.deepEqual(rows(second).map((x) => x.reused_from), ['r.jsonl', 'r.jsonl'])
})

test('admission counts money in flight, and expected cost comes from history', () => {
  const h = [{ task_id: 't', arm: 'a', cost_usd_api_equiv: 2 }, { task_id: 'u', arm: 'a', cost_usd_api_equiv: 4 }]
  assert.equal(expectedUsd(h, 't', 'a', 6), 2)
  assert.equal(expectedUsd(h, 'v', 'a', 6), 3, 'the arm mean when the task is new')
  assert.equal(expectedUsd([], 'v', 'a', 6), 6, 'the cap when nothing is known')
  assert.equal(admit({ budget: 10, spent: 4, inFlight: 4, next: 3 }).admit, false, 'the old check saw $4 of $10 and started')
  assert.equal(admit({ budget: 10, spent: 4, inFlight: 0, next: 3 }).warn, false)
  assert.equal(admit({ budget: 10, spent: 6, inFlight: 0, next: 3 }).warn, true)
})

test('resetAt reads only a time the CLI stated, and never invents one', () => {
  const now = new Date('2026-11-03T10:00:00')
  assert.equal(resetAt('limit resets at 2026-11-03T15:00:00Z', now), '2026-11-03T15:00:00.000Z')
  assert.equal(resetAt('Claude usage limit reached', now), null)
  assert.equal(new Date(resetAt('Your limit resets 3pm', now)!).getHours(), 15)
})

test('supervisor: sleeps to a stated reset, stops on no reset or any other exit, never spins', async () => {
  const { nextAction, MARGIN_MS, MAX_SLEEP_MS } = await import('./supervise.mts')
  const now = Date.parse('2026-11-03T10:00:00Z')
  assert.deepEqual(nextAction(0, null, now).act, 'done')
  assert.equal(nextAction(2, null, now).act, 'stop', 'a gate refusal is never retried')
  assert.equal(nextAction(4, null, now).act, 'stop', 'an integrity defect is never retried')
  assert.match(nextAction(75, { reset_at: null }, now).why, /resume by hand/)
  const s = nextAction(75, { reset_at: '2026-11-03T11:00:00Z' }, now)
  assert.equal(s.act, 'sleep')
  assert.equal(s.ms, 3_600_000 + MARGIN_MS)
  assert.equal(nextAction(75, { reset_at: new Date(now + MAX_SLEEP_MS + 1).toISOString() }, now).act, 'stop')
})

test('supervisor end to end: a limit with a reset in the past resumes and finishes the plan', () => {
  const dir = fresh('supervise')
  // The first cycle hits the limit (reset already past), the second finishes: the supervisor loops once, then exits 0.
  const fakeRunner = path.join(dir, 'runner.mjs')
  fs.writeFileSync(fakeRunner, `import fs from 'node:fs'\nconst n = path => { try { return Number(fs.readFileSync(path, 'utf8')) } catch { return 0 } }\nconst c = '${path.join(dir, 'cycles')}'\nconst k = n(c) + 1\nfs.writeFileSync(c, String(k))\nfs.writeFileSync('${path.join(dir, 'r.status.json')}', JSON.stringify({ reset_at: new Date(Date.now() - 600000).toISOString() }))\nprocess.exit(k === 1 ? 75 : 0)\n`)
  const r = spawnSync(process.execPath, ['bench/supervise.mts', '--', '--out', path.join(dir, 'r.jsonl')], { encoding: 'utf8', env: { ...process.env, SUPERVISE_RUNNER: fakeRunner, SUPERVISE_MARGIN_MS: '100' }, timeout: 60_000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(fs.readFileSync(path.join(dir, 'cycles'), 'utf8'), '2')
})
