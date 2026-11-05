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
  resume?: string // continue this Claude Code session (E5 multi-task sessions)
  accept?: string // the task's accept command: the agent gets the same path settings (runners/claude-code.mts workspaceEnv)
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
  // The model's last reply, held in memory only, for a question step's grader (e5-sessions.mts). Never saved: results
  // hold no model reply text.
  answer?: string
  // What ran, for a runner with no transcript to read. The Claude Code runner leaves this null.
  evidence?: unknown
  toolSchemaSha256?: string | null
  // The final message's explicit claim (bench/lib/claim.mts): true for done, false for not done, null for no status line.
  finalStatus?: boolean | null
  limitMessage?: string | null // the CLI's own usage-limit line, when it stopped on one; never model text
}

export interface AgentRunner {
  readonly id: string
  run(req: RunRequest): Promise<AgentRun>
  // A sandboxed runner also evaluates inside the sandbox, because the task's tests run code the model wrote.
  sandbox?: (workspace: string) => Sandbox
}
