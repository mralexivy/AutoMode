#!/usr/bin/env node
// preflight.mts --experiment <id> [--out file] [--skip tests,plugin-tests,fixtures,history] [--json]
// The free gate before any paid run. No model call. It checks, on this machine:
//   experiment   the file loads, its arms and tasks exist, its decision policy exists and is committed
//   split        no task from the held-out split is in a non-screen experiment (the lark leak)
//   fixtures     each task's reference passes and its base fails, with the hidden tests (the pymarkdown-v2 fixture)
//   agent-env    the reference also passes when the tests run the way the agent runs them: the agent's environment,
//                with the accept command's own inline settings removed (the missing PYTHONPATH)
//   history      every saved benchmark session replays through the current ladder without a crash, and no run whose
//                tests reported failures reads as environment noise (the setuptools_scm misreading)
//   tests        npm run check, and claude plugin test (local test kit, no model)
//   tree         the behavior files and the experiment are committed: the plan names a commit that exists
//   lock         no other paid experiment holds the machine-wide lock
//   budget       the expected cost of the new paid slots fits the budget
// It writes bench/results/preflight/<id>.json with the plan hash. bench/run.mts starts a paid run only for that hash.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ARMS } from './arms.mts'
import { loadExperiment } from './lib/experiment.mts'
import { readEvents } from './lib/events.mts'
import { expectedUsd } from './lib/admission.mts'
import { reportPath, type CheckResult, type PreflightReport } from './lib/gate.mts'
import { taskHash } from './lib/identity.mts'
import { lockHeld, readLock } from './lib/lock.mts'
import { classify, hashOf, readRows, slotsFor } from './lib/plan.mts'
import { replay, toolEvents } from './lib/replay.mts'
import { removeTree } from './lib/run-one.mts'
import { configDir } from './lib/run-evidence.mts'
import { loadTasks, problems, taskRepo, type Task } from './lib/task-repo.mts'
import { workspaceEnv } from './runners/claude-code.mts'
import { freshWorkspace, runAccept, writeHiddenTests } from './validate-fixture.mts'
import { classify as classifyFailure, isCheck } from '../hooks/lib/failures.ts'
import { HELDOUT } from './split.mts'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const argv = process.argv.slice(2)
const arg = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }
const skip = new Set((arg('skip') ?? '').split(',').filter(Boolean))

// agentCommand is the accept command as an agent would type it: no inline VAR=value settings, which only the grader
// knows about. If the reference fails this way, the agent cannot see its own tests pass, and the task is unfit.
export const agentCommand = (accept: string) => accept.replace(/(^|&&|\|\||;)\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/g, '$1 ').trim()

// machine names what a fixture verdict depends on besides the task: interpreter and package versions on this host.
export function machine(): string {
  const run = (c: string[]) => { const r = spawnSync(c[0], c.slice(1), { encoding: 'utf8', timeout: 60_000 }); return r.status === 0 ? r.stdout.trim() : `none:${c[0]}` }
  return createHash('sha256').update([process.platform, process.arch, run(['python3', '--version']), run(['python3', '-m', 'pip', 'list', '--format=freeze']), run(['node', '--version']), run(['git', '--version'])].join('\n')).digest('hex').slice(0, 16)
}

export interface FixtureVerdict { id: string; task_hash: string; machine: string; at: string; base: 'pass' | 'fail' | 'error'; reference: 'pass' | 'fail' | 'error'; agent_env: 'pass' | 'fail' | 'error'; valid: boolean; why: string }

