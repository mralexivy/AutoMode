#!/usr/bin/env node
// Blind quality grader. For each run in a results file it gives Sonnet the task, the real reference
// commit's change, and the agent's change, and asks for scores against a fixed rubric. The grader
// never sees the arm, the cost, or the hidden-test result. Each call is a bare `claude -p` with no
// tools, run from an empty folder. Grades are written next to the results as <results>.grades.jsonl.
//
// Usage: node bench/grade.mts bench/results/real-2026-10-19.jsonl [--parallel 3] [--budget-usd 3]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { grade, gradePrompt, parseGrade, referenceDiff } from './lib/grade-core.mts'
import { add, LEDGER, total } from './lib/ledger.mts'
import { isResult } from './lib/outcome.mts'
import { loadTasks, taskRepo } from './lib/task-repo.mts'

const resultsFile = process.argv[2]
if (!resultsFile) { console.error('usage: node bench/grade.mts <results.jsonl>'); process.exit(1) }
const opt = (n: string, d: unknown) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const parallelRuns = Number(opt('parallel', 3))
const budget = Number(opt('budget-usd', 3))
const out = resultsFile.replace(/\.jsonl$/, '.grades.jsonl')
const tasks = Object.fromEntries(loadTasks().map((t) => [t.id, t]))
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-grade-'))
const batch = `grade:${path.basename(resultsFile)}`

const rows = fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter(isResult)
const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).run_id) : [])
const todo = rows.filter((r) => !done.has(r.run_id))
console.log(`${rows.length} runs, ${done.size} graded, ${todo.length} to grade. Budget $${budget}.`)
let spent = total(LEDGER, batch)
let next = 0
async function worker() {
  while (next < todo.length) {
    if (spent >= budget) { console.log(`Budget $${budget} reached. Stopping.`); return }
    const r = todo[next++]
    const task = tasks[r.task_id]
    const diffFile = path.join(path.dirname(resultsFile), 'diffs', `${r.run_id}.diff`)
    const agent = fs.existsSync(diffFile) ? fs.readFileSync(diffFile, 'utf8') : ''
    const prompt = gradePrompt(task.task, referenceDiff(task, taskRepo(task)), agent)
    let g = null, cost = 0
    for (let attempt = 0; attempt < 2 && !g; attempt++) { const res = await grade(prompt, empty); cost += res.cost || 0; g = parseGrade(res.reply) }
    spent += cost
    add({ batch, what: r.run_id, usd: cost, source: 'cli total_cost_usd' })
    fs.appendFileSync(out, JSON.stringify({ run_id: r.run_id, grade: g, grade_cost: cost }) + '\n')
    console.log(`${r.run_id}: ${g ? `${g.correctness}/${g.completeness}/${g.scope}/${g.tests}/${g.maintainability} ${g.vs_reference}` : 'no grade'} $${cost.toFixed(3)}`)
  }
}
await Promise.all(Array.from({ length: parallelRuns }, worker))
console.log(`Grading spent $${spent.toFixed(2)}.`)
