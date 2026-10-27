// One Haiku 5.5 call through the claude CLI, outside any session state: a system prompt, a user prompt, no tools,
// no settings, no MCP. Used by the paid judge benches. Every call goes through the ledger (lib/ledger.mjs).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { add, ensure } from './ledger.mjs'

const CLAUDE = path.join(os.homedir(), '.local', 'bin', 'claude')
const PROFILE = path.join(os.homedir(), '.claude-ectest')
let empty = null

// haikuCall returns { text, usd, ok }. `estimate` is the per-call estimate the ledger checks first.
export function haikuCall(system, prompt, { cap, batch, what, estimate = 0.003 }) {
  ensure(estimate, cap, batch)
  empty ??= fs.mkdtempSync(path.join(os.tmpdir(), 'hm-haiku-'))
  // Upstream's own bench flags (bench/quality.mjs): no settings, no slash commands, no tools, no MCP, only this system
  // prompt. With project settings the CLI added context, and Haiku answered 15 of 73 judge prompts as questions.
  const r = spawnSync(CLAUDE, ['-p', prompt, '--model', 'claude-haiku-5-5', '--system-prompt', system, '--tools', '', '--disable-slash-commands', '--setting-sources', '', '--strict-mcp-config', '--output-format', 'json', '--no-session-persistence'], {
    cwd: empty, encoding: 'utf8', timeout: 60_000, maxBuffer: 1e7,
    env: { ...process.env, CLAUDE_CONFIG_DIR: PROFILE, CLAUDE_CODE_USE_VERTEX: '0', PATH: `${path.dirname(CLAUDE)}:${process.env.PATH}` },
  })
  let j = {}
  try { j = JSON.parse(r.stdout) } catch {}
  const usd = Number(j.total_cost_usd ?? 0)
  add({ batch, what, usd, model: 'claude-haiku-5-5', source: 'cli total_cost_usd' })
  return { text: String(j.result ?? ''), usd, ok: !j.is_error && typeof j.result === 'string' }
}
