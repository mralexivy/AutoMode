#!/usr/bin/env node
// AutoMode benchmark runner. Resumable: a run whose id is already in the results file is skipped.
//
// Usage: node bench/run.mts [--preset light|effort|auto] [--tasks a,b] [--arms x,y] [--repeats 3] [--parallel 2]
//                           [--run-cap-usd 3] [--budget-usd 15] [--scratch dir] [--out file] [--timeout-min 40] [--dry-run]
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
import { add, LEDGER, total } from './lib/ledger.mts'
import { chargedUsd, isDone } from './lib/outcome.mts'
import { oneRun, type RunContext } from './lib/run-one.mts'
import { loadTasks, problems, type Task } from './lib/task-repo.mts'

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const PRESETS = {
  light: { arms: 'sonnet,opus,auto', repeats: '1', parallel: '1', 'run-cap-usd': '3', 'budget-usd': '15' },
  effort: { arms: 'opus-medium,opus-high,opus-effortless,auto', repeats: '3', parallel: '2', 'run-cap-usd': '3', 'budget-usd': '40' },
  auto: { arms: 'opus,sonnet,auto', repeats: '3', parallel: '2', 'run-cap-usd': '3', 'budget-usd': '30' },
}
const presetName = (() => { const i = process.argv.indexOf('--preset'); return i >= 0 ? process.argv[i + 1] : null })()
if (presetName && !PRESETS[presetName]) throw new Error(`unknown preset ${presetName}; known: ${Object.keys(PRESETS).join(', ')}`)
const opt = (name: string, def?: unknown): any => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : (presetName && PRESETS[presetName][name]) ?? def }
const flag = (name: string) => process.argv.includes(`--${name}`)
const allTasks = loadTasks()
const tasks = opt('tasks') ? allTasks.filter((t) => opt('tasks').split(',').includes(t.id)) : allTasks
const arms = opt('arms') ? opt('arms').split(',') : Object.keys(ARMS)
const repeats = Number(opt('repeats', 3))
const parallelRuns = Number(opt('parallel', 2))
const scratch = opt('scratch', path.join(os.tmpdir(), 'am-bench'))
const out = opt('out', path.join(REPO, 'bench', 'results', 'results.jsonl'))
const timeoutMs = Number(opt('timeout-min', 40)) * 60_000
const runCap = opt('run-cap-usd') ? Number(opt('run-cap-usd')) : null
const budget = opt('budget-usd') ? Number(opt('budget-usd')) : null
for (const t of allTasks) { const bad = problems(t); if (bad.length) throw new Error(`task ${t.id ?? '?'}: ${bad.join('; ')}`) }
if (!tasks.length) { console.log('No tasks to run. Add one in bench/tasks (see bench/tasks/README.md).'); process.exit(0) }
for (const a of arms) if (!ARMS[a]) throw new Error(`unknown arm ${a}; known: ${Object.keys(ARMS).join(', ')}`)

function doneIds() {
  if (!fs.existsSync(out)) return new Set()
  return new Set(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => { try { const r = JSON.parse(l); return isDone(r) ? r.run_id : null } catch { return null } }))
}

const plan: [Task, string, number][] = []
for (let rep = 1; rep <= repeats; rep++) for (const t of tasks) for (const a of arms) plan.push([t, a, rep])
const skip = doneIds()
const todo = plan.filter(([t, a, r]) => !skip.has(`${t.id}__${a}__r${r}`))
console.log(`${plan.length} runs planned, ${plan.length - todo.length} already done, ${todo.length} to run (${parallelRuns} at a time).` +
  `${runCap ? ` Cap per run: $${runCap}.` : ''}${budget ? ` Total budget: $${budget}.` : ''}`)
if (flag('dry-run')) { for (const [t, a, r] of todo) console.log(`  ${t.id} / ${a} / r${r}`); process.exit(0) }

fs.mkdirSync(path.dirname(out), { recursive: true })
const ctx: RunContext = { scratch, out, timeoutMs, runCap }
// One batch per results file, so a resume keeps counting what the earlier runs spent.
const batch = `run:${path.basename(out)}`
let next = 0
let spent = total(LEDGER, batch)
async function worker() {
  while (next < todo.length) {
    if (budget && spent >= budget) { console.log(`Budget $${budget} reached ($${spent.toFixed(2)} spent). No new runs start.`); return }
    const [t, a, r] = todo[next++]
    const row: any = await oneRun(t, a, r, ctx).catch((e) => ({ run_id: `${t.id}__${a}__r${r}`, task_id: t.id, cohort: t.cohort, arm: a, repeat: r, harness_error: String(e.message || e), at: new Date().toISOString() }))
    const charge = chargedUsd(row.cost_usd_api_equiv, runCap)
    spent += charge.usd
    add({ batch, what: row.run_id, usd: charge.usd, source: charge.known ? 'cli total_cost_usd' : 'run cap: no cost reported' })
    fs.appendFileSync(out, JSON.stringify(row) + '\n')
    console.log(`${row.run_id}: ${row.harness_error ? 'HARNESS ERROR ' + row.harness_error : row.exit_reason === 'quota' ? 'USAGE LIMIT, will rerun' : row.exit_reason === 'setup_error' ? 'SETUP FAILED, will rerun' : (row.accepted ? 'accepted' : 'rejected')} ` +
      `$${row.cost_usd_api_equiv?.toFixed?.(2) ?? '?'} ${row.wall_s ?? '?'}s`)
  }
}
await Promise.all(Array.from({ length: parallelRuns }, worker))
