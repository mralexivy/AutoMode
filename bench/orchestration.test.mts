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
  assert.equal(expectedUsd(h, 't', 'b', 6), 2, 'the task on another arm before the arm mean')
  assert.equal(expectedUsd(h, 'v', 'a', 6), 3, 'the arm mean when the task is new')
  assert.equal(expectedUsd([], 'v', 'a', 6), 6, 'the cap when nothing is known')
  const m = [{ task_id: 't', arm: 'cheap', cost_usd_api_equiv: 0.05, model: { requestedModel: 'haiku' } }, { task_id: 'u', arm: 'x', cost_usd_api_equiv: 2, model: { requestedModel: 'sonnet' } }]
  assert.equal(expectedUsd(m, 't', 'new', 6, 'sonnet'), 2, 'a Haiku row never prices a Sonnet run')
  assert.equal(admit({ budget: 10, spent: 4, inFlight: 4, next: 3 }).admit, false, 'the old check saw $4 of $10 and started')
  assert.equal(admit({ budget: 10, spent: 4, inFlight: 0, next: 3 }).warn, false)
  assert.equal(admit({ budget: 10, spent: 6, inFlight: 0, next: 3 }).warn, true)
})

test('resetAt reads only a time the CLI stated, and never invents one', () => {
  const now = new Date('2026-11-03T10:00:00')
  assert.equal(resetAt('limit resets at 2026-11-03T15:00:00Z', now), '2026-11-03T15:00:00.000Z')
  assert.equal(resetAt('Claude usage limit reached', now), null)
  // The real CLI line, from a cut-off row of 2026-11-03.
  const real = resetAt("You've hit your session limit · resets 3:30am (Asia/Jerusalem)", now)!
  assert.equal(new Date(real).getHours(), 3)
  assert.equal(new Date(real).getMinutes(), 30)
  assert.ok(Date.parse(real) > now.getTime(), 'the next 3:30am, not a past one')
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

test('60-slot simulation: a usage limit, a kill -9 and resumes end with 60 unique rows and nothing paid twice', async () => {
  const dir = fresh('sim60')
  const tdir = path.join(dir, 'tasks')
  fs.mkdirSync(tdir)
  const one = JSON.parse(fs.readFileSync(path.join(tasksDir, 'one.json'), 'utf8'))
  const ids = Array.from({ length: 30 }, (_, i) => `t${String(i).padStart(2, '0')}`)
  for (const id of ids) fs.writeFileSync(path.join(tdir, `${id}.json`), JSON.stringify({ ...one, id }))
  const simArgs = (...more: string[]) => ['bench/run.mts', '--tasks-dir', tdir, '--arms', 'sonnet-high,sonnet-medium', '--repeats', '1', '--parallel', '1', '--window-usd', '0', '--scratch', path.join(dir, 'scratch'), '--out', path.join(dir, 'r.jsonl'), '--run-cap-usd', '3', ...more]
  // Calls 1-12 solve, call 13 hits the limit; after that the plan is spent and FAKE_CLAUDE decides.
  const plan = path.join(dir, 'plan.txt')
  fs.writeFileSync(plan, [...Array(12).fill('solve'), 'quota-reset'].join('\n'))
  const e = (mode: string, more: Record<string, string> = {}) => env(dir, mode, { FAKE_CLAUDE_PLAN: plan, ...more })
  const first = spawnSync(process.execPath, simArgs(), { encoding: 'utf8', env: e('solve') })
  assert.equal(first.status, 75)
  assert.equal(rows(dir).filter((r) => r.exit_reason !== 'quota').length, 12)
  // Resume, and kill it mid-run.
  const child = spawn(process.execPath, simArgs(), { env: e('slow', { FAKE_CLAUDE_MS: '400' }), stdio: 'ignore' })
  // Kill only while a run is in flight: its RUNNING event is the last one for its slot.
  await until(() => rows(dir).filter((r) => r.exit_reason !== 'quota').length >= 20 && [...foldEvents(readEvents(eventsFile(path.join(dir, 'r.jsonl'))), () => true).values()].some((x) => x.state === 'RUNNING'))
  child.kill('SIGKILL')
  await new Promise((r) => child.on('exit', r))
  const callsAtKill = calls(dir)
  // The slot in flight when the kill landed. Under load the 400 ms run can finish between the poll and the kill, so the
  // test reads what the ledger shows instead of assuming one (it failed 1 run in 12 that way).
  // A kill between a row's write and its terminal event leaves a row, which counts as finished: in flight means RUNNING
  // in the ledger and no row yet, the runner's own reading.
  const written = new Set(rows(dir).map((r) => r.run_id))
  const inflight = [...foldEvents(readEvents(eventsFile(path.join(dir, 'r.jsonl'))), () => true).entries()].filter(([id, x]) => x.state === 'RUNNING' && !written.has(id)).length
  assert.ok(inflight <= 1, `in flight: ${inflight}`)
  // Resume again: everything but the UNKNOWN slot.
  const second = spawnSync(process.execPath, simArgs(), { encoding: 'utf8', env: e('solve') })
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, inflight ? /1 unknown \(held: --retry-unknown\)/ : /0 unknown/)
  const third = spawnSync(process.execPath, simArgs('--retry-unknown'), { encoding: 'utf8', env: e('solve') })
  assert.equal(third.status, 0)
  const finished = rows(dir).filter((r) => r.exit_reason === 'done')
  assert.equal(finished.length, 60)
  assert.equal(new Set(finished.map((r) => r.run_id)).size, 60, 'no slot finished twice')
  // Sessions started: 60 finished + 1 cut off by the limit + at most 1 killed in flight (UNKNOWN, retried once).
  assert.ok(calls(dir) <= 62, `sessions: ${calls(dir)}`)
  assert.ok(calls(dir) >= callsAtKill)
  assert.match(spawnSync(process.execPath, simArgs(), { encoding: 'utf8', env: e('solve') }).stdout, /0 to run/)
})

test('a behavior file edited while the run is live: the row is contaminated, invalid, and the run stops', async () => {
  // Found live: an edit to hooks/lib/completion.ts during v5 changed what 3 in-flight sessions ran, and nothing noticed.
  const dir = fresh('contaminated')
  const code = path.join(dir, 'code')
  fs.mkdirSync(path.join(code, 'hooks'), { recursive: true })
  fs.writeFileSync(path.join(code, 'hooks', 'a.ts'), 'export const a = 1\n')
  fs.writeFileSync(path.join(code, 'config.json'), '{}\n')
  const child = spawn(process.execPath, args(dir), { env: env(dir, 'slow', { FAKE_CLAUDE_MS: '1500', AUTOMODE_BENCH_CODE_ROOT: code }), stdio: 'ignore' })
  const ev = eventsFile(path.join(dir, 'r.jsonl'))
  await until(() => readEvents(ev).some((e) => e.state === 'RUNNING'))
  fs.writeFileSync(path.join(code, 'hooks', 'a.ts'), 'export const a = 2\n')
  const exit = await new Promise((r) => child.on('exit', r))
  assert.equal(exit, 5)
  const [row] = rows(dir)
  assert.equal(row.contaminated, true)
  assert.equal(foldEvents(readEvents(ev)).get(row.run_id)?.state, 'INVALID')
  assert.equal(rows(dir).length, 1, 'no run starts after the edit')
  const { rowClass } = await import('./lib/decide.mts')
  assert.equal(rowClass(row), 'harness_invalid')
})

test('E5 sessions: two tasks in one continuing session, each graded, the second resumed, a crash resumes', async () => {
  const dir = fresh('e5')
  const expFile = path.join(dir, 'e5.json')
  fs.writeFileSync(expFile, JSON.stringify({ id: 'e5-test', description: 't', arms: ['sonnet-high'], sessions: { pair: ['one', 'two'] }, budget_usd: 5, run_cap_usd: 3 }))
  const out = path.join(dir, 'e5.jsonl')
  const e5 = (more: Record<string, string> = {}) => spawnSync(process.execPath, ['bench/e5-sessions.mts', '--experiment', 'e5-test', '--experiment-file', expFile, '--tasks-dir', tasksDir, '--out', out, '--scratch', path.join(dir, 'scratch')], { encoding: 'utf8', env: env(dir, 'solve', { FAKE_CLAUDE_LOG: path.join(dir, 'args.json'), ...more }) })
  const first = e5()
  assert.equal(first.status, 0, first.stderr)
  const rs = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(rs.map((r) => [r.session, r.step, r.task_id, r.accepted]), [['pair', 0, 'one', true], ['pair', 1, 'two', true]])
  const last = JSON.parse(fs.readFileSync(path.join(dir, 'args.json'), 'utf8')).args
  assert.deepEqual(last.slice(last.indexOf('--resume'), last.indexOf('--resume') + 2), ['--resume', 'fake-session'], 'the second task continues the session')
  assert.match(last[last.indexOf('-p') + 1], /A new task in the same session/)
  const again = e5()
  assert.equal(again.status, 0)
  assert.equal(fs.readFileSync(out, 'utf8').trim().split('\n').length, 2, 'finished steps are never paid twice')
  assert.equal(calls(dir), 2)
})
