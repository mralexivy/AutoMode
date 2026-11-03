#!/usr/bin/env node
// AutoMode benchmark runner. Resumable: a run whose id is already in the results file is skipped.
//
// Usage: node bench/run.mts [--experiment light|effort|auto|stage-a|stage-b|stage-c|file.json] [--tasks a,b] [--arms x,y] [--repeats 3] [--parallel 1]
//                           [--run-cap-usd 3] [--budget-usd 15] [--scratch dir] [--out file] [--timeout-min 40] [--dry-run]
//
// Usage window: --window-usd caps list-price-equivalent spend per rolling 5 hours, from the ledger (default 10). A full
// window waits, or ends the run with --stop-at-window. A usage limit pauses the whole run at once: no new run starts,
// the pause and any reset time the CLI stated go to the ledger, and the runner exits 75. bench/supervise.mts resumes at
// a stated reset; with none it stays paused for a manual resume. Stopping is always safe: a resume continues.
//
// Paid runs are gated (bench/BENCHMARK_RUNBOOK.md): a run needs a passing preflight report for this exact plan, and
// the machine-wide lock. Only the fake `claude` of the tests skips the gate. Every state change goes to the run ledger
// (<out>.events.jsonl); a run left RUNNING by a dead process is UNKNOWN and reruns only with --retry-unknown.
// --reuse-from a.jsonl,b.jsonl copies finished rows with the same run id from earlier files instead of paying again.
//
// Spend limits: --run-cap-usd passes --max-budget-usd to each claude run (a hard stop per run).
// --budget-usd stops scheduling new runs once the recorded API-equivalent cost reaches it (runs
// already started finish). The total comes from the spend ledger, so it survives a resume. A run with
// no reported cost counts as its cap. The "light" preset is 2 tasks x 4 arms x 1 repeat with both limits on.
//
// A usage limit or a failed setup says nothing about the arm: those rows are no result, and a resume
// runs them again. The agent gets no API key unless BENCH_AUTH=api is set (see billingEnv in arms.mts).
//
// For each task, arm, and repeat it:
//   1. clones the repo into the scratch folder and checks out the task's base commit. A clone, not a
//      worktree: worktrees share the main repo's Claude Code project memory, which leaked answers
//      into the first light run (2026-10-19).
//   2. runs `claude -p` with the arm's flags (see arms.mts)
//   3. saves the agent's change, then restores the hidden tests from the reference commit and runs the acceptance command
//   4. appends one JSON line: outcome, diff size, cost, tokens, the per-stage trace, wall time
// Raw results never contain prompt text or file contents.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ARMS } from './arms.mts'
import { loadExperiment } from './lib/experiment.mts'
import { add, entries, LEDGER, total } from './lib/ledger.mts'
import { waitMs } from './lib/pacer.mts'
import { admit, expectedUsd, resetAt, savedHistory } from './lib/admission.mts'
import { appendEvent, eventsFile, foldEvents, readEvents } from './lib/events.mts'
import { gateProblem, isFake, planHash, readReport, reportPath } from './lib/gate.mts'
import { acquire } from './lib/lock.mts'
import { harnessInfo } from './lib/result.mts'
import { loadTemplate } from './lib/prompt.mts'
import { chargedUsd, isDone, isResult } from './lib/outcome.mts'
import { oneRun, runIdFor, type RunContext } from './lib/run-one.mts'
import { claudeCodeRunner } from './runners/claude-code.mts'
import { neutralRunner } from './runners/neutral-agent.mts'
import { loadTasks, problems, TASKS_DIR, type Task } from './lib/task-repo.mts'

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
// --preset is the older name for --experiment.
const experimentId = arg('experiment') ?? arg('preset')
const experiment = experimentId ? loadExperiment(experimentId, Object.keys(ARMS)) : null
const fromSpec: Record<string, unknown> = experiment ? { arms: experiment.arms.join(','), tasks: experiment.tasks?.join(','), repeats: experiment.repeats, parallel: experiment.parallel, 'run-cap-usd': experiment.run_cap_usd, 'budget-usd': experiment.budget_usd } : {}
const opt = (name: string, def?: unknown): any => arg(name) ?? fromSpec[name] ?? def
const flag = (name: string) => process.argv.includes(`--${name}`)
const allTasks = loadTasks(opt('tasks-dir', TASKS_DIR))
const tasks = opt('tasks') ? allTasks.filter((t) => opt('tasks').split(',').includes(t.id)) : allTasks
const arms = opt('arms') ? opt('arms').split(',') : Object.keys(ARMS)
for (const a of arms) if (!ARMS[a]) throw new Error(`unknown arm ${a}; known: ${Object.keys(ARMS).join(', ')}`)
const repeats = Number(opt('repeats', 3))
const parallelRuns = Number(opt('parallel', 1))
const scratch = opt('scratch', path.join(os.tmpdir(), 'am-bench'))
// An experiment's rows go to its own file by default, so its resume, its ledger and its preflight all find them.
const out = path.resolve(opt('out', path.join(REPO, 'bench', 'results', `${experiment?.id ?? 'results'}.jsonl`)))
const timeoutMs = Number(opt('timeout-min', 40)) * 60_000
const runCap = opt('run-cap-usd') ? Number(opt('run-cap-usd')) : null
const budget = opt('budget-usd') ? Number(opt('budget-usd')) : null
// A run on a plan stays under a share of the 5-hour window. Off for an API account (BENCH_AUTH=api) unless asked for.
const usesPlan = arms.some((a) => !ARMS[a].runner && !ARMS[a].gateway)
const windowUsd = Number(opt('window-usd', experiment?.window_usd ?? (process.env.BENCH_AUTH === 'api' || !usesPlan ? 0 : 10)))
for (const t of allTasks) { const bad = problems(t, { allowLocal: process.env.BENCH_ALLOW_LOCAL === '1' }); if (bad.length) throw new Error(`task ${t.id ?? '?'}: ${bad.join('; ')}`) }
if (!tasks.length) { console.log('No tasks to run. Add one in bench/tasks (see bench/tasks/README.md).'); process.exit(0) }

