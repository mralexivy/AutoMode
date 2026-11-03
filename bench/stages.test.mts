// The stage boundaries: reuse after a code change, the decision on graded rows, slot classification, regrading and
// the agent-environment check. No model call. bench/orchestration.test.mts covers the paid-run controls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LADDER_SCOPE, reuseDecision } from './lib/reuse.mts'
import { decide, rowClass, type Policy } from './lib/decide.mts'
import { agentCommand } from './preflight.mts'
import { workspaceEnv } from './runners/claude-code.mts'

const policy: Policy = JSON.parse(fs.readFileSync('bench/experiments/policies/rescue-ship-v1.json', 'utf8'))

test('reuse: an identical execution stands; a ladder-only change stands only for a run with no ladder action', () => {
  const base = { sameOtherwise: [], changed: [], recordedEscalations: 0, replayedEscalations: 0 }
  assert.deepEqual(reuseDecision(base), { reuse: true, how: 'identical', why: 'same execution key' })
  assert.equal(reuseDecision({ ...base, changed: ['hooks/lib/rescue.ts'] }).reuse, true)
  // Negative cases: each refuses, with its reason.
  assert.match((reuseDecision({ ...base, changed: ['hooks/v4.ts'] }) as any).why, /outside the ladder scope: hooks\/v4.ts/)
  assert.match((reuseDecision({ ...base, changed: ['hooks/lib/failures.ts'] }) as any).why, /outside the ladder scope/, 'failures.ts rewrites check commands, so it is out')
  assert.match((reuseDecision({ ...base, changed: ['hooks/lib/rescue.ts'], recordedEscalations: 2 }) as any).why, /escalated 2/)
  assert.match((reuseDecision({ ...base, changed: ['hooks/lib/rescue.ts'], replayedEscalations: 1 }) as any).why, /would escalate/)
  assert.match((reuseDecision({ ...base, changed: ['hooks/lib/rescue.ts'], recordedEscalations: null }) as any).why, /records are gone/)
  assert.match((reuseDecision({ ...base, sameOtherwise: ['task'] }) as any).why, /identity differs in task/)
  assert.ok(!LADDER_SCOPE.includes('hooks/lib/failures.ts'))
})

const row = (task: string, arm: string, accepted: boolean, cost: number, o: Record<string, unknown> = {}) => ({ run_id: `${task}__${arm}`, task_id: task, cohort: 'feature', arm, exit_reason: 'done', accepted, cost_usd_api_equiv: cost, ...o })
const paired = (n: number, f: (i: number) => [boolean, number, boolean, number]) => Array.from({ length: n }, (_, i) => { const [ta, tc, ca, cc] = f(i); return [row(`t${i}`, 'auto', ta, tc), row(`t${i}`, 'baseline', ca, cc)] }).flat()

test('decide: equal pass and cost ships; the interval and the pass loss block when they should', () => {
  assert.equal(decide(paired(30, () => [true, 1, true, 1]), policy).status, 'SHIP')
  const loses = paired(30, (i) => [i >= 3, 1, true, 1])
  assert.equal(decide(loses, policy).status, 'DO_NOT_SHIP')
  assert.match(decide(loses, policy).blockers.join(), /lost 3 tasks net/)
  const dearer = paired(30, () => [true, 1.5, true, 1])
  assert.equal(decide(dearer, policy).status, 'DO_NOT_SHIP', 'a 50% higher cost per accepted, with confidence')
  const noisy = paired(30, (i) => [true, i % 2 ? 2.2 : 0.2, true, 1])
  const d = decide(noisy, policy)
  assert.equal(d.status, 'INCONCLUSIVE')
  assert.match(d.blockers.join(), /CI upper/)
  assert.equal(decide(paired(10, () => [true, 1, true, 1]), policy).status, 'INCONCLUSIVE', 'too few pairs')
})

test('decide: a security regression blocks; every paid attempt counts in cost; no-result rows are not failures', () => {
  const rows = paired(30, () => [true, 1, true, 1])
  rows[0] = { ...rows[0], accepted: false, cohort: 'security' }
  rows[1] = { ...rows[1], cohort: 'security' }
  assert.match(decide(rows, policy).blockers.join(), /critical regressions: t0/)
  const withQuota = [...paired(30, () => [true, 1, true, 1]), row('t5', 'auto', false, 3, { exit_reason: 'quota' })]
  const d = decide(withQuota, policy)
  assert.equal(d.treatment.classes.infra_interrupted, 1)
  assert.equal(d.treatment.accepted, 30, 'the cut-off attempt is not a failure')
  assert.equal(d.treatment.paid_usd, 33, 'but its money counts')
  assert.equal(rowClass({ ...row('x', 'a', false, 0), harness_error: 'accept command did not finish' }), 'grader_error')
  assert.equal(rowClass({ ...row('x', 'a', false, 0), exit_reason: 'setup_error' }), 'harness_invalid')
})

test('decide is deterministic: the same rows give the same interval', () => {
  const rows = paired(30, (i) => [i !== 4, 0.5 + (i % 5) / 10, true, 0.7])
  assert.deepEqual(decide(rows, policy).cost_ratio_ci, decide(rows, policy).cost_ratio_ci)
})

