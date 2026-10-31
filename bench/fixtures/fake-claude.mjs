// Stands in for `claude -p` in bench/run.test.mts, so the harness can be tested with no model call.
// FAKE_CLAUDE picks the behavior. A test can read the arguments and env the harness passed from FAKE_CLAUDE_LOG.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const mode = process.env.FAKE_CLAUDE ?? 'solve'
if (process.env.FAKE_CLAUDE_LOG) fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args: process.argv.slice(2), apiKey: process.env.ANTHROPIC_API_KEY ?? null }))
const reply = (o) => console.log(JSON.stringify({ session_id: 'fake-session', num_turns: 1, total_cost_usd: 0.25, ...o }))
const solve = () => fs.writeFileSync('add.js', 'export const add = (a, b) => a + b\n')

if (mode === 'grade') {
  reply({ result: '{"correctness":4,"completeness":4,"scope":5,"tests":3,"maintainability":4,"defects":[],"vs_reference":"equal"}' })
} else if (mode === 'quota') {
  console.error('Claude usage limit reached')
  process.exitCode = 1
  reply({ is_error: true, result: 'Claude usage limit reached', total_cost_usd: 0 })
} else if (mode === 'hang') {
  setTimeout(() => {}, 60_000)
} else if (mode === 'solve-and-commit') {
  solve()
  execFileSync('git', ['add', 'add.js'])
  execFileSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.com', 'commit', '-q', '-m', 'agent work'])
  reply({})
} else {
  solve()
  // The agent's own test, at the path the hidden test later overwrites.
  fs.writeFileSync('add.test.js', '// AGENT TEST\n')
  reply({ modelUsage: { 'claude-sonnet-5-5': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.25 } } })
}
