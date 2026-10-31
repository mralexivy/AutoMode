#!/usr/bin/env node
// Mid-session switching, measured live. One real task, one continuous session, three prompts: the task, then two small
// follow-ups on the warm context. The arms differ only after the first prompt:
//   stay-opus       Opus at high, all the way
//   naive-switch    Sonnet at medium from the second prompt, as a per-prompt router with no cache check would do
//   effort-drop     Opus at medium from the second prompt
//   auto-from-opus  AutoMode decides, in a session that starts on Opus
// The hidden tests run after the last prompt. Cost and tokens come from the transcript, one reading per prompt.
//
// Usage: node bench/session-switch.mts [--task id] [--repeats 3] [--out file] [--scratch dir] [--step-cap-usd 3] [--dry-run]
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { armInvocation } from './arms.mts'
import { add, LEDGER } from './lib/ledger.mts'
import { loadTemplate, renderPrompt } from './lib/prompt.mts'
import { classifyRun } from './lib/outcome.mts'
import { estimatedUsd, harnessInfo } from './lib/result.mts'
import { runEvidence } from './lib/run-evidence.mts'
import { leakRefs, prepareWorkspace, removeTree, sealSetup, v4JudgeCost } from './lib/run-one.mts'
import { stepBetween, type Reading, type Step } from './lib/session-steps.mts'
import { loadTasks, taskRepo } from './lib/task-repo.mts'

const arg = (name: string, def?: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def }
const taskId = arg('task', 'longctx-tornado-body-parse-errors')
const repeats = Number(arg('repeats', '3'))
const stepCap = arg('step-cap-usd', '3')!
const out = arg('out', path.join('bench', 'results', 'session-switch.jsonl'))!
const scratch = arg('scratch', path.join(os.tmpdir(), 'am-bench-session'))!
const STEP_MS = 20 * 60_000

const FOLLOW_UPS = [
  'Add one short comment above the main code you changed that says why it exists. Change nothing else.',
  'In one line, name the file you changed most. Do not change any files.',
]
interface Plan { id: string; invocation: string; later?: { model: string; effort: string } }
const OPUS = 'claude-opus-5-5'
const PLANS: Plan[] = [
  { id: 'stay-opus', invocation: 'opus-high' },
  { id: 'naive-switch', invocation: 'opus-high', later: { model: 'claude-sonnet-5-5', effort: 'medium' } },
  { id: 'effort-drop', invocation: 'opus-high', later: { model: OPUS, effort: 'medium' } },
  { id: 'auto-from-opus', invocation: 'auto-from-opus' },
]

function claude(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  return new Promise<{ code: number | null; json: any; timedOut: boolean; stderr_tail: string[] }>((resolve) => {
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, STEP_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      let json = null
      try { json = JSON.parse(stdout) } catch {}
      resolve({ code, json, timedOut, stderr_tail: stderr.split('\n').filter(Boolean).slice(-3) })
    })
  })
}

function reading(sessionId: string): Reading {
  const e = runEvidence(sessionId)
  if (!e) return { requests: {}, usd: 0, cacheRead: 0, cacheWrite: 0, output: 0, peak: 0 }
  return { requests: e.requests, usd: estimatedUsd(e) ?? 0, cacheRead: e.tokens.cacheRead, cacheWrite: e.tokens.cacheWrite5m + e.tokens.cacheWrite1h, output: e.tokens.output, peak: e.peak_prompt_tokens ?? 0 }
}

// One step's arguments: the arm's own, with the plan's model and effort from the second prompt on.
function stepArgs(plan: Plan, dir: string, prompt: string, index: number, sessionId: string | null) {
  const { args, env } = armInvocation(plan.invocation, dir, prompt)
  if (index > 0 && plan.later) {
    args[args.indexOf('--model') + 1] = plan.later.model
    args[args.indexOf('--effort') + 1] = plan.later.effort
  }
  args.push('--max-budget-usd', stepCap)
  if (sessionId) args.push('--resume', sessionId)
  return { args, env }
}

