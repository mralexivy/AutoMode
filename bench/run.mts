#!/usr/bin/env node
// AutoMode benchmark runner. Resumable: a run whose id is already in the results file is skipped.
//
// Usage: node bench/run.mts [--experiment light|effort|auto|stage-a|stage-b|stage-c|file.json] [--tasks a,b] [--arms x,y] [--repeats 3] [--parallel 1]
//                           [--run-cap-usd 3] [--budget-usd 15] [--scratch dir] [--out file] [--timeout-min 40] [--dry-run]
//
// Usage window: --window-usd caps list-price-equivalent spend per rolling 5 hours, from the ledger (default 10). A full
// window waits, or ends the run with --stop-at-window. A usage limit waits --quota-wait-min (30), then tries the same
// run again, up to --quota-retries times (10). Stopping is always safe: a resume continues.
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
import { RunQueue, waitMs } from './lib/pacer.mts'
import { loadTemplate } from './lib/prompt.mts'
import { chargedUsd, isDone } from './lib/outcome.mts'
import { oneRun, runIdFor, type RunContext } from './lib/run-one.mts'
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
const repeats = Number(opt('repeats', 3))
const parallelRuns = Number(opt('parallel', 1))
const scratch = opt('scratch', path.join(os.tmpdir(), 'am-bench'))
const out = opt('out', path.join(REPO, 'bench', 'results', 'results.jsonl'))
const timeoutMs = Number(opt('timeout-min', 40)) * 60_000
const runCap = opt('run-cap-usd') ? Number(opt('run-cap-usd')) : null
const budget = opt('budget-usd') ? Number(opt('budget-usd')) : null
// A run on a plan stays under a share of the 5-hour window. Off for an API account (BENCH_AUTH=api) unless asked for.
const windowUsd = Number(opt('window-usd', experiment?.window_usd ?? (process.env.BENCH_AUTH === 'api' ? 0 : 10)))
const quotaWaitMs = Number(opt('quota-wait-min', 30)) * 60_000
const quotaRetries = Number(opt('quota-retries', 10))
for (const t of allTasks) { const bad = problems(t, { allowLocal: process.env.BENCH_ALLOW_LOCAL === '1' }); if (bad.length) throw new Error(`task ${t.id ?? '?'}: ${bad.join('; ')}`) }
if (!tasks.length) { console.log('No tasks to run. Add one in bench/tasks (see bench/tasks/README.md).'); process.exit(0) }
for (const a of arms) if (!ARMS[a]) throw new Error(`unknown arm ${a}; known: ${Object.keys(ARMS).join(', ')}`)

function doneIds() {
  if (!fs.existsSync(out)) return new Set()
  return new Set(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => { try { const r = JSON.parse(l); return isDone(r) ? r.run_id : null } catch { return null } }))
}

const plan: [Task, string, number][] = []
for (let rep = 1; rep <= repeats; rep++) for (const t of tasks) for (const a of arms) plan.push([t, a, rep])
const skip = doneIds()
const templateId = experiment?.prompt_template
const idOf = ([t, a, r]: [Task, string, number]) => runIdFor(t, a, r, loadTemplate(templateId ?? t.prompt_template ?? 'repo-change-v1')).runId
const todo = plan.filter((p) => !skip.has(idOf(p)))
console.log(`${plan.length} runs planned, ${plan.length - todo.length} already done, ${todo.length} to run (${parallelRuns} at a time).` +
  `${runCap ? ` Cap per run: $${runCap}.` : ''}${budget ? ` Total budget: $${budget}.` : ''}`)
if (flag('dry-run')) { for (const [t, a, r] of todo) console.log(`  ${t.id} / ${a} / r${r}`); process.exit(0) }

fs.mkdirSync(path.dirname(out), { recursive: true })
const ctx: RunContext = { scratch, out, timeoutMs, runCap, experiment: experiment?.id, template: templateId }
// One batch per results file, so a resume keeps counting what the earlier runs spent.
const batch = `run:${path.basename(out)}`
let spent = total(LEDGER, batch)
const queue = new RunQueue(todo, quotaRetries)
let stopped = false
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// paced returns once a run may start, or false if the study stops here.
async function paced() {
  for (;;) {
    const wait = Math.max(queue.pausedUntil - Date.now(), waitMs(entries(), Date.now(), windowUsd))
    if (wait <= 0) return true
    if (flag('stop-at-window')) { console.log('The usage window is full. Run the same command later to continue.'); return false }
    console.log(`Usage window: waiting ${Math.ceil(wait / 60_000)} min. Stop any time; a resume continues.`)
    await sleep(Math.min(wait, 60_000))
  }
}

async function worker() {
  while (queue.size && !stopped) {
    if (budget && spent >= budget) { console.log(`Budget $${budget} reached ($${spent.toFixed(2)} spent). No new runs start.`); return }
    if (!(await paced())) { stopped = true; return }
    const item = queue.take()
    if (!item) return
    const [t, a, r] = item
    const row: any = await oneRun(t, a, r, ctx).catch((e) => ({ run_id: idOf(item), task_id: t.id, cohort: t.cohort, arm: a, repeat: r, harness_error: String(e.message || e), at: new Date().toISOString() }))
    const charge = chargedUsd(row.cost_usd_api_equiv, runCap)
    spent += charge.usd
    add({ batch, what: row.run_id, usd: charge.usd, source: charge.known ? 'cli total_cost_usd' : 'run cap: no cost reported' })
    fs.appendFileSync(out, JSON.stringify(row) + '\n')
    console.log(`${row.run_id}: ${row.harness_error ? 'HARNESS ERROR ' + row.harness_error : row.exit_reason === 'quota' ? 'USAGE LIMIT, will rerun' : row.exit_reason === 'setup_error' ? 'SETUP FAILED, will rerun' : (row.accepted ? 'accepted' : 'rejected')} ` +
      `$${row.cost_usd_api_equiv?.toFixed?.(2) ?? '?'} ${row.wall_s ?? '?'}s`)
    if (row.exit_reason === 'quota' && !queue.limitHit(item, Date.now(), quotaWaitMs)) {
      console.log('The usage limit did not clear. Stopping. Run the same command later to continue.')
      stopped = true
    }
  }
}
await Promise.all(Array.from({ length: parallelRuns }, worker))
