#!/usr/bin/env node
// Picks the tasks a router change should run on. It costs $0: it reads result rows and plugin records, and replays
// recorded first routes.
//
//   node bench/select.mts [--base origin/main] [--policy <git-ref> | --policy-module <path>] [--results a.jsonl,b.jsonl]
//                         [--files f1,f2] [--top 6] [--per-impact 3] [--per-cohort 1] [--out selection.json]
//                         [--experiment <name>]
//
// Policy A is this working tree. Policy B is the ref or module to compare with, for example `--policy main` on a
// branch. Without policy B the disagreement part is empty. Changed files come from `git diff <base>...HEAD` plus the
// working tree, unless --files names them. The last line prints the task list for `bench/run.mts --tasks`.
// --experiment <name> writes experiments/pr-check-<name>.json: the picked tasks with repeats and budget fixed in
// lib/select.mts PR_CHECK before any result exists. Run it with `bench/run.mts --experiment pr-check-<name>`.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { outcomeOf, routeAuto, type AutoRouteInput } from '../hooks/lib/auto-route.ts'
import { configDir } from './lib/run-evidence.mts'
import { loadTasks, TASKS_DIR } from './lib/task-repo.mts'
import { replayable, type BatchPolicy } from './lib/route-replay.mts'
import { policyB } from './lib/route-policy.mts'
import { prCheckExperiment, select } from './lib/select.mts'

const args = process.argv.slice(2)
const opt = (n: string, d?: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const jsonl = (f: string) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })

const resultFiles = opt('--results')?.split(',') ?? fs.readdirSync(path.join(here, 'results')).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(here, 'results', f))
const rows = resultFiles.flatMap(jsonl).filter((r) => r?.schema_version && r.task_id)

const git = (a: string[]) => spawnSync('git', a, { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
const files = opt('--files')?.split(',') ?? [...new Set([...git(['diff', '--name-only', `${opt('--base', 'origin/main')}...HEAD`]), ...git(['diff', '--name-only'])])]

// The first recorded route input of each AutoMode run, from the plugin records its session wrote.
const inputsByTask: Record<string, AutoRouteInput[]> = {}
const recordsDir = path.join(configDir(), 'plugins', 'data', 'automode', 'records')
for (const r of rows) {
  if (r.plugin?.kind !== 'automode' || !r.session_id) continue
  const file = path.join(recordsDir, `${r.session_id}.jsonl`)
  if (!fs.existsSync(file)) continue
  const first = replayable(jsonl(file).filter((x) => x.point === 'prompt')).rows[0]
  if (first) (inputsByTask[r.task_id] ??= []).push(first.input)
}

const a: BatchPolicy = (inputs) => inputs.map((i) => outcomeOf(routeAuto(i)))
let b: ReturnType<typeof policyB> | null = null
if (opt('--policy') || opt('--policy-module')) {
  try { b = policyB({ ref: opt('--policy'), module: opt('--policy-module') }) } catch (err) { console.error((err as Error).message); process.exit(1) }
}
const num = (n: string, d: number) => Number(opt(n, String(d)))
let selection
try {
  selection = select({ inputsByTask, a, b: b?.batch ?? null, rows, files, tasks: loadTasks(TASKS_DIR).map((t) => ({ id: t.id, cohort: t.cohort })), top: num('--top', 6), perImpact: num('--per-impact', 3), perCohort: num('--per-cohort', 1) })
} finally { b?.cleanup() }

console.log(`Changed files: ${files.length}. Categories: ${selection.impacts.join(', ') || 'none'}. Policy B: ${b?.label ?? 'none (no disagreement part)'}.`)
console.log(`Tasks with a recorded first-route input: ${Object.keys(inputsByTask).length}. Without one: ${selection.unscored}.`)
for (const [part, rule] of Object.entries(selection.rules)) console.log(`- ${part}: ${rule}`)
for (const p of selection.picks) console.log(`  ${p.part.padEnd(12)} ${p.task}  (${p.why})`)
console.log(selection.scope)
const out = opt('--out')
if (out) fs.writeFileSync(out, JSON.stringify({ files, policyB: b?.label ?? null, ...selection }, null, 1) + '\n')
console.log(`--tasks ${selection.tasks.join(',')}`)
const name = opt('--experiment')
if (name) {
  const file = path.join(here, 'experiments', `pr-check-${name}.json`)
  fs.writeFileSync(file, JSON.stringify(prCheckExperiment(name, selection.tasks), null, 2) + '\n')
  console.log(`wrote ${path.relative(root, file)}`)
}
