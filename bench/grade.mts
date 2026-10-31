#!/usr/bin/env node
// Blind quality grader. For each run in a results file it gives Sonnet the task, the real reference
// commit's change, and the agent's change, and asks for scores against a fixed rubric. The grader
// never sees the arm, the cost, or the hidden-test result. Each call is a bare `claude -p` with no
// tools, run from an empty folder. Grades are written next to the results as <results>.grades.jsonl.
//
// With --judges a,b,c a panel grades each run: the score is the per-item median, and runs the judges disagree on also go
// to <results>.disputes.jsonl for a person. For a release, put a non-Claude judge on the panel: one vendor's judge shares
// that vendor's bias. Defect lines are model text, so only their count is saved.
//
// Usage: node bench/grade.mts bench/results/real-2026-10-19.jsonl [--judges a,b] [--parallel 1] [--budget-usd 3]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GRADER_MODEL, gradePrompt, parseGrade, referenceDiff } from './lib/grade-core.mts'
import { aggregate, claudeJudge, countsOnly, type Judge } from './lib/panel.mts'
import { add, entries, LEDGER, total } from './lib/ledger.mts'
import { waitMs } from './lib/pacer.mts'
import { isResult } from './lib/outcome.mts'
import { loadTasks, taskRepo } from './lib/task-repo.mts'

const resultsFile = process.argv[2]
if (!resultsFile) { console.error('usage: node bench/grade.mts <results.jsonl>'); process.exit(1) }
const opt = (n: string, d: unknown) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const parallelRuns = Number(opt('parallel', 1))
// Grading shares the usage window with the runs (bench/lib/pacer.mts).
const windowUsd = Number(opt('window-usd', process.env.BENCH_AUTH === 'api' ? 0 : 10))
const budget = Number(opt('budget-usd', 3))
const out = resultsFile.replace(/\.jsonl$/, '.grades.jsonl')
const disputes = resultsFile.replace(/\.jsonl$/, '.disputes.jsonl')
const tasks = Object.fromEntries(loadTasks().map((t) => [t.id, t]))
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-grade-'))
const batch = `grade:${path.basename(resultsFile)}`

const rows = fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter(isResult)
const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).run_id) : [])
const todo = rows.filter((r) => !done.has(r.run_id))
console.log(`${rows.length} runs, ${done.size} graded, ${todo.length} to grade. Budget $${budget}.`)
const judges: Judge[] = String(opt('judges', GRADER_MODEL)).split(',').map((model) => claudeJudge(model, empty))
let spent = total(LEDGER, batch)
let next = 0
async function worker() {
  while (next < todo.length) {
    if (spent >= budget) { console.log(`Budget $${budget} reached. Stopping.`); return }
    if (waitMs(entries(), Date.now(), windowUsd) > 0) { console.log('The usage window is full. Run the same command later to continue.'); return }
    const r = todo[next++]
    const task = tasks[r.task_id]
    const diffFile = path.join(path.dirname(resultsFile), 'diffs', `${r.run_id}.diff`)
    const agent = fs.existsSync(diffFile) ? fs.readFileSync(diffFile, 'utf8') : ''
    const prompt = gradePrompt(task.task, referenceDiff(task, taskRepo(task)), agent)
    let cost = 0
    const grades: Record<string, Record<string, any> | null> = {}
    for (const judge of judges) {
      let g = null
      for (let attempt = 0; attempt < 2 && !g; attempt++) { const res = await judge.call(prompt); cost += res.cost || 0; g = parseGrade(res.reply) }
      grades[judge.id] = g
    }
    spent += cost
    add({ batch, what: r.run_id, usd: cost, source: 'cli total_cost_usd' })
    const panel = aggregate(grades)
    fs.appendFileSync(out, JSON.stringify({ run_id: r.run_id, grade: panel.grade, grades: Object.fromEntries(Object.entries(grades).map(([id, g]) => [id, countsOnly(g)])), disputed: judges.length > 1 && panel.disputed, grade_cost: cost }) + '\n')
    if (judges.length > 1 && panel.disputed) fs.appendFileSync(disputes, JSON.stringify({ run_id: r.run_id, reasons: panel.reasons }) + '\n')
    const g = panel.grade
    console.log(`${r.run_id}: ${g ? `${g.correctness}/${g.completeness}/${g.scope}/${g.tests}/${g.maintainability} ${g.vs_reference}` : 'no grade'}${judges.length > 1 && panel.disputed ? ' DISPUTED' : ''} $${cost.toFixed(3)}`)
  }
}
await Promise.all(Array.from({ length: parallelRuns }, worker))
console.log(`Grading spent $${spent.toFixed(2)}.`)
