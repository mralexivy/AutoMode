// Failure fingerprints and classes. The class picks an escalation path; it never forbids stronger
// reasoning. Normalization adapted from claude-router's fingerprint rules (Alexei Ledenev, MIT).
import type { FailureRecord, Tier } from './types.ts'
import { tierRank, TIERS } from './types.ts'

// A verification command: a checker, or a launcher whose subcommand names a check.
export const CHECK_COMMAND = /(^|[;&|]\s*|^\s*)(go (test|vet|build)|npm (test|run (test|lint|build|typecheck|check))|pnpm (test|run \w+)|yarn (test|lint|build)|npx (tsc|eslint|vitest|jest)|tsc\b|eslint\b|pytest\b|python -m pytest|uv run pytest|cargo (test|build|clippy|check)|mvn (test|verify)|gradle\w* (test|build)|make (test|lint|check|build)|bun test|node --test|ruff\b|mypy\b|golangci-lint\b)/

export const isCheck = (command: string) => CHECK_COMMAND.test(command)

const ENVIRONMENT = [
  /command not found/i, /no such file or directory.*(bin|exec)/i, /\bENOENT\b.*spawn/i, /cannot find module ['"][^.'"/]/i,
  /module not found: .*['"][^.'"/]/i, /no module named/i, /could not resolve host|getaddrinfo|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network is unreachable/i,
  /certificate verify failed|x509|self[- ]signed certificate/i, /\b(401|403)\b.*(unauthori[sz]ed|forbidden)|permission denied \(publickey\)/i,
  /permission denied/i, /is the docker daemon running|cannot connect to the docker daemon/i, /out of memory|ENOMEM|killed\s*$|signal: killed/im,
  /\b(env(ironment)? var(iable)?|missing required (env|configuration))\b.*(not set|missing|required)/i, /no space left on device/i,
]
const DEFECT = [
  /--- FAIL|^FAIL\b|\bFAILED\b|AssertionError|assert(ion)? failed|expected .* (to|but) /im, /\berror TS\d+|SyntaxError|TypeError|ReferenceError/,
  /panic:|undefined: \w|cannot use .* as|declared and not used|imported and not used/, /\b\d+ (failed|failing)\b/i, /error\[E\d+\]/,
  /✕|✗|\bnot ok \d+/, /\d+ problems? \(\d+ errors?/,
]
// Symptoms that look environmental but often need engineering diagnosis.
const SYSTEMIC = /timeout|timed out|connection reset|503|502|deadline exceeded|context canceled/i

// normalize strips what changes between identical failures: colors, timings, temp paths, line
// positions, addresses and run ids.
export function normalize(output: string): string {
  return output
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\b\d+(\.\d+)?\s?(ms|s|µs|ns)\b/g, '<t>')
    .replace(/\(\d+(\.\d+)?s\)/g, '(<t>)')
    .replace(/\/(?:private\/)?(?:var\/folders|tmp)\/[^\s:]+/g, '<tmp>')
    .replace(/:\d+(:\d+)?\b/g, ':<n>')
    .replace(/0x[0-9a-f]+/gi, '<addr>')
    .replace(/[ \t]+$/gm, '')
    .trim()
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

export function classify(output: string): FailureRecord['class'] {
  if (ENVIRONMENT.some((r) => r.test(output))) return 'environment'
  if (DEFECT.some((r) => r.test(output))) return 'defect'
  return 'unknown'
}

export function failureOf(command: string, exitCode: number | null, output: string, at: number, editedSince: boolean): FailureRecord | null {
  if (exitCode === 0) return null
  const norm = normalize(output)
  const tail = norm.slice(-1500)
  // The same failing tests are the same failure, whatever values the assertions print this time ("got 43",
  // then "got 44"). Keyed on failing test names when the output names them; else the normalized output.
  const names = failingTests(norm)
  const key = names.length ? `tests:${names.join(',')}` : norm.slice(-4000)
  return { fingerprint: fnv1a(`${command.trim()}|${key}`), class: classify(norm), command: command.slice(0, 200), exitCode, at, editedSince, evidence: tail }
}

// failingTests: test identifiers from go test, jest/vitest, pytest, node:test and tsc output.
export function failingTests(norm: string): string[] {
  const out = new Set<string>()
  for (const m of norm.matchAll(/^\s*--- FAIL: (\S+)/gm)) out.add(m[1])
  for (const m of norm.matchAll(/^FAIL\s+(\S+\.(?:test|spec)\.[jt]sx?)/gm)) out.add(m[1])
  for (const m of norm.matchAll(/^FAILED (\S+::\S+)/gm)) out.add(m[1])
  for (const m of norm.matchAll(/^not ok \d+ - (.+)$/gm)) out.add(m[1].trim())
  for (const m of norm.matchAll(/error (TS\d+)/g)) out.add(m[1])
  return [...out].sort().slice(0, 20)
}

// markFlaky turns a recorded failure into `flaky` when the same command now passed with no edit between.
export function markFlaky(history: FailureRecord[], command: string, passed: boolean, editedSince: boolean): FailureRecord[] {
  if (!passed || editedSince) return history
  const last = [...history].reverse().find((f) => f.command === command.slice(0, 200))
  return last ? history.map((f) => (f === last ? { ...f, class: 'flaky' as const } : f)) : history
}

export interface EscalationStep { floor: Tier | null; action: 'none' | 'raise' | 'report' | 'diagnose' | 'consult-opus'; because: string }

// escalation reads the task's failure history and returns the floor it demands and the next action.
export function escalation(history: FailureRecord[], currentTier: Tier): EscalationStep {
  const last = history[history.length - 1]
  if (!last) return { floor: null, action: 'none', because: '' }
  const same = history.filter((f) => f.fingerprint === last.fingerprint)
  const up = (t: Tier) => TIERS[Math.min(TIERS.length - 1, tierRank(t) + 1)]
  if (last.class === 'defect') {
    const repeatsAfterEdit = same.filter((f) => f.editedSince).length
    if (same.length >= 2 && repeatsAfterEdit >= 1) {
      const target = tierRank(currentTier) >= tierRank('T3') ? 'T4' : tierRank(currentTier) >= tierRank('T2') ? 'T3' : up(currentTier)
      return { floor: target, action: tierRank(target) >= tierRank('T3') ? 'consult-opus' : 'raise', because: `same failing check twice after an edit (${last.fingerprint})` }
    }
    return { floor: null, action: 'none', because: '' }
  }
  if (last.class === 'environment') {
    if (same.length >= 3 || SYSTEMIC.test(last.evidence)) return { floor: 'T2', action: 'diagnose', because: `environment-looking failure repeats or looks systemic (${last.fingerprint})` }
    return { floor: null, action: 'report', because: `environment failure: ${last.command}` }
  }
  if (last.class === 'flaky') return same.length >= 2 ? { floor: 'T2', action: 'diagnose', because: 'flaky check persists' } : { floor: null, action: 'none', because: '' }
  return same.length >= 3 ? { floor: up(currentTier), action: 'raise', because: `unknown failure repeated 3 times (${last.fingerprint})` } : { floor: null, action: 'none', because: '' }
}

// evidencePacket is what an Opus consult gets instead of the whole conversation.
export function evidencePacket(goal: string, acceptance: string[], history: FailureRecord[], edited: string[]): string {
  const last = history[history.length - 1]
  const attempts = history.filter((f) => f.fingerprint === last?.fingerprint).length
  return [
    `Goal: ${goal}`,
    acceptance.length ? `Acceptance:\n- ${acceptance.join('\n- ')}` : '',
    `Failing check (${attempts} attempts): ${last?.command ?? 'n/a'} (exit ${last?.exitCode ?? 'n/a'})`,
    last ? `Output (normalized tail):\n${last.evidence}` : '',
    edited.length ? `Files edited so far: ${edited.slice(0, 30).join(', ')}` : '',
    'Find the underlying cause. Read only what you need. Return the cause, the fix plan, and the files to change.',
  ].filter(Boolean).join('\n\n')
}

// Check commands and their exit codes. A pipe without pipefail reports the last command's exit code, so
// `go test | head` exits 0 when tests fail; `|| true` and `; true` mask failures outright.
export const hasPipe = (cmd: string) => /(^|[^|])\|(?!\|)/.test(cmd)
export const masked = (cmd: string) => /\|\|\s*(true|:)\b|;\s*true\s*$|\bexit 0\s*$/.test(cmd)
// withPipefail makes a piped check report its real exit code. Only for checks: the command's output stays
// the same; only a failure now also shows as a nonzero exit.
export function withPipefail(cmd: string): string | null {
  if (!hasPipe(cmd) || /pipefail/.test(cmd) || masked(cmd)) return null
  return `set -o pipefail; ${cmd}`
}
export const exitReliable = (cmd: string) => !masked(cmd) && (!hasPipe(cmd) || /pipefail/.test(cmd))
// Structural failure markers, line-anchored: a test runner's own summary lines, not any "FAIL" in a log.
export const FAILURE_MARKERS = /^--- FAIL: \S+|^FAIL\t\S+|^FAIL$|^\s*\d+ (failed|failing)\b|^Tests?:\s+\d+ failed|^not ok \d+ |^FAILED \S+::|error TS\d+:|^\s*AssertionError\b/m

// checkPassed: a reliable exit code decides; a masked or unreliable one falls back to the runner's own
// summary lines. Never "passed" on missing evidence: an error result is a failure.
export function checkPassed(cmd: string, exitCode: number, isError: boolean, text: string): boolean {
  if (isError || exitCode !== 0) return false
  return exitReliable(cmd) ? true : !FAILURE_MARKERS.test(text)
}
