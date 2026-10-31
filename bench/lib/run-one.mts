// One benchmark run: clone, agent, hidden tests, one result row. bench/run.mts schedules these.
// Raw results never contain prompt text or file contents.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ARMS, armInvocation, armSpec } from '../arms.mts'
import { ANTHROPIC, usageUsd } from '../../hooks/lib/prices.ts'
import { classifyRun, type ExitReason } from './outcome.mts'
import { specHash } from './experiment.mts'
import { loadTemplate, renderPrompt, type Template } from './prompt.mts'
import { COST_BASIS, RESULT_SCHEMA, estimatedUsd, harnessInfo, pricingSnapshot } from './result.mts'
import { configDir, runEvidence, sessionFiles } from './run-evidence.mts'
import { taskRepo, type Task } from './task-repo.mts'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const SETUP_MS = 10 * 60_000
const git = (args: string[], cwd?: string) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1e8 })

export interface RunContext {
  scratch: string
  out: string
  timeoutMs: number
  runCap: number | null
  experiment?: string
  template?: string
  repoFor?: (task: Task) => string
}

// runIdFor names a run. The hash covers the arm's whole setup, the prompt template and the task's commits and commands.
export function runIdFor(task: Task, armId: string, rep: number, template: Template) {
  const hash = specHash({ arm: armSpec(armId), template: template.sha256, task: [task.base, task.reference, task.accept, task.hidden_tests, task.task] })
  return { runId: `${task.id}__${armId}__r${rep}__${hash}`, hash }
}

function runClaude(args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number) {
  return new Promise<{ code: number | null; signal: string | null; json: any; wall_s: number; timedOut: boolean; stderr_tail: string[] }>((resolve) => {
    const started = Date.now()
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      let json = null
      try { json = JSON.parse(stdout) } catch {}
      resolve({ code, signal, json, wall_s: Math.round((Date.now() - started) / 1000), timedOut, stderr_tail: stderr.split('\n').filter(Boolean).slice(-3) })
    })
  })
}

// memoryRefs counts references to another project's auto-memory folder in the run's transcripts.
// Every session is told about its own (empty) memory folder; that is fine. A reference to any other
// project's memory means the run saw the user's memory, and the row is excluded from the report.
function memoryRefs(sessionId: string | null | undefined) {
  const found = sessionFiles(sessionId)
  if (!found) return null
  let hits = 0
  for (const file of found.files) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/projects\/([^/\s"\\]+)\/memory/g)) if (m[1] !== found.project) hits++
  }
  return hits
}

const jsonLines = (file: string): any[] => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

// judgeCost reads the judge router's decision log in the run's plugin copy: every verdict, and the
// judge's own Haiku tokens priced at the dated price book. The CLI's total may not include plugin model calls,
// so the report adds this to the run's cost.
function judgeCost(dir: string) {
  const file = path.join(dir, 'plugin-v2', 'judge-log.jsonl')
  if (!fs.existsSync(file)) return null
  const lines = jsonLines(file)
  let usd = 0
  for (const l of lines.filter((x) => x.ev === 'judge' && x.usage)) {
    const u = l.usage
    usd += usageUsd({ input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite5m: u.cache_creation_input_tokens || 0, cacheWrite1h: 0 }, ANTHROPIC.rates.haiku)
  }
  return { usd, calls: lines.filter((x) => x.ev === 'judge').length, verdicts: lines.filter((x) => x.ev === 'verdict').map((v) => ({ path: v.path, effort: v.effort, by: v.by, risks: v.risks })) }
}

// v4JudgeCost sums the V4 judge's measured Haiku cost for one session from the decision records in
// the profile's plugin data folder.
function v4JudgeCost(sessionId: string | null | undefined) {
  const file = path.join(configDir(), 'plugins', 'data', 'automode', 'decisions.jsonl')
  if (!sessionId || !fs.existsSync(file)) return null
  const rows = jsonLines(file).filter((r) => r.sessionId === sessionId)
  const decisions = rows.filter((r) => r.kind === 'decision')
  return {
    usd: decisions.reduce((a, r) => a + (r.judge?.usd || 0), 0), calls: decisions.filter((r) => r.judge?.called).length,
    verdicts: decisions.map((r) => ({ tier: r.effective?.tier, model: r.effective?.model, effort: r.effective?.effort, owner: r.effective?.owner, risk: r.risk?.effective, review: r.risk?.reviewRequired, strategy: r.strategy?.chosen })),
    workers: rows.filter((r) => r.kind === 'worker').map((r) => ({ agent: r.agent, status: r.status, tokens: r.tokens })),
    escalations: rows.filter((r) => r.kind === 'escalation').length,
  }
}

function usageTrace(sessionId: string | null | undefined) {
  if (!sessionId) return null
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'am-usage.mjs'), sessionId, '--trace', '--json'], { encoding: 'utf8' })
  try { return JSON.parse(r.stdout) } catch { return null }
}

// agentChange reads the agent's whole change against the base commit, so commits it made count too, and new files.
// Call it before the hidden tests go in: the grader must see the agent's tests, never the reference's.
export function agentChange(wt: string, base: string, hiddenTests: string[]) {
  const lines = (s: string) => s.split('\n').filter(Boolean)
  const untracked = lines(git(['ls-files', '--others', '--exclude-standard'], wt))
  return {
    diff: git(['diff', base], wt) + untracked.map((f) => `\n--- new file: ${f}\n${fs.readFileSync(path.join(wt, f), 'utf8').slice(0, 20000)}`).join(''),
    shortstat: git(['diff', '--shortstat', base, '--', '.', ...hiddenTests.map((t) => `:!${t}`)], wt).trim(),
    files: new Set([...lines(git(['diff', '--name-only', base], wt)), ...untracked]).size,
  }
}