export function fixtureVerdict(task: Task, dir: string, host: string): FixtureVerdict {
  const head = { id: task.id, task_hash: taskHash(task), machine: host, at: new Date().toISOString() }
  const bad = problems(task, { allowLocal: process.env.BENCH_ALLOW_LOCAL === '1' })
  if (bad.length) return { ...head, base: 'error', reference: 'error', agent_env: 'error', valid: false, why: bad.join('; ') }
  const w = path.join(dir, task.id)
  try {
    const cache = taskRepo(task)
    freshWorkspace(task, cache, task.base, w)
    writeHiddenTests(task, cache, w)
    const base = runAccept(task, w).status === 0 ? 'pass' : 'fail'
    freshWorkspace(task, cache, task.reference, w)
    const reference = runAccept(task, w).status === 0 ? 'pass' : 'fail'
    const agent = spawnSync('sh', ['-c', agentCommand(task.accept)], { cwd: w, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 1e9, env: workspaceEnv(w, process.env) })
    const agent_env = agent.status === 0 ? 'pass' : 'fail'
    const why = base === 'pass' ? 'the hidden tests already pass at the base' : reference === 'fail' ? 'the reference fails its own accept check on this machine' : agent_env === 'fail' ? 'the reference fails when the tests run as the agent runs them' : 'ok'
    return { ...head, base, reference, agent_env, valid: why === 'ok', why }
  } catch (e) {
    return { ...head, base: 'error', reference: 'error', agent_env: 'error', valid: false, why: (e as Error).message }
  } finally { removeTree(w) }
}

