// The agent as users run it: `claude -p`, with the arm's flags. This is the only runner of the AutoMode system track.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { armInvocation } from '../arms.mts'
import { classifyRun, limitLine } from '../lib/outcome.mts'
import { claimOf } from '../lib/claim.mts'
import type { AgentRun, AgentRunner, RunRequest } from './runner.mts'

function runClaude(args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number) {
  return new Promise<{ code: number | null; signal: string | null; json: any; wall_s: number; timedOut: boolean; stderr_tail: string[] }>((resolve) => {
    const started = Date.now()
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      // A process that ignores SIGTERM must not hold the benchmark.
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
    }, timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      let json = null
      try { json = JSON.parse(stdout) } catch {}
      resolve({ code, signal, json, wall_s: Math.round((Date.now() - started) / 1000), timedOut, stderr_tail: stderr.split('\n').filter(Boolean).slice(-3) })
    })
  })
}

// workspaceEnv gives the agent the path settings the grader uses. A task's `accept` sets them inline, such as
// PYTHONPATH=src:.bench-deps. Without the same paths the agent's own test runs fail on imports, so it never sees the
// real failures (rescue-delivery, pymarkdown: 87 import errors hid 2 failing tests; the preflight then found jinja and
// marshmallow, whose `src` layout the first fix missed). They are read from the accept command, never guessed, and
// made absolute in the workspace. The same for every arm, and nothing hidden: the paths name the workspace only.
const PATH_VARS = ['PYTHONPATH', 'NODE_PATH']
export function graderPaths(accept: string | undefined, workspace: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of (accept ?? '').matchAll(/(?:^|&&|\|\||;)\s*((?:[A-Z_][A-Z0-9_]*=\S*\s+)+)/g)) {
    for (const a of m[1].trim().split(/\s+/)) {
      const [k, v] = [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]
      if (PATH_VARS.includes(k) && !(k in out)) out[k] = v.split(':').filter(Boolean).map((p) => (path.isAbsolute(p) ? p : path.join(workspace, p))).join(path.delimiter)
    }
  }
  return out
}
export function workspaceEnv(workspace: string, env: NodeJS.ProcessEnv, accept?: string): NodeJS.ProcessEnv {
  const paths = graderPaths(accept, workspace)
  const deps = path.join(workspace, '.bench-deps')
  if (!paths.PYTHONPATH && fs.existsSync(deps)) paths.PYTHONPATH = deps
  const merged = { ...env }
  for (const [k, v] of Object.entries(paths)) merged[k] = env[k] ? `${v}${path.delimiter}${env[k]}` : v
  return merged
}

export const claudeCodeRunner: AgentRunner = {
  id: 'claude-code',
  async run(req: RunRequest): Promise<AgentRun> {
    const { args, env } = armInvocation(req.armId, req.dir, req.prompt)
    if (req.runCap) args.push('--max-budget-usd', String(req.runCap))
    if (req.resume) args.push('--resume', req.resume)
    const res = await runClaude(args, workspaceEnv(req.workspace, env, req.accept), req.workspace, req.timeoutMs)
    const j = res.json || {}
    return {
      runner: 'claude-code', exitReason: classifyRun(res), exitCode: res.code, signal: res.signal, isError: j.is_error ?? null, turns: j.num_turns ?? null,
      costUsd: j.total_cost_usd ?? null, sessionId: j.session_id ?? null, answer: typeof j.result === 'string' ? j.result : undefined, modelMs: j.duration_api_ms ?? null, wallS: res.wall_s, stderrTail: res.stderr_tail, finalStatus: claimOf(j.result), limitMessage: classifyRun(res) === 'quota' ? limitLine(j.result) ?? limitLine(res.stderr_tail.join('\n')) : null,
      modelUsage: j.modelUsage ? Object.fromEntries(Object.entries<any>(j.modelUsage).map(([m, u]) => [m, {
        input: u.inputTokens ?? null, output: u.outputTokens ?? null, cache_read: u.cacheReadInputTokens ?? null,
        cache_write: u.cacheCreationInputTokens ?? null, cost_usd: u.costUSD ?? null }])) : null,
    }
  },
}
