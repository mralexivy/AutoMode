#!/usr/bin/env node
// e5-sessions.mts --experiment v6-e5-sessions [--report] [--out file]
// v6.1 E5 (bench/experiments/V6.md): related tasks inside one continuing Claude Code session, the way people work. Each
// session is one repository's tasks in a fixed order. Before each task the workspace is reset to that task's base at
// the same path, and the session continues (--resume), so the conversation, its context and its cache carry over while
// the code does not. Each task is graded by its own hidden tests right after its turn.
//
// What it measures, per arm: accepted tasks, the cost of every paid step (the judges included), and the session's
// context peak after each step. The proof runs measure one task per session and say nothing about this.
//
// Paid-run rules as bench/run.mts keeps them: the machine lock, every fixture valid on this machine, a clean tree, the
// budget cap before each step, append-only rows synced to disk, a usage limit waited out, and a contamination stop when
// a behavior file changes. A crash resumes: finished steps are skipped and the session continues from its last id.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ARMS } from './arms.mts'
import { rowUsd } from './lib/decide.mts'
import { behaviorFiles, filesHash, taskHash } from './lib/identity.mts'
import { acquire } from './lib/lock.mts'
import { resetAt } from './lib/admission.mts'
import { isFake } from './lib/gate.mts'
import { readRows } from './lib/plan.mts'
import { harnessInfo } from './lib/result.mts'
import { loadTemplate, renderPrompt } from './lib/prompt.mts'
import { runEvidence } from './lib/run-evidence.mts'
import { completionGate, removeTree, v4JudgeCost } from './lib/run-one.mts'
import { loadTasks, taskRepo, type Task } from './lib/task-repo.mts'
import { claudeCodeRunner } from './runners/claude-code.mts'
import { fixtureVerdict, machine } from './preflight.mts'
import { freshWorkspace, runAccept, writeHiddenTests } from './validate-fixture.mts'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
// A step is a task, graded by its hidden tests, or a question about the code, graded by whether the answer names what
// `expect` lists (every pattern, case-insensitive). A question runs on `base`'s code. The answer is checked in memory
// and never saved.
export type Question = { ask: string; expect: string[]; base: string }
export type Step = string | Question
export interface SessionExperiment { id: string; description: string; arms: string[]; sessions: Record<string, Step[]>; budget_usd: number; run_cap_usd: number; prompt_template?: string }

export const answerOk = (q: Question, answer: string | undefined) => !!answer && q.expect.every((rx) => new RegExp(rx, 'i').test(answer))
const taskOf = (s: Step) => (typeof s === 'string' ? s : s.base)

export const NEXT_QUESTION = 'Next, a question about the code as it stands now. Answer briefly; change nothing.\n\n'
export const NEXT_TASK = 'A new task in the same session. The repository was reset to a different version, so earlier changes are gone. Work only on this task.\n\n'

export const stepRunId = (session: string, arm: string, step: number, task: Task, q?: Question) => `${session}__${arm}__s${step}__${q ? `q${createHash('sha256').update(q.ask).digest('hex').slice(0, 10)}` : taskHash(task).slice(0, 12)}`

// sessionUsd: what an arm's sessions cost. Schema 2 rows carry each step's own cost. Schema 1 rows (the W1 smoke) carry
// the session's running total from the CLI, so a session costs its last step's value, plus every step's judge delta.
export function sessionUsd(rows: any[]): number {
  let usd = 0
  for (const s of new Set(rows.map((r) => r.session))) {
    const rs = rows.filter((r) => r.session === s).sort((a, b) => a.step - b.step)
    const v1 = rs.filter((r) => (r.schema_version ?? 1) < 2)
    if (v1.length) usd += Math.max(...v1.map((r) => r.cost_usd_api_equiv ?? 0)) + v1.reduce((a, r) => a + (r.judge?.usd ?? 0), 0)
    usd += rs.filter((r) => (r.schema_version ?? 1) >= 2).reduce((a, r) => a + rowUsd(r), 0)
  }
  return usd
}

export interface SessionSummary { arm: string; steps: number; accepted: number; usd: number; peakByStep: number[] }

