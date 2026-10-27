// Read-only guard for AutoMode's read-only agents (explorer, architect, diagnoser, reviewer).
// Plugin agents ignore permissionMode, hooks and mcpServers in their frontmatter, so the allowlist
// in each agent file is backed by this guard, keyed on the agent's id. It denies by default when a
// Bash command does not parse into simple read-only parts.

export const READ_ONLY_AGENTS = ['automode:explorer', 'automode:architect', 'automode:diagnoser', 'automode:reviewer']
export const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']

// Commands a read-only agent may run, matched against each simple command.
const READ_ONLY_COMMAND = [
  /^git (diff|log|show|status|blame|ls-files|grep|rev-parse|branch( --show-current| -a| -r| --list)?|describe)\b/,
  /^(ls|cat|head|tail|wc|grep|rg|find|pwd|echo|stat|file|which|tree|sort|uniq|cut|jq|diff)\b/,
  /^(go (test|vet|build|list|version|env)|npm (test|run (test|lint|build|typecheck|check))|npx (tsc|eslint|vitest|jest)( |$)|tsc|eslint|pytest|python -m pytest|uv run pytest|cargo (test|check|clippy)|make (test|lint|check)|node --test|bun test|ruff( check)?|mypy|golangci-lint run)\b/,
]

// Patterns that write, install, fetch, or run arbitrary code, anywhere in the command.
const WRITES = [
  { why: 'output redirection', re: /(^|[^<>&0-9])>>?(?!&)|\btee\b/ },
  { why: 'in-place edit', re: /\b(sed|perl)\b[^|;&]*\s-[a-zA-Z]*i/ },
  { why: 'file operation', re: /(^|[\s;&|(])(rm|mv|cp|touch|mkdir|rmdir|chmod|chown|ln|install|truncate|dd)\s/ },
  { why: 'git write', re: /\bgit\s+(commit|checkout|switch|reset|apply|am|stash|restore|clean|push|pull|fetch|merge|rebase|cherry-pick|revert|tag|branch\s+-[dDmM]|worktree|init|clone|config|add|rm|mv|update-ref|gc|prune)\b/ },
  { why: 'package install', re: /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci|update|upgrade|remove|uninstall|link)\b|\bpip3?\s+install|\bgo\s+(get|install|mod\s+(tidy|download|vendor|edit|init))|\bbrew\s|\bapt(-get)?\s|\bcargo\s+(install|add|update)/ },
  { why: 'download', re: /\bcurl\b[^|;&]*\s-[a-zA-Z]*[oO]|\bwget\b/ },
  { why: 'inline interpreter', re: /\b(python3?|node|ruby|perl|bash|sh|zsh|deno|bun)\s+(-[a-zA-Z]*[ce]\b|--eval)/ },
  { why: 'command substitution', re: /\$\(|`/ },
  { why: 'background or eval', re: /\b(eval|exec|source|nohup|xargs)\b|&\s*$/ },
  { why: 'go test writes', re: /\bgo\s+test\b[^|;&]*\s-(update|golden|coverprofile|cpuprofile|memprofile|o)\b/ },
]

// Git writes and destructive commands that no subagent of a AutoMode session may run, whatever its
// type. Same rules as an external signals writer BLOCKED, which owns this check only when V4 is not in auto.
export const SUBAGENT_BLOCKED = [
  /\bgit\s+(commit|push|merge|rebase|cherry-pick|revert|am|tag)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\bgit\s+checkout\s+(--\s|\.\s*$|-f\b)/,
  /\bgit\s+restore\b(?!.*--staged)/,
  /\bgit\s+stash\s+(drop|clear)\b/,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+worktree\s+remove\b/,
  /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/,
]
export const subagentBlocked = (command: string) => SUBAGENT_BLOCKED.some((re) => re.test(command))

export interface GuardVerdict { allow: boolean; why?: string }

export function guardBash(command: string): GuardVerdict {
  const cmd = command.trim()
  if (!cmd) return { allow: false, why: 'empty command' }
  for (const w of WRITES) if (w.re.test(cmd)) return { allow: false, why: w.why }
  // Split on && and | only; ; and || are refused because their status can hide a failure.
  if (/;|\|\|/.test(cmd)) return { allow: false, why: 'compound command' }
  const parts = cmd.split(/&&|\|/).map((p) => p.trim()).filter(Boolean)
  for (const part of parts) {
    const simple = part.replace(/^(\w+=\S+\s+)+/, '') // leading VAR=value assignments
    if (/^(\w+=\S+\s+)+/.test(part) && /\b(PATH|LD_|DYLD_|GIT_|NODE_OPTIONS)/.test(part)) return { allow: false, why: 'environment override' }
    if (!READ_ONLY_COMMAND.some((r) => r.test(simple))) return { allow: false, why: `not a known read-only command: ${simple.split(/\s/)[0]}` }
  }
  return { allow: true }
}

export function guardTool(tool: string, input: { command?: unknown }): GuardVerdict {
  if (WRITE_TOOLS.includes(tool)) return { allow: false, why: `${tool} is a write tool` }
  if (tool.startsWith('mcp__')) return { allow: false, why: 'MCP tools are not allowed for read-only agents' }
  if (tool === 'Bash') return guardBash(String(input.command ?? ''))
  return { allow: true }
}
