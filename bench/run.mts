#!/usr/bin/env node
// @ts-nocheck TODO(types): 24 errors with strict off. Fix them and delete this line to turn checking on for this file.
// AutoMode benchmark runner. Resumable: a run whose id is already in the results file is skipped.
//
// Usage: node bench/run.mts [--preset light|effort|auto] [--tasks a,b] [--arms x,y] [--repeats 3] [--parallel 2]
//                           [--run-cap-usd 3] [--budget-usd 15] [--scratch dir] [--out file] [--timeout-min 40] [--dry-run]
//
// Spend limits: --run-cap-usd passes --max-budget-usd to each claude run (a hard stop per run).
// --budget-usd stops scheduling new runs once the recorded API-equivalent cost reaches it (runs
// already started finish). The "light" preset is 2 tasks x 4 arms x 1 repeat with both limits on.
//
// For each task, arm, and repeat it:
//   1. clones the repo into the scratch folder and checks out the task's base commit. A clone, not a
//      worktree: worktrees share the main repo's Claude Code project memory, which leaked answers
//      into the first light run (2026-10-19).
//   2. runs `claude -p` with the arm's flags (see arms.mts)
//   3. restores the hidden tests from the reference commit and runs the acceptance command
//   4. appends one JSON line: outcome, diff size, cost, tokens, the per-stage trace, wall time
// Raw results never contain prompt text or file contents.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ARMS, armInvocation } from './arms.mts'
import { loadTasks, problems, taskRepo } from './lib/task-repo.mts'

const REPO = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const PRESETS = {
  light: { arms: 'sonnet,opus,auto', repeats: '1', parallel: '1', 'run-cap-usd': '3', 'budget-usd': '15' },
  effort: { arms: 'opus-medium,opus-high,opus-effortless,auto', repeats: '3', parallel: '2', 'run-cap-usd': '3', 'budget-usd': '40' },
  auto: { arms: 'opus,sonnet,auto', repeats: '3', parallel: '2', 'run-cap-usd': '3', 'budget-usd': '30' },
}
const presetName = (() => { const i = process.argv.indexOf('--preset'); return i >= 0 ? process.argv[i + 1] : null })()
if (presetName && !PRESETS[presetName]) throw new Error(`unknown preset ${presetName}; known: ${Object.keys(PRESETS).join(', ')}`)
const opt = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : (presetName && PRESETS[presetName][name]) ?? def }
const flag = (name) => process.argv.includes(`--${name}`)
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

const PROMPT_SUFFIX = '\n\nWork in this repository. Make the change, add or update tests, and run the test suite. Do not commit or push.'
const git = (args, cwd = REPO) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1e8 })

function doneIds() {
  if (!fs.existsSync(out)) return new Set()
  return new Set(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).run_id } catch { return null } }))
}

function runClaude(args, env, cwd) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      let json = null
      try { json = JSON.parse(stdout) } catch {}
      resolve({ code, signal, json, wall_s: Math.round((Date.now() - started) / 1000), stderr_tail: stderr.split('\n').filter(Boolean).slice(-3) })
    })
  })
}

// memoryRefs counts references to another project's auto-memory folder in the run's transcripts.
// Every session is told about its own (empty) memory folder; that is fine. A reference to any other
// project's memory means the run saw the user's memory, and the row is excluded from the report.
function memoryRefs(sessionId) {
  if (!sessionId) return null
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects')
  for (const proj of fs.readdirSync(root)) {
    const main = path.join(root, proj, `${sessionId}.jsonl`)
    if (!fs.existsSync(main)) continue
    let hits = 0
    const count = (file) => {
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/projects\/([^/\s"\\]+)\/memory/g)) if (m[1] !== proj) hits++
    }
    const scan = (p) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const q = path.join(p, e.name)
        if (e.isDirectory()) scan(q)
        else if (q.endsWith('.jsonl')) count(q)
      }
    }
    count(main)
    if (fs.existsSync(path.join(root, proj, sessionId))) scan(path.join(root, proj, sessionId))
    return hits
  }
  return null
}

