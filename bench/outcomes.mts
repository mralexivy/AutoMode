#!/usr/bin/env node
// Prints the outcome matrix sections for result files, and can write the matrix as JSON. No model calls.
// Usage: node bench/outcomes.mts [--out matrix.json] [--reference arm] [--focus task] results.jsonl ...
import fs from 'node:fs'
import { FOCUS_TASK, outcomeJson, outcomeReport, REFERENCE_ARM, renderOutcomes } from './lib/outcomes.mts'
import { loadTasks } from './lib/task-repo.mts'

const argv = process.argv.slice(2)
const valued = ['--out', '--reference', '--focus']
const optionOf = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
const files = argv.filter((_, i) => !valued.includes(argv[i]) && !valued.includes(argv[i - 1]))
if (!files.length) { console.error('Usage: node bench/outcomes.mts [--out matrix.json] [--reference arm] [--focus task] results.jsonl ...'); process.exit(2) }

const rows = files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).filter((r) => r.run_id)
const focus = optionOf('--focus') ?? FOCUS_TASK
const report = outcomeReport({ rows, tasks: Object.fromEntries(loadTasks().map((t) => [t.id, t])), reference: optionOf('--reference') ?? REFERENCE_ARM, focus })
console.log(renderOutcomes(report, focus).join('\n').trimStart())
const out = optionOf('--out')
if (out) fs.writeFileSync(out, JSON.stringify(outcomeJson(report), null, 2) + '\n')