async function session(plan: Plan, rep: number) {
  const task = loadTasks().find((t) => t.id === taskId)
  if (!task) throw new Error(`unknown task ${taskId}`)
  const runId = `${task.id}__${plan.id}__r${rep}`
  const dir = path.join(scratch, runId)
  removeTree(dir)
  fs.mkdirSync(dir, { recursive: true })
  const wt = path.join(dir, 'wt')
  const cache = taskRepo(task)
  prepareWorkspace(cache, task.base, wt)
  try {
    if (task.setup && spawnSync('sh', ['-c', task.setup], { cwd: wt, encoding: 'utf8' }).status !== 0) throw new Error('setup failed')
    sealSetup(wt)
    const prompts = [renderPrompt(loadTemplate('repo-change-v1'), task.task).text, ...FOLLOW_UPS]
    const steps: Step[] = []
    let sessionId: string | null = null, before: Reading = reading('none'), exit = 'done'
    for (const [i, prompt] of prompts.entries()) {
      const { args, env } = stepArgs(plan, dir, prompt, i, sessionId)
      const res = await claude(args, env, wt)
      exit = classifyRun(res)
      sessionId = res.json?.session_id ?? sessionId
      const now = sessionId ? reading(sessionId) : before
      steps.push(stepBetween(before, now))
      before = now
      if (exit !== 'done') break
    }
    for (const t of task.hidden_tests) {
      fs.mkdirSync(path.dirname(path.join(wt, t)), { recursive: true })
      fs.writeFileSync(path.join(wt, t), execFileSync('git', ['show', `${task.reference}:${t}`], { cwd: cache, encoding: 'utf8', maxBuffer: 1e8 }))
    }
    const accepted = exit === 'done' ? spawnSync('sh', ['-c', task.accept], { cwd: wt, encoding: 'utf8', timeout: 10 * 60_000 }).status === 0 : null
    return { run_id: runId, task_id: task.id, arm: plan.id, repeat: rep, exit_reason: exit, accepted, session_id: sessionId, steps, judge: v4JudgeCost(sessionId), leak_refs: leakRefs(sessionId, task), harness: harnessInfo('claude-code'), cost_basis: 'api-list-equivalent', at: new Date().toISOString() }
  } finally {
    removeTree(dir)
  }
}

const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.exit_reason === 'done').map((r) => r.run_id) : [])
// The arms take turns, so a slow hour falls on all of them.
const todo = Array.from({ length: repeats }, (_, r) => PLANS.map((p) => [p, r + 1] as const)).flat().filter(([p, r]) => !done.has(`${taskId}__${p.id}__r${r}`))
console.log(`${todo.length} sessions to run, ${repeats} repeats of ${PLANS.length} arms on ${taskId}. Ledger: ${LEDGER}`)
if (process.argv.includes('--dry-run')) process.exit(0)
fs.mkdirSync(path.dirname(out), { recursive: true })
for (const [plan, rep] of todo) {
  const row = await session(plan, rep).catch((e) => ({ run_id: `${taskId}__${plan.id}__r${rep}`, arm: plan.id, repeat: rep, exit_reason: 'harness_error', harness_error: String(e.message || e), steps: [] as Step[], accepted: null }))
  fs.appendFileSync(out, JSON.stringify(row) + '\n')
  const usd = row.steps.reduce((a, s) => a + s.usd, 0)
  add({ batch: `run:${path.basename(out)}`, what: row.run_id, usd, source: 'transcript tokens at the dated book' })
  console.log(`${row.run_id}: ${row.exit_reason} accepted=${row.accepted} $${usd.toFixed(2)} ${row.steps.map((s) => `[${s.models.map((m) => m.replace('claude-', '')).join('+')} $${s.usd.toFixed(3)} write ${s.cache_write} read ${s.cache_read}]`).join(' ')}`)
}