const readRows = (file: string): any[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : [])
const rows = readRows(out)
const events = eventsFile(out)

const plan: [Task, string, number][] = []
for (let rep = 1; rep <= repeats; rep++) for (const t of tasks) for (const a of arms) plan.push([t, a, rep])
const templateId = experiment?.prompt_template
const idOf = ([t, a, r]: [Task, string, number]) => runIdFor(t, a, r, loadTemplate(templateId ?? t.prompt_template ?? 'repo-change-v1')).runId
const done = new Set(rows.filter(isDone).map((r) => r.run_id))

// Reuse: a finished row with the same run id in an earlier file is the same execution, so it is copied, not paid for.
const reuseFrom: string[] = (opt('reuse-from') ? String(opt('reuse-from')).split(',') : experiment?.reuse_from ?? []).filter(Boolean)
const planned = new Set(plan.map(idOf))
const reused: any[] = []
for (const file of reuseFrom) for (const r of readRows(path.isAbsolute(file) ? file : path.join(REPO, file))) {
  if (planned.has(r.run_id) && !done.has(r.run_id) && isResult(r) && r.identity) { reused.push({ ...r, reused_from: path.basename(file) }); done.add(r.run_id) }
}

// A run whose owner died with no result may have been billed: it waits for --retry-unknown.
const state = foldEvents(readEvents(events))
const unknown = plan.filter((p) => !done.has(idOf(p)) && state.get(idOf(p))?.state === 'UNKNOWN')
const retryUnknown = flag('retry-unknown')
const todo = plan.filter((p) => !done.has(idOf(p)) && (retryUnknown || state.get(idOf(p))?.state !== 'UNKNOWN'))
console.log(`${plan.length} runs planned, ${plan.length - todo.length - (retryUnknown ? 0 : unknown.length)} already done (${reused.length} reused), ${unknown.length} unknown${unknown.length && !retryUnknown ? ' (held: --retry-unknown)' : ''}, ${todo.length} to run (${parallelRuns} at a time).` +
  `${runCap ? ` Cap per run: $${runCap}.` : ''}${budget ? ` Total budget: $${budget}.` : ''}`)
if (flag('dry-run')) { for (const [t, a, r] of todo) console.log(`  ${t.id} / ${a} / r${r}`); process.exit(0) }

// The gate: a paid run needs a passing preflight for this exact plan. The tests' fake claude skips it.
const fake = isFake(harnessInfo().runner_version)
if (!fake) {
  const hash = planHash({ experiment: experiment?.id ?? 'adhoc', runIds: [...planned], budget, runCap, policy: experiment?.decision ?? null })
  const problem = gateProblem(readReport(reportPath(path.dirname(out), experiment?.id ?? 'adhoc')), hash)
  if (problem) { console.error(`Not starting: ${problem}`); process.exit(2) }
  if (!experiment) { console.error('Not starting: a paid run needs --experiment, so its plan can be checked.'); process.exit(2) }
}
const lock = acquire(experiment?.id ?? 'adhoc')
if ('holder' in lock) { console.error(`Not starting: ${lock.holder.experiment} holds the benchmark lock (pid ${lock.holder.pid} on ${lock.holder.host}, heartbeat ${lock.holder.heartbeat}).`); process.exit(3) }
if ('tookOver' in lock && lock.tookOver) console.log(`Took over a stale lock from pid ${lock.tookOver.pid} (${lock.tookOver.experiment}).`)
process.on('exit', () => { if ('release' in lock) lock.release() })