// judgeCost reads the judge router's decision log in the run's plugin copy: every verdict, and the
// judge's own Haiku tokens priced at list price. The CLI's total may not include plugin model calls,
// so the report adds this to the run's cost.
function judgeCost(dir) {
  const file = path.join(dir, 'plugin-v2', 'judge-log.jsonl')
  if (!fs.existsSync(file)) return null
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  let usd = 0
  for (const l of lines.filter((x) => x.ev === 'judge' && x.usage)) {
    const u = l.usage
    usd += ((u.input_tokens || 0) * 0.10 + (u.output_tokens || 0) * 0.50 + (u.cache_read_input_tokens || 0) * 0.01 + (u.cache_creation_input_tokens || 0) * 0.125) / 1e6
  }
  return { usd, calls: lines.filter((x) => x.ev === 'judge').length, verdicts: lines.filter((x) => x.ev === 'verdict').map((v) => ({ path: v.path, effort: v.effort, by: v.by, risks: v.risks })) }
}

// v4JudgeCost sums the V4 judge's measured Haiku cost for one session from the decision records in
// the profile's plugin data folder.
function v4JudgeCost(sessionId) {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins', 'data', 'automode', 'decisions.jsonl')
  if (!sessionId || !fs.existsSync(file)) return null
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter((r) => r && r.sessionId === sessionId)
  const decisions = rows.filter((r) => r.kind === 'decision')
  return {
    usd: decisions.reduce((a, r) => a + (r.judge?.usd || 0), 0), calls: decisions.filter((r) => r.judge?.called).length,
    verdicts: decisions.map((r) => ({ tier: r.effective?.tier, model: r.effective?.model, effort: r.effective?.effort, owner: r.effective?.owner, risk: r.risk?.effective, review: r.risk?.reviewRequired, strategy: r.strategy?.chosen })),
    workers: rows.filter((r) => r.kind === 'worker').map((r) => ({ agent: r.agent, status: r.status, tokens: r.tokens })),
    escalations: rows.filter((r) => r.kind === 'escalation').length,
  }
}

function usageTrace(sessionId) {
  if (!sessionId) return null
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'am-usage.mjs'), sessionId, '--trace', '--json'], { encoding: 'utf8' })
  try { return JSON.parse(r.stdout) } catch { return null }
}