export async function oneRun(task: Task, armId: string, rep: number, ctx: RunContext) {
  const template = loadTemplate(ctx.template ?? task.prompt_template ?? 'repo-change-v1')
  const { runId, hash } = runIdFor(task, armId, rep, template)
  const prompt = renderPrompt(template, task.task)
  const spec = armSpec(armId)
  const rowHead = {
    schema_version: RESULT_SCHEMA, run_id: runId, task_id: task.id, cohort: task.cohort, arm: armId, repeat: rep,
    experiment: ctx.experiment ?? 'adhoc', spec_hash: hash, model: spec.model, alias_map: spec.alias_map, arm_env: spec.env, plugin: spec.plugin,
    prompt: { template_id: template.id, template_sha256: template.sha256, rendered_sha256: prompt.sha256, tool_schema_sha256: null as string | null },
    task_ref: { base: task.base, reference: task.reference, dataset: task.provenance?.dataset ?? 'automode-native' },
    harness: harnessInfo(), cost_basis: COST_BASIS, pricing_snapshot: pricingSnapshot(),
  }
  const dir = path.join(ctx.scratch, runId)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const wt = path.join(dir, 'wt')
  const cache = (ctx.repoFor ?? taskRepo)(task)
  git(['clone', '-q', '--no-checkout', cache, wt])
  git(['checkout', '-q', '--detach', task.base], wt)
  try {
    if (task.setup) {
      const setup = spawnSync('sh', ['-c', task.setup], { cwd: wt, encoding: 'utf8', timeout: SETUP_MS })
      if (setup.status !== 0) return { ...rowHead, exit_reason: 'setup_error' as ExitReason, setup_exit: setup.status, at: new Date().toISOString() }
    }
    const { args, env } = armInvocation(armId, dir, prompt.text)
    if (ctx.runCap) args.push('--max-budget-usd', String(ctx.runCap))
    const res = await runClaude(args, env, wt, task.limits?.wall_seconds ? task.limits.wall_seconds * 1000 : ctx.timeoutMs)
    const exit_reason = classifyRun(res)
    const j = res.json || {}
    const evidence = runEvidence(j.session_id)
    const agentHead = {
      ...rowHead, exit_reason, claude_exit: res.code, claude_signal: res.signal, is_error: j.is_error ?? null, num_turns: j.num_turns ?? null,
      cost_usd_api_equiv: j.total_cost_usd ?? null, estimated_cost_usd: estimatedUsd(evidence), reported_cost_usd: null as number | null,
      wall_s: res.wall_s, session_id: j.session_id ?? null, run_cap_usd: ctx.runCap, evidence,
    }
    if (exit_reason === 'quota') return { ...agentHead, at: new Date().toISOString() }

    const change = agentChange(wt, task.base, task.hidden_tests)
    const diffDir = path.join(path.dirname(ctx.out), 'diffs')
    fs.mkdirSync(diffDir, { recursive: true })
    fs.writeFileSync(path.join(diffDir, `${runId}.diff`), change.diff)
    // Acceptance: the reference commit's versions of the hidden tests, then the accept command.
    for (const t of task.hidden_tests) {
      fs.mkdirSync(path.dirname(path.join(wt, t)), { recursive: true })
      fs.writeFileSync(path.join(wt, t), git(['show', `${task.reference}:${t}`], cache))
    }
    const lint = task.lint ? spawnSync('sh', ['-c', task.lint], { cwd: wt, encoding: 'utf8', timeout: 5 * 60_000 }) : null
    const check = (cmd?: string) => (cmd ? spawnSync('sh', ['-c', cmd], { cwd: wt, encoding: 'utf8', timeout: SETUP_MS }).status === 0 : null)
    const typecheck_ok = check(task.typecheck)
    const regression_ok = check(task.regression)
    const acc = spawnSync('sh', ['-c', task.accept], { cwd: wt, encoding: 'utf8', timeout: SETUP_MS })
    const commits = Number(git(['rev-list', '--count', `${task.base}..HEAD`], wt).trim())
    return {
      ...agentHead,
      // A test command that never returned gave no verdict, so the row is an error and not a rejection.
      ...(acc.status === null ? { harness_error: 'accept command did not finish' } : {}),
      accepted: acc.status === 0, accept_exit: acc.status, accept_tail: (acc.stdout + acc.stderr).split('\n').filter(Boolean).slice(-8),
      model_usage: j.modelUsage ? Object.fromEntries(Object.entries<any>(j.modelUsage).map(([m, u]) => [m, {
        input: u.inputTokens ?? null, output: u.outputTokens ?? null, cache_read: u.cacheReadInputTokens ?? null,
        cache_write: u.cacheCreationInputTokens ?? null, cost_usd: u.costUSD ?? null }])) : null,
      diff_shortstat: change.shortstat,
      diff_chars: change.diff.length,
      lint_clean: lint ? lint.status === 0 : null, typecheck_ok, regression_ok, files_touched: change.files, commits_made: commits,
      trace: usageTrace(j.session_id)?.trace ?? null,
      memory_refs: memoryRefs(j.session_id),
      judge: ARMS[armId].v4 ? v4JudgeCost(j.session_id) : judgeCost(dir),
      stderr_tail: res.stderr_tail, at: new Date().toISOString(),
    }
  } finally {
    fs.rmSync(wt, { recursive: true, force: true })
  }
}