// summarize: per arm, the steps that finished, their cost and the mean context peak at each step position.
export function summarize(rows: any[]): SessionSummary[] {
  const out: SessionSummary[] = []
  for (const arm of [...new Set(rows.map((r) => r.arm))]) {
    const rs = rows.filter((r) => r.arm === arm && r.exit_reason === 'done')
    const byStep = new Map<number, number[]>()
    for (const r of rs) if (typeof r.peak_prompt_tokens === 'number') byStep.set(r.step, [...(byStep.get(r.step) ?? []), r.peak_prompt_tokens])
    const steps = [...byStep.keys()].sort((a, b) => a - b)
    out.push({ arm, steps: rs.length, accepted: rs.filter((r) => r.accepted).length, usd: sessionUsd(rows.filter((r) => r.arm === arm)), peakByStep: steps.map((s) => Math.round(byStep.get(s)!.reduce((a, b) => a + b, 0) / byStep.get(s)!.length)) })
  }
  return out
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }
  const id = arg('experiment')
  if (!id) { console.error('usage: e5-sessions.mts --experiment <id> [--report]'); process.exit(1) }
  const exp = JSON.parse(fs.readFileSync(arg('experiment-file') ?? path.join(REPO, 'bench', 'experiments', 'sessions', `${id}.json`), 'utf8')) as SessionExperiment
  const out = arg('out') ?? path.join(REPO, 'bench', 'results', `${id}.jsonl`)
  const prior = fs.existsSync(out) ? readRows(out) : []
  if (process.argv.includes('--report')) {
    for (const s of summarize(prior)) console.log(`${s.arm.padEnd(13)} ${s.accepted}/${s.steps} accepted, $${s.usd.toFixed(2)}, context peak by step: ${s.peakByStep.join(' → ')}`)
    return
  }
  const tasks = new Map(loadTasks(arg('tasks-dir')).map((t) => [t.id, t]))
  // The fake claude of the tests runs from a working tree; a real run needs the tree committed.
  const fake = isFake(harnessInfo('claude-code').runner_version)
  for (const steps of Object.values(exp.sessions)) for (const s of steps) if (!tasks.has(taskOf(s))) throw new Error(`unknown task ${taskOf(s)}`)
  for (const a of exp.arms) if (!ARMS[a]) throw new Error(`unknown arm ${a}`)
  // Preflight: a clean tree (results aside), every fixture valid on this machine.
  const dirty = execFileSync('git', ['status', '--porcelain', '--', '.', ':(exclude)bench/results', ':(exclude)docs/proposals'], { cwd: REPO, encoding: 'utf8' }).trim()
  if (dirty && !fake) { console.error(`Not starting: uncommitted changes: ${dirty.split('\n').slice(0, 5).join('; ')}`); process.exit(2) }
  const host = machine()
  const bad = [...new Set(Object.values(exp.sessions).flat().filter((s): s is string => typeof s === 'string'))].map((t) => fixtureVerdict(tasks.get(t)!, path.join(os.tmpdir(), 'am-e5-preflight'), host)).filter((v) => !v.valid)
  if (bad.length) { console.error(`Not starting: invalid fixtures: ${bad.map((v) => `${v.id} (${v.why})`).join('; ')}`); process.exit(2) }
  const lock = acquire(id)
  if ('holder' in lock) { console.error(`Not starting: ${lock.holder.experiment} holds the lock (pid ${lock.holder.pid})`); process.exit(3) }
  const code = filesHash(behaviorFiles(REPO))
  const template = loadTemplate(exp.prompt_template ?? 'repo-change-v1')
  const scratch = arg('scratch') ?? path.join(os.tmpdir(), 'am-e5')
  let spent = prior.reduce((a, r) => a + rowUsd(r), 0)
  const done = new Set(prior.filter((r) => r.exit_reason !== 'quota').map((r) => r.run_id))
  console.log(`${id}: ${exp.arms.length} arms × ${Object.keys(exp.sessions).length} sessions; ${done.size} steps already done; $${spent.toFixed(2)} of $${exp.budget_usd} spent.`)
  try {
    for (const arm of exp.arms) for (const [name, steps] of Object.entries(exp.sessions)) {
      const dir = path.join(scratch, `${name}__${arm}`)
      fs.mkdirSync(dir, { recursive: true })
      const wt = path.join(dir, 'wt')
      const before = prior.filter((r) => r.session === name && r.arm === arm && r.exit_reason === 'done').sort((a, b) => a.step - b.step)
      let sid: string | null = before.at(-1)?.session_id ?? null
      let judgeSoFar: number = before.at(-1)?.judge_cumulative_usd ?? 0
      // A resumed `claude -p` reports the session's running total as total_cost_usd, so a step's own cost is the
      // difference (found on the W1 smoke: two steps of one session both read $0.14).
      let costSoFar: number = before.at(-1)?.cost_cumulative_usd ?? before.at(-1)?.cost_usd_api_equiv ?? 0
      for (let k = 0; k < steps.length; k++) {
        const q = typeof steps[k] === 'string' ? undefined : (steps[k] as Question)
        const task = tasks.get(taskOf(steps[k]))!
        const runId = stepRunId(name, arm, k, task, q)
        if (done.has(runId)) continue
        if (spent >= exp.budget_usd) { console.log(`Budget: $${spent.toFixed(2)} of $${exp.budget_usd} spent. No new step starts.`); return }
        const cache = taskRepo(task)
        freshWorkspace(task, cache, task.base, wt)
        const prompt = q ? (k === 0 ? '' : NEXT_QUESTION) + q.ask : (k === 0 ? '' : NEXT_TASK) + renderPrompt(template, task.task).text
        let res = await claudeCodeRunner.run({ armId: arm, workspace: wt, dir, prompt, timeoutMs: (task.limits?.wall_seconds ?? 1800) * 1000, runCap: exp.run_cap_usd, accept: task.accept, ...(sid ? { resume: sid } : {}) })
        while (res.exitReason === 'quota') {
          const head = { schema_version: 1, experiment: id, run_id: runId, session: name, step: k, task_id: task.id, arm, exit_reason: 'quota', cost_usd_api_equiv: res.costUsd, session_id: res.sessionId ?? sid, at: new Date().toISOString() }
          fs.appendFileSync(out, JSON.stringify(head) + '\n')
          spent += res.costUsd ?? 0
          const reset = resetAt(`${res.limitMessage ?? ''}\n${res.stderrTail.join('\n')}`, new Date())
          const wait = reset ? Math.max(60_000, Date.parse(reset) - Date.now() + 60_000) : 30 * 60_000
          console.log(`Usage limit; waiting ${Math.ceil(wait / 60_000)} min${reset ? ` (resets ${reset})` : ''}.`)
          await sleep(wait)
          sid = res.sessionId ?? sid
          res = await claudeCodeRunner.run({ armId: arm, workspace: wt, dir, prompt, timeoutMs: (task.limits?.wall_seconds ?? 1800) * 1000, runCap: exp.run_cap_usd, accept: task.accept, ...(sid ? { resume: sid } : {}) })
        }
        sid = res.sessionId ?? sid
        let accepted: boolean
        let acceptExit: number | null = null
        if (q) accepted = answerOk(q, res.answer)
        else { writeHiddenTests(task, cache, wt); const acc = runAccept(task, wt); accepted = acc.status === 0; acceptExit = acc.status }
        const ev: any = runEvidence(sid)
        const judge = ARMS[arm].v4 ? v4JudgeCost(sid) : null
        const judgeNow = judge?.usd ?? 0
        const row: any = {
          schema_version: 2, experiment: id, run_id: runId, session: name, step: k, kind: q ? 'question' : 'task', task_id: task.id, cohort: q ? 'question' : task.cohort, arm,
          identity: { v: 2, task: taskHash(task), code, rep: 1 }, plugin: ARMS[arm].plugin ?? null,
          exit_reason: res.exitReason, accepted, accept_exit: acceptExit, ...(q ? { answer_chars: res.answer?.length ?? 0 } : {}),
          cost_usd_api_equiv: res.costUsd === null ? null : Math.max(0, res.costUsd - costSoFar), cost_cumulative_usd: res.costUsd, judge: { usd: Math.max(0, judgeNow - judgeSoFar) }, judge_cumulative_usd: judgeNow,
          session_id: sid, peak_prompt_tokens: ev?.peak_prompt_tokens ?? null, requests: ev?.requests ?? null, compactions: ev?.compactions ?? null,
          actions: judge?.actions ?? null, rescues: judge?.rescues ?? null,
          completion: ARMS[arm].v4 ? completionGate(sid) : null, wall_s: res.wallS, at: new Date().toISOString(),
        }
        judgeSoFar = judgeNow
        if (res.costUsd !== null) costSoFar = res.costUsd
        if (filesHash(behaviorFiles(REPO)) !== code) row.contaminated = true
        const fd = fs.openSync(out, 'a'); fs.writeSync(fd, JSON.stringify(row) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd)
        spent += rowUsd(row)
        console.log(`${runId}: ${row.accepted ? 'accepted' : 'rejected'} $${rowUsd(row).toFixed(2)}, context peak ${row.peak_prompt_tokens ?? '?'}`)
        if (row.contaminated) { console.error('Stopped: a behavior file changed during the run.'); process.exitCode = 5; return }
      }
      removeTree(wt)
    }
  } finally { if ('release' in lock) lock.release() }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
