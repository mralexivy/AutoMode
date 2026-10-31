// The agent as users run it: `claude -p`, with the arm's flags. This is the only runner of the AutoMode system track.
import { spawn } from 'node:child_process'
import { armInvocation } from '../arms.mts'
import { classifyRun } from '../lib/outcome.mts'
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

export const claudeCodeRunner: AgentRunner = {
  id: 'claude-code',
  async run(req: RunRequest): Promise<AgentRun> {
    const { args, env } = armInvocation(req.armId, req.dir, req.prompt)
    if (req.runCap) args.push('--max-budget-usd', String(req.runCap))
    const res = await runClaude(args, env, req.workspace, req.timeoutMs)
    const j = res.json || {}
    return {
      runner: 'claude-code', exitReason: classifyRun(res), exitCode: res.code, signal: res.signal, isError: j.is_error ?? null, turns: j.num_turns ?? null,
      costUsd: j.total_cost_usd ?? null, sessionId: j.session_id ?? null, modelMs: j.duration_api_ms ?? null, wallS: res.wall_s, stderrTail: res.stderr_tail,
      modelUsage: j.modelUsage ? Object.fromEntries(Object.entries<any>(j.modelUsage).map(([m, u]) => [m, {
        input: u.inputTokens ?? null, output: u.outputTokens ?? null, cache_read: u.cacheReadInputTokens ?? null,
        cache_write: u.cacheCreationInputTokens ?? null, cost_usd: u.costUSD ?? null }])) : null,
    }
  },
}
