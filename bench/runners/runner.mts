// A runner lets one agent try one task in a prepared workspace. It owns how the agent starts and how its reply reads.
// It never reads the hidden tests and never decides whether a task passed: bench/lib/run-one.mts does that.
import type { ExitReason } from '../lib/outcome.mts'
import type { Sandbox } from './sandbox.mts'

export interface RunRequest {
  armId: string
  workspace: string
  dir: string // the run's private folder
  prompt: string
  timeoutMs: number
  runCap: number | null
}

export interface AgentRun {
  runner: string
  exitReason: ExitReason
  exitCode: number | null
  signal: string | null
  isError: boolean | null
  turns: number | null
  costUsd: number | null
  sessionId: string | null
  modelMs: number | null
  modelUsage: Record<string, { input: number | null; output: number | null; cache_read: number | null; cache_write: number | null; cost_usd: number | null }> | null
  wallS: number
  stderrTail: string[]
  // What ran, for a runner with no transcript to read. The Claude Code runner leaves this null.
  evidence?: unknown
  toolSchemaSha256?: string | null
}

export interface AgentRunner {
  readonly id: string
  run(req: RunRequest): Promise<AgentRun>
  // A sandboxed runner also evaluates inside the sandbox, because the task's tests run code the model wrote.
  sandbox?: (workspace: string) => Sandbox
}
