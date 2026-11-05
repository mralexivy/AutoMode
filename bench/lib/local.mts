// local.mts: where the bench tools find the claude CLI and the isolated test profile on this machine.
// CLAUDE_BIN overrides the CLI, which is otherwise `claude` on PATH. CLAUDE_BENCH_PROFILE overrides the profile.
import os from 'node:os'
import path from 'node:path'

export const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude'
export const BENCH_PROFILE = process.env.CLAUDE_BENCH_PROFILE || path.join(os.homedir(), '.claude-ectest')
