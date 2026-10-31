// How a benchmark run ended, and what that means for the numbers. Pure: no I/O and no model calls.
//
// Exit reasons:
//   done         the agent finished. Its change is measured.
//   timeout      the runner stopped the agent. Its change is measured: every arm gets the same limit.
//   agent_error  the agent ended with an error, or the CLI reply could not be read. Its change is measured.
//   quota        a usage limit stopped the agent. The row is no result, and a resume runs it again.
//   setup_error  the task's setup command failed. The row is no result, and a resume runs it again.
export type ExitReason = 'done' | 'timeout' | 'agent_error' | 'quota' | 'setup_error'

export interface AgentExit {
  code: number | null
  json: { is_error?: boolean; result?: unknown } | null
  timedOut: boolean
  stderr_tail: string[]
}

// The CLI documents no field for a usage limit, so this reads the message. Confirm it against a real limit message
// before a long run. Only the class is saved, never the reply.
const QUOTA = /usage limit|rate limit|limit reached|hit your .*limit/i

// `claude -p` exits 0 when it stops background work at its wait ceiling, so a cut-off workflow looks finished.
const BACKGROUND_STOPPED = /Background tasks still running .*stopping them/

export function classifyRun(res: AgentExit): ExitReason {
  if (res.timedOut || BACKGROUND_STOPPED.test(res.stderr_tail.join('\n'))) return 'timeout'
  const failed = !res.json || res.json.is_error || res.code !== 0
  if (!failed) return 'done'
  return QUOTA.test(`${res.json?.result ?? ''}\n${res.stderr_tail.join('\n')}`) ? 'quota' : 'agent_error'
}

interface Row { exit_reason?: ExitReason; harness_error?: string; memory_refs?: number | null; external_eval?: string; accepted?: boolean | null }

// isDone: a resume skips this row. A quota or setup stop says nothing about the arm, so that run happens again.
export const isDone = (r: Row) => r.exit_reason !== 'quota' && r.exit_reason !== 'setup_error'

// isResult: this row counts in the numbers and goes to the grader.
// A task scored by another harness has no result until its verdict comes back.
export const isResult = (r: Row) => !r.harness_error && isDone(r) && !(r.external_eval && (r.accepted === null || r.accepted === undefined))

// chargedUsd is what a run adds to the budget. A timed-out run reports no cost, so it counts as its cap.
export function chargedUsd(cost: number | null | undefined, runCap: number | null): { usd: number; known: boolean } {
  return typeof cost === 'number' ? { usd: cost, known: true } : { usd: runCap ?? 0, known: false }
}
