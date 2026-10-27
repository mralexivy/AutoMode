#!/usr/bin/env node
// Blind quality grader. For each run in a results file it gives Sonnet the task, the real reference
// commit's change, and the agent's change, and asks for scores against a fixed rubric. The grader
// never sees the arm, the cost, or the hidden-test result. Each call is a bare `claude -p` with no
// tools, run from an empty folder. Grades are written next to the results as <results>.grades.jsonl.
//
// Usage: node bench/grade.mjs bench/results/real-2026-10-19.jsonl [--parallel 3] [--budget-usd 3]
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadTasks, taskRepo } from './lib/task-repo.mjs'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const resultsFile = process.argv[2]
if (!resultsFile) { console.error('usage: node bench/grade.mjs <results.jsonl>'); process.exit(1) }
const opt = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const parallelRuns = Number(opt('parallel', 3))
const budget = Number(opt('budget-usd', 3))
const out = resultsFile.replace(/\.jsonl$/, '.grades.jsonl')
const tasks = Object.fromEntries(loadTasks().map((t) => [t.id, t]))
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-grade-'))
const CAP = 40000

export const RUBRIC = `You grade one code change made by an AI coding agent for a task in a software repository.
You get the task, the reference change (what a senior engineer actually merged; its test files are left out), and the agent's change.
The reference is one good solution, not the only one: judge the agent's change on its own merits against the task.
Score each item from 1 (bad) to 5 (excellent):
- correctness: does it do what the task asks, without bugs?
- completeness: does it cover every requirement in the task?
- scope: does it change only what the task needs, with no unrelated edits?
- tests: does it add or update tests that would catch a regression of this change?
- maintainability: is it clear and consistent with the surrounding code?
Then list the concrete defects you found (at most 5, one line each, with the file), and compare with the reference: "better", "equal" or "worse".
Reply with JSON only: {"correctness":n,"completeness":n,"scope":n,"tests":n,"maintainability":n,"defects":["..."],"vs_reference":"better|equal|worse"}`

const clip = (s) => (s.length > CAP ? `${s.slice(0, CAP)}\n[... ${s.length - CAP} more characters cut]` : s)
function referenceDiff(task) {
  return execFileSync('git', ['show', '--format=', task.reference, '--', '.', ...task.hidden_tests.map((t) => `:!${t}`)], { cwd: taskRepo(task), encoding: 'utf8', maxBuffer: 1e8 })
}

function grade(prompt) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--model', 'sonnet', '--system-prompt', RUBRIC, '--tools', '', '--output-format', 'json',
      '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence']
    const child = spawn('claude', args, { cwd: empty, env: { ...process.env, CLAUDE_CODE_USE_VERTEX: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let s = ''
    child.stdout.on('data', (d) => { s += d })
    child.on('close', () => { let j = {}; try { j = JSON.parse(s) } catch {} ; resolve({ reply: j.result ?? '', cost: j.total_cost_usd ?? null }) })
  })
}
function parse(reply) {
  try {
    const j = JSON.parse(String(reply).match(/\{[\s\S]*\}/)[0])
    const keys = ['correctness', 'completeness', 'scope', 'tests', 'maintainability']
    if (!keys.every((k) => Number.isInteger(j[k]) && j[k] >= 1 && j[k] <= 5)) return null
    return { ...Object.fromEntries(keys.map((k) => [k, j[k]])), defects: (j.defects || []).slice(0, 5), vs_reference: j.vs_reference }
  } catch { return null }
}

const rows = fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.harness_error)
const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).run_id) : [])
const todo = rows.filter((r) => !done.has(r.run_id))
console.log(`${rows.length} runs, ${done.size} graded, ${todo.length} to grade. Budget $${budget}.`)
let spent = 0
let next = 0
async function worker() {
  while (next < todo.length) {
    if (spent >= budget) { console.log(`Budget $${budget} reached. Stopping.`); return }
    const r = todo[next++]
    const task = tasks[r.task_id]
    const diffFile = path.join(path.dirname(resultsFile), 'diffs', `${r.run_id}.diff`)
    const agent = fs.existsSync(diffFile) ? fs.readFileSync(diffFile, 'utf8') : ''
    const prompt = `Task:\n${task.task}\n\nReference change:\n${clip(referenceDiff(task))}\n\nAgent's change:\n${agent.trim() ? clip(agent) : '(no change)'}`
    let g = null, cost = 0
    for (let attempt = 0; attempt < 2 && !g; attempt++) { const res = await grade(prompt); cost += res.cost || 0; g = parse(res.reply) }
    spent += cost
    fs.appendFileSync(out, JSON.stringify({ run_id: r.run_id, grade: g, grade_cost: cost }) + '\n')
    console.log(`${r.run_id}: ${g ? `${g.correctness}/${g.completeness}/${g.scope}/${g.tests}/${g.maintainability} ${g.vs_reference}` : 'no grade'} $${cost.toFixed(3)}`)
  }
}
await Promise.all(Array.from({ length: parallelRuns }, worker))
console.log(`Grading spent $${spent.toFixed(2)}.`)