test('agent environment: the accept command without its inline settings, run as the agent runs it', () => {
  assert.equal(agentCommand('PYTHONPATH=.bench-deps python3 -m unittest tests.x && test -z "$(grep x)"'), 'python3 -m unittest tests.x && test -z "$(grep x)"')
  assert.equal(agentCommand('A=1 B=2 node t.js; C=3 npm test'), 'node t.js; npm test')
  // The incident: deps in .bench-deps, a test that imports them. Without the agent path it fails; with it, it passes.
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'am-env-'))
  fs.mkdirSync(path.join(w, '.bench-deps'))
  fs.writeFileSync(path.join(w, '.bench-deps', 'dep_only_here.py'), 'X = 1\n')
  fs.writeFileSync(path.join(w, 't.py'), 'import dep_only_here\n')
  const accept = 'PYTHONPATH=.bench-deps python3 t.py'
  assert.equal(spawnSync('sh', ['-c', accept], { cwd: w }).status, 0, 'the grader passes')
  const bare = { ...process.env }; delete bare.PYTHONPATH
  assert.notEqual(spawnSync('sh', ['-c', agentCommand(accept)], { cwd: w, env: bare }).status, 0, 'the agent, before the fix, fails on imports')
  assert.equal(spawnSync('sh', ['-c', agentCommand(accept)], { cwd: w, env: workspaceEnv(w, bare) }).status, 0, 'the agent, with the grader path, passes')
  fs.rmSync(w, { recursive: true, force: true })
})

test('regrade: a saved diff is graded again with no model call', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-regrade-'))
  const src = path.join(dir, 'src')
  fs.mkdirSync(src)
  const g = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...a], { cwd: src, encoding: 'utf8' }).trim()
  g('init', '-q'); fs.writeFileSync(path.join(src, 'README'), 'x\n'); g('add', '.'); g('commit', '-q', '-m', 'base')
  const base = g('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(src, 'add.js'), 'export const add = (a, b) => a + b\n')
  fs.writeFileSync(path.join(src, 'add.test.js'), "import { add } from './add.js'\nif (add(2, 3) !== 5) process.exit(1)\n")
  g('add', '.'); g('commit', '-q', '-m', 'ref')
  const reference = g('rev-parse', 'HEAD')
  const tasks = path.join(dir, 'tasks'); fs.mkdirSync(tasks)
  fs.writeFileSync(path.join(tasks, 'r.json'), JSON.stringify({ id: 'r', cohort: 'trivial', repo: src, license: 'MIT', base, reference, task: 'x', hidden_tests: ['add.test.js'], accept: 'node add.test.js' }))
  const diffs = path.join(dir, 'diffs'); fs.mkdirSync(diffs)
  const good = 'diff --git a/add.js b/add.js\nnew file mode 100644\n--- /dev/null\n+++ b/add.js\n@@ -0,0 +1 @@\n+export const add = (a, b) => a + b\n'
  fs.writeFileSync(path.join(diffs, 'r__x__r1__a.diff'), good)
  fs.writeFileSync(path.join(diffs, 'r__x__r1__b.diff'), good.replace('a + b', 'a - b'))
  const results = path.join(dir, 'res.jsonl')
  fs.writeFileSync(results, [{ run_id: 'r__x__r1__a', task_id: 'r', arm: 'x', accepted: false }, { run_id: 'r__x__r1__b', task_id: 'r', arm: 'x', accepted: true }].map((r) => JSON.stringify(r)).join('\n') + '\n')
  // A claude on PATH that records any call: regrading must make none.
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho called >> "${path.join(dir, 'calls')}"\n`, { mode: 0o755 })
  const out = spawnSync(process.execPath, ['bench/regrade.mts', results, '--diffs', diffs, '--scratch', path.join(dir, 's'), '--tasks-dir', tasks], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BENCH_ALLOW_LOCAL: '1', BENCH_CACHE_DIR: path.join(dir, 'repos') } })
  assert.equal(out.status, 0, out.stderr)
  const grades = fs.readFileSync(results.replace(/\.jsonl$/, '.grades-v1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(grades.map((x) => [x.run_id, x.accepted, x.changed]), [['r__x__r1__a', true, true], ['r__x__r1__b', false, true]])
  assert.equal(fs.existsSync(path.join(dir, 'calls')), false, 'no model call')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('agent environment: every path the accept command sets, made absolute; src layouts too (jinja, marshmallow)', async () => {
  const { graderPaths } = await import('./runners/claude-code.mts')
  assert.deepEqual(graderPaths('PYTHONPATH=src:.bench-deps python3 -m pytest -q tests', '/w'), { PYTHONPATH: '/w/src:/w/.bench-deps' })
  assert.deepEqual(graderPaths('npm ci && NODE_PATH=lib FOO=1 node t.js', '/w'), { NODE_PATH: '/w/lib' })
  assert.deepEqual(graderPaths('node t.js', '/w'), {})
  const env = workspaceEnv('/w', { PYTHONPATH: '/x' }, 'PYTHONPATH=src python3 t.py')
  assert.equal(env.PYTHONPATH, '/w/src:/x')
})