// historyCheck replays every saved benchmark session. A crash, or a run whose own tests said FAILED but reads as
// environment, blocks: that is the class of bug that made the ladder a no-op.
export function historyCheck(root = path.join(configDir(), 'projects')): { sessions: number; checks: number; misread: string[]; crashed: string[]; escalating: number } {
  const out = { sessions: 0, checks: 0, misread: [] as string[], crashed: [] as string[], escalating: 0 }
  if (!fs.existsSync(root)) return out
  for (const d of fs.readdirSync(root).filter((x) => x.includes('am-bench'))) {
    for (const f of fs.readdirSync(path.join(root, d)).filter((x) => x.endsWith('.jsonl'))) {
      out.sessions++
      try {
        const evs = toolEvents(path.join(root, d, f))
        for (const e of evs) if (e.tool === 'Bash' && isCheck(e.cmd) && e.err) {
          out.checks++
          if (/^FAILED \((?:failures|errors)=[1-9]|^\s*\d+ failed\b|^--- FAIL: /m.test(e.out) && !/^\s*(?:E\s+)?(?:ModuleNotFoundError|ImportError)\b/m.test(e.out) && classifyFailure(e.out) === 'environment') out.misread.push(f)
        }
        if (replay(evs, { stop: true }).escalations > 0) out.escalating++
      } catch (err) { out.crashed.push(`${f}: ${(err as Error).message}`) }
    }
  }
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const id = arg('experiment')
  if (!id) { console.error('usage: preflight.mts --experiment <id>'); process.exit(1) }
  const checks: CheckResult[] = []
  const check = (name: string, ok: boolean, detail: string, blocking = true) => { checks.push({ name, ok, detail, blocking }); console.log(`${ok ? 'ok  ' : blocking ? 'FAIL' : 'warn'} ${name}: ${detail}`) }

  const e = loadExperiment(id, Object.keys(ARMS))
  const out = path.resolve(REPO, arg('out') ?? path.join('bench', 'results', `${id}.jsonl`))
  const all = loadTasks()
  const tasks = all.filter((t) => (e.tasks ?? []).includes(t.id))
  const missing = (e.tasks ?? []).filter((t) => !tasks.some((x) => x.id === t))
  const policy = e.decision ? path.join(REPO, e.decision) : null
  check('experiment', !missing.length && !!policy && fs.existsSync(policy), missing.length ? `unknown tasks: ${missing.join(', ')}` : !policy ? 'no decision policy named: fix one before any row' : !fs.existsSync(policy) ? `policy ${e.decision} is missing` : `${tasks.length} tasks x ${e.arms.length} arms x ${e.repeats}; policy ${e.decision}`)

  const held = fs.existsSync(HELDOUT) ? JSON.parse(fs.readFileSync(HELDOUT, 'utf8')) : { screen: [], confirm: [], screen_experiment: null }
  const leaked = (e.tasks ?? []).filter((t) => held.confirm.includes(t) || (held.screen.includes(t) && e.id !== held.screen_experiment))
  check('split', !leaked.length, leaked.length ? `held-out tasks in this experiment: ${leaked.join(', ')}` : 'no held-out task')

  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'hooks', 'agents', 'commands', 'output-styles', 'workflows', 'config.json', '.claude-plugin', 'bench/experiments', 'bench/tasks', 'bench/lib', 'bench/runners', 'bench/run.mts'], { cwd: REPO, encoding: 'utf8' }).trim()
  check('tree', !dirty, dirty ? `uncommitted: ${dirty.split('\n').slice(0, 5).join('; ')}` : `clean at ${execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()}`)

  const slots = slotsFor(tasks, e.arms, e.repeats, e.prompt_template)
  const views = classify(slots, out, (e.reuse_from ?? []).map((f) => path.resolve(REPO, f)))
  const count = (s: string) => views.filter((v) => v.status === s).length
  const history = [...readRows(out), ...(e.reuse_from ?? []).flatMap((f) => readRows(path.resolve(REPO, f)))]
  const estimate = views.filter((v) => v.status === 'new' || v.status === 'stale').reduce((a, v) => a + expectedUsd(history, v.task, v.arm, e.run_cap_usd ?? null), 0)
  check('budget', !e.budget_usd || estimate <= e.budget_usd, `${views.length} slots: ${count('done')} done, ${count('reuse')} reused, ${count('unknown')} unknown, ${count('stale')} stale, ${count('new')} new; new paid slots expected $${estimate.toFixed(2)} of $${e.budget_usd ?? '-'}`)

  const holder = readLock()
  check('lock', !lockHeld(holder), lockHeld(holder) ? `${holder!.experiment} is running (pid ${holder!.pid})` : 'free')

  if (!skip.has('fixtures')) {
    const host = machine()
    const cacheDir = path.join(path.dirname(reportPath(path.dirname(out), id)), 'fixtures')
    fs.mkdirSync(cacheDir, { recursive: true })
    const verdicts = tasks.map((t) => {
      const file = path.join(cacheDir, `${t.id}.json`)
      const prior = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as FixtureVerdict : null
      if (prior && prior.task_hash === taskHash(t) && prior.machine === host) return prior
      const v = fixtureVerdict(t, path.join(os.tmpdir(), 'am-preflight'), host)
      fs.writeFileSync(file, JSON.stringify(v, null, 1))
      console.log(`     ${t.id}: ${v.valid ? 'valid' : `INVALID: ${v.why}`}`)
      return v
    })
    const bad = verdicts.filter((v) => !v.valid)
    check('fixtures', !bad.length, bad.length ? `${bad.length} invalid: ${bad.map((v) => `${v.id} (${v.why})`).join('; ')}` : `${verdicts.length} valid on machine ${host}, agent environment included`)
  } else check('fixtures', false, 'skipped', true)

  if (!skip.has('history')) {
    const h = historyCheck()
    check('history', !h.crashed.length && !h.misread.length, `${h.sessions} saved sessions, ${h.checks} failed checks replayed, ${h.escalating} would escalate now; misread: ${h.misread.length}; crashed: ${h.crashed.length}`, h.sessions > 0)
  }

  if (!skip.has('tests')) {
    const t = spawnSync('npm', ['run', 'check'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1e8 })
    const sum = (t.stdout.match(/ℹ (pass|fail) \d+/g) ?? []).join(', ')
    check('tests', t.status === 0, t.status === 0 ? `npm run check: ${sum}` : `npm run check failed: ${sum}`)
  }
  if (!skip.has('plugin-tests')) {
    const t = spawnSync('claude', ['plugin', 'test', '.'], { cwd: REPO, encoding: 'utf8', maxBuffer: 1e8 })
    const sum = (t.stdout.match(/\d+ (pass|fail)/g) ?? []).join(', ')
    check('plugin-tests', t.status === 0, sum || `exit ${t.status}`)
  }

  const report: PreflightReport = { experiment: id, plan_hash: hashOf(e, slots, e.budget_usd ?? null, e.run_cap_usd ?? null), at: new Date().toISOString(), pass: checks.every((c) => c.ok || !c.blocking), checks, slots: views, estimate_usd: Math.round(estimate * 100) / 100 }
  const file = reportPath(path.dirname(out), id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(report, null, 1))
  console.log(`\n${report.pass ? 'PASS' : 'FAIL'}: plan ${report.plan_hash}, ${views.length} slots, new paid slots expected $${report.estimate_usd}. Report: ${path.relative(REPO, file)}`)
  process.exit(report.pass ? 0 : 1)
}