async function oneRun(task, armId, rep) {
  const runId = `${task.id}__${armId}__r${rep}`
  const dir = path.join(scratch, runId)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const wt = path.join(dir, 'wt')
  const cache = taskRepo(task)
  git(['clone', '-q', '--no-checkout', cache, wt])
  git(['checkout', '-q', '--detach', task.base], wt)
  if (task.setup) spawnSync('sh', ['-c', task.setup], { cwd: wt, encoding: 'utf8', timeout: 10 * 60_000 })
  try {
    const { args, env } = armInvocation(armId, dir, task.task + PROMPT_SUFFIX)
    if (runCap) args.push('--max-budget-usd', String(runCap))
    const res = await runClaude(args, env, wt)
    // Acceptance: the reference commit's versions of the hidden tests, then the accept command.
    for (const t of task.hidden_tests) {
      fs.mkdirSync(path.dirname(path.join(wt, t)), { recursive: true })
      fs.writeFileSync(path.join(wt, t), git(['show', `${task.reference}:${t}`], cache))
    }
    // The agent's whole change, its own edits to test files included, captured before the hidden
    // tests overwrite those files: saved for the blind grader.
    const agentDiff = git(['diff'], wt) +
      git(['ls-files', '--others', '--exclude-standard'], wt).split('\n').filter(Boolean).map((f) => `\n--- new file: ${f}\n${fs.readFileSync(path.join(wt, f), 'utf8').slice(0, 20000)}`).join('')
    const diffDir = path.join(path.dirname(out), 'diffs')
    fs.mkdirSync(diffDir, { recursive: true })
    fs.writeFileSync(path.join(diffDir, `${runId}.diff`), agentDiff)
    const lint = task.lint ? spawnSync('sh', ['-c', task.lint], { cwd: wt, encoding: 'utf8', timeout: 5 * 60_000 }) : null
    const acc = spawnSync('sh', ['-c', task.accept], { cwd: wt, encoding: 'utf8', timeout: 10 * 60_000 })
    const diffStat = git(['diff', '--shortstat', '--', '.', ...task.hidden_tests.map((t) => `:!${t}`)], wt).trim()
    const touched = git(['status', '--porcelain'], wt).split('\n').filter(Boolean).map((l) => l.slice(3))
    const commits = Number(git(['rev-list', '--count', `${task.base}..HEAD`], wt).trim())
    const j = res.json || {}
    return {
      run_id: runId, task_id: task.id, cohort: task.cohort, arm: armId, repeat: rep,
      accepted: acc.status === 0, accept_exit: acc.status, accept_tail: (acc.stdout + acc.stderr).split('\n').filter(Boolean).slice(-8),
      claude_exit: res.code, claude_signal: res.signal, is_error: j.is_error ?? null, num_turns: j.num_turns ?? null,
      cost_usd_api_equiv: j.total_cost_usd ?? null, wall_s: res.wall_s, session_id: j.session_id ?? null,
      model_usage: j.modelUsage ? Object.fromEntries(Object.entries(j.modelUsage).map(([m, u]) => [m, {
        input: u.inputTokens ?? null, output: u.outputTokens ?? null, cache_read: u.cacheReadInputTokens ?? null,
        cache_write: u.cacheCreationInputTokens ?? null, cost_usd: u.costUSD ?? null }])) : null,
      run_cap_usd: runCap,
      diff_shortstat: diffStat,
      diff_chars: agentDiff.length,
      lint_clean: lint ? lint.status === 0 : null, files_touched: touched.length, commits_made: commits,
      trace: usageTrace(j.session_id)?.trace ?? null,
      memory_refs: memoryRefs(j.session_id),
      judge: ARMS[armId].v4 ? v4JudgeCost(j.session_id) : judgeCost(dir),
      stderr_tail: res.stderr_tail, at: new Date().toISOString(),
    }
  } finally {
    fs.rmSync(wt, { recursive: true, force: true })
  }
}

const plan = []
for (let rep = 1; rep <= repeats; rep++) for (const t of tasks) for (const a of arms) plan.push([t, a, rep])
const skip = doneIds()
const todo = plan.filter(([t, a, r]) => !skip.has(`${t.id}__${a}__r${r}`))
console.log(`${plan.length} runs planned, ${plan.length - todo.length} already done, ${todo.length} to run (${parallelRuns} at a time).` +
  `${runCap ? ` Cap per run: $${runCap}.` : ''}${budget ? ` Total budget: $${budget}.` : ''}`)
if (flag('dry-run')) { for (const [t, a, r] of todo) console.log(`  ${t.id} / ${a} / r${r}`); process.exit(0) }

fs.mkdirSync(path.dirname(out), { recursive: true })
let next = 0
let spent = 0
async function worker() {
  while (next < todo.length) {
    if (budget && spent >= budget) { console.log(`Budget $${budget} reached ($${spent.toFixed(2)} spent). No new runs start.`); return }
    const [t, a, r] = todo[next++]
    const row = await oneRun(t, a, r).catch((e) => ({ run_id: `${t.id}__${a}__r${r}`, task_id: t.id, cohort: t.cohort, arm: a, repeat: r, harness_error: String(e.message || e), at: new Date().toISOString() }))
    spent += row.cost_usd_api_equiv || 0
    fs.appendFileSync(out, JSON.stringify(row) + '\n')
    console.log(`${row.run_id}: ${row.harness_error ? 'HARNESS ERROR ' + row.harness_error : (row.accepted ? 'accepted' : 'rejected')} ` +
      `$${row.cost_usd_api_equiv?.toFixed?.(2) ?? '?'} ${row.wall_s ?? '?'}s`)
  }
}
await Promise.all(Array.from({ length: parallelRuns }, worker))