fs.mkdirSync(path.dirname(out), { recursive: true })
for (const r of reused) { fs.appendFileSync(out, JSON.stringify(r) + '\n'); appendEvent(events, { run_id: r.run_id, state: 'COMPLETED', reason: `reused from ${r.reused_from}` }) }
const neutral = neutralRunner()
const ctx: RunContext = { scratch, out, timeoutMs, runCap, experiment: experiment?.id, template: templateId, runnerFor: (armId) => (ARMS[armId].runner === 'neutral-agent' ? neutral : claudeCodeRunner) }
// One batch per results file, so a resume keeps counting what the earlier runs spent.
const batch = `run:${path.basename(out)}`
let spent = total(LEDGER, batch)
const history = savedHistory(path.dirname(out), readRows)
const queue = [...todo]
const inFlight = new Map<string, number>()
let stopped: null | { code: number; why: string } = null
let lastReset: string | null = null
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// paced returns once a run may start, or false if the study stops here.
async function paced() {
  for (;;) {
    if (stopped) return false
    const wait = waitMs(entries(), Date.now(), windowUsd)
    if (wait <= 0) return true
    if (flag('stop-at-window')) { console.log('The usage window is full. Run the same command later to continue.'); return false }
    console.log(`Usage window: waiting ${Math.ceil(wait / 60_000)} min. Stop any time; a resume continues.`)
    await sleep(Math.min(wait, 60_000))
  }
}

async function worker() {
  while (queue.length && !stopped) {
    if (!(await paced())) return
    const item = queue[0]
    const [t, a, r] = item
    const id = idOf(item)
    const next = expectedUsd(history, t.id, a, runCap, ARMS[a].model)
    const adm = admit({ budget, spent, inFlight: [...inFlight.values()].reduce((x, y) => x + y, 0), next })
    if (!adm.admit) { console.log(`Budget: not starting ${id}: ${adm.reason}. No new runs start.`); return }
    queue.shift()
    inFlight.set(id, next)
    const attempt = `${process.pid}-${Date.now()}`
    appendEvent(events, { run_id: id, state: 'RUNNING', attempt, reason: adm.reason })
    const row: any = await oneRun(t, a, r, ctx).catch((e) => ({ run_id: id, task_id: t.id, cohort: t.cohort, arm: a, repeat: r, harness_error: String(e.message || e), at: new Date().toISOString() }))
    inFlight.delete(id)
    const charge = chargedUsd(row.cost_usd_api_equiv, runCap)
    spent += charge.usd
    add({ batch, what: row.run_id, usd: charge.usd, source: charge.known ? 'cli total_cost_usd' : 'run cap: no cost reported' })
    // The row first, synced, then its terminal event: a crash between them leaves a row, which counts as finished.
    const fd = fs.openSync(out, 'a'); fs.writeSync(fd, JSON.stringify(row) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd)
    const quota = row.exit_reason === 'quota'
    const reset = quota ? resetAt(`${row.limit_message ?? ''}\n${row.stderr_tail?.join('\n') ?? ''}`, new Date()) : null
    const terminal = row.harness_error ? 'INVALID' : quota ? 'QUOTA_PAUSED' : row.exit_reason === 'setup_error' ? 'INVALID' : 'COMPLETED'
    appendEvent(events, { run_id: id, state: terminal, attempt, cost_usd: row.cost_usd_api_equiv ?? null, session_id: row.session_id ?? null, reset_at: reset, reason: row.harness_error ?? row.exit_reason })
    console.log(`${row.run_id}: ${row.harness_error ? 'HARNESS ERROR ' + row.harness_error : quota ? 'USAGE LIMIT, paused' : row.exit_reason === 'setup_error' ? 'SETUP FAILED' : (row.accepted ? 'accepted' : 'rejected')} ` +
      `$${row.cost_usd_api_equiv?.toFixed?.(2) ?? '?'} ${row.wall_s ?? '?'}s`)
    // A usage limit pauses everything at once. A setup failure or harness fault is an integrity defect: the plan
    // passed preflight and still broke, so no more money goes into it until someone looks.
    if (quota) lastReset = reset ?? lastReset
    if (quota) stopped = { code: 75, why: `usage limit; ${reset ? `the CLI says it resets at ${reset}` : 'no reset time stated: resume by hand'}` }
    else if (terminal === 'INVALID') stopped = { code: 4, why: `integrity defect on ${id}: ${row.harness_error ?? 'setup failed'}` }
  }
}
await Promise.all(Array.from({ length: parallelRuns }, worker))
const status = { at: new Date().toISOString(), experiment: experiment?.id ?? 'adhoc', state: stopped ? (stopped.code === 75 ? 'quota_paused' : 'aborted') : queue.length ? 'stopped' : 'done', why: stopped?.why ?? null, remaining: queue.length, reset_at: lastReset }
fs.writeFileSync(out.replace(/\.jsonl$/, '') + '.status.json', JSON.stringify(status, null, 2))
if (stopped) { console.log(`Stopped: ${stopped.why}. Run the same command to continue.`); process.exit(stopped.code) }
