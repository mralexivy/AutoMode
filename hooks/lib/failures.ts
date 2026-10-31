// Failure fingerprints and classes. The class picks an escalation path; it never forbids stronger
// reasoning. Normalization adapted from claude-router's fingerprint rules (Alexei Ledenev, MIT).
import type { FailureRecord, LadderState, Tier } from './types.ts'
import { tierRank, TIERS } from './types.ts'
import { tools } from './shell.ts'

// A verification tool, read after shell.ts removed its wrappers. Package managers may carry flags before the script.
// Each flag must read one way only, or a failed match tries every split, and this runs synchronously before the tool
// call. So a value cannot start with a dash, and a name cannot: `--x` is never `-` plus `-x`.
const PM_FLAGS = String.raw`(?:\s+--?\w[\w-]*(?:=\S+|\s+[^-\s]\S*)?)*`
const CHECKS = [
  String.raw`go (test|vet|build)\b`,
  String.raw`npm${PM_FLAGS}\s+(t|test|run${PM_FLAGS}\s+(test|lint|build|typecheck|check))\b`,
  String.raw`pnpm${PM_FLAGS}\s+(test|lint|build|typecheck|run${PM_FLAGS}\s+\w+)\b`,
  String.raw`yarn${PM_FLAGS}\s+(test|lint|build|typecheck|run\s+(test|lint|build|typecheck|check))\b`,
  String.raw`bun\s+(test|run\s+(test|lint|build|typecheck|check))\b`,
  String.raw`deno (test|lint|check)\b`,
  String.raw`(tsc|eslint|vitest|jest|mocha|ava|pytest|py\.test|unittest|nose2|tox|nox|ruff|mypy|pyright|flake8|pylint|rspec|phpunit|ctest|shellcheck|golangci-lint)\b`,
  String.raw`(black|prettier)\b.*\s--check\b`,
  String.raw`biome (check|ci|lint)\b`,
  String.raw`playwright test\b`,
  String.raw`cypress run\b`,
  String.raw`cargo(\s+\+\S+)?\s+(test|build|clippy|check|nextest)\b`,
  String.raw`mvnw?\b.*\s(test|verify)\b`,
  String.raw`gradle\w*\b.*\s(test|check|build)\b`,
  String.raw`make\b(\s+-\S+(\s+[^-\s]\S*)?)*\s+(test|lint|check|build)\b`,
  String.raw`rake (test|spec)\b`,
  String.raw`(dotnet|swift) (test|build)\b`,
  String.raw`(mix|flutter) test\b`,
  String.raw`node\b.*\s--test\b`,
  String.raw`python[\d.]*\s+(\S+/)?manage\.py test\b`,
]
export const CHECK_COMMAND = new RegExp(`^(?:${CHECKS.join('|')})`)
// A tool asked about itself runs no check.
const NOT_A_RUN = /\s(--version|--help|-h|--collect-only)(\s|$)/

export const isCheck = (command: string) => tools(command).some((t) => CHECK_COMMAND.test(t) && !NOT_A_RUN.test(t))

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
  return { fingerprint: fnv1a(`${command.trim()}|${key}`), class: classify(norm), command: command.slice(0, 200), exitCode, at, editedSince, evidence: tail, ...(names.length ? { tests: names } : {}) }
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

// failureStep reads the task's failure history and returns what the failure itself asks for: report an environment
// problem, diagnose one that persists, and under policy legacy the floor. Policy auto moves through escalation() below.
export function failureStep(history: FailureRecord[], currentTier: Tier): EscalationStep {
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

// The escalation ladder, policy auto. Evidence is weak or strong, and the strength picks the remedy. Weak evidence raises
// the effort one step and keeps the cache. Strong evidence moves the model, and asks an Opus consult first. Each cause
// acts once: `fired` carries the keys already spent.
export interface LadderSignals {
  raised: Record<string, number>             // failure fingerprint: its count when a step ran for it
  passed: Record<string, number>             // check command: when it last passed in this task
  editedSincePass?: (at: number) => string[] // the paths edited after that moment
  toolErrors: number                         // tool errors in a row
  scopeGrew: boolean
  reverts: number
  reviewerBlockers: number
  effortCapped: boolean                      // the running model has no effort step left
  fired: string[]
}
export type EscalationLevel = 'none' | 'weak' | 'strong'
// cause: what a consult answers, so one cause gets one consult. check: a failing check is the evidence.
export interface Escalation { level: EscalationLevel; because: string; key: string; cause: string; check: boolean; fingerprint?: string }

const NO_ESCALATION: Escalation = { level: 'none', because: '', key: '', cause: '', check: false }
const COMPILE_ERROR = /\berror TS\d+|\bSyntaxError\b|cannot find symbol|\bundefined: \w|error\[E\d+\]|declared and not used|compilation (failed|error)/i
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs)\/|[._-](test|spec)\.[a-z]+$/i

// resolved: the failure's own command passed after it, so the failure is history and says nothing about now.
const resolved = (f: FailureRecord, passed: Record<string, number>) => (passed[f.command] ?? -Infinity) > f.at

// regression: this repair broke something that worked. A command that passed and now fails, a build that now fails
// where tests ran before, or tests that newly fail. A failure after edits to tests alone is not one: that is a new test.
export function regression(history: FailureRecord[], s: Pick<LadderSignals, 'passed' | 'editedSincePass'>): 'test' | 'compile' | null {
  const last = history[history.length - 1]
  if (!last?.editedSince || last.class !== 'defect' || resolved(last, s.passed)) return null
  const before = [...history.slice(0, -1)].reverse().find((f) => f.command === last.command)
  const compile = COMPILE_ERROR.test(last.evidence)
  const passedAt = s.passed[last.command]
  if (passedAt !== undefined && passedAt < last.at && (!before || passedAt > before.at)) {
    const edited = s.editedSincePass?.(passedAt) ?? []
    if (edited.length && edited.every((p) => TEST_PATH.test(p))) return null
    return compile ? 'compile' : 'test'
  }
  if (!before) return null
  if (compile && !COMPILE_ERROR.test(before.evidence)) return 'compile'
  const known = new Set(before.tests ?? [])
  return !compile && known.size && (last.tests ?? []).some((t) => !known.has(t)) ? 'test' : null
}

// escalation reads the failures and the task's other signals, strongest evidence first. An environment failure or a
// flaky check says nothing about the model, so neither counts here.
export function escalation(history: FailureRecord[], s: LadderSignals): Escalation {
  const open = (key: string) => !s.fired.includes(key)
  const pick = (level: EscalationLevel, because: string, key: string, cause: string, f?: FailureRecord): Escalation =>
    ({ level, because, key, cause, check: !!f, ...(f ? { fingerprint: f.fingerprint } : {}) })
  if (s.reviewerBlockers > 0 && open(`reviewer:${s.reviewerBlockers}`)) return pick('strong', 'the reviewer found a blocker', `reviewer:${s.reviewerBlockers}`, 'reviewer')
  if (s.reverts > 0 && open(`revert:${s.reverts}`)) return pick('strong', 'the task reverted its own work', `revert:${s.reverts}`, 'revert')
  const last = history[history.length - 1]
  if (last && !resolved(last, s.passed)) {
    const fp = last.fingerprint
    const kind = regression(history, s)
    if (kind && open(`regression:${fp}`)) return pick('strong', `${kind} regression (${last.command.slice(0, 60)})`, `regression:${fp}`, fp, last)
    const count = history.filter((f) => f.fingerprint === fp).length
    const repeats = last.editedSince && ((last.class === 'defect' && count >= 2) || (last.class === 'unknown' && count >= 3))
    if (repeats) {
      const again = `repeat:${fp}:${count}`
      if (s.raised[fp] !== undefined) { if (count > s.raised[fp] && open(again)) return pick('strong', `the same check failed after an effort raise (${fp})`, again, fp, last) }
      else if (s.effortCapped) { if (open(again)) return pick('strong', `the same check failed at the top effort (${fp})`, again, fp, last) }
      else if (open(`repeat:${fp}`)) return pick('weak', `the same check failed after an edit (${fp})`, `repeat:${fp}`, fp, last)
    }
  }
  if (s.toolErrors >= 3 && open('tools')) return pick('weak', `${s.toolErrors} tool errors in a row`, 'tools', 'tools')
  if (s.scopeGrew && open('scope')) return pick('weak', 'the change grew past its scope', 'scope', 'scope')
  return NO_ESCALATION
}

// A new ladder starts empty. A task from an earlier version has none.
export const EMPTY_LADDER: LadderState = { raised: {}, passed: {}, toolErrors: 0, scopeGrew: false, reverts: 0, reviewerBlockers: 0, fired: [] }

// isRevert: a command that throws away the task's work. `git restore` counts as guard.ts counts it: all but --staged.
const REVERT = /^git\s+(revert\b|reset\s+--hard\b|checkout\s+(--\s|\.\s*$)|restore\b(?!.*--staged))/
export const isRevert = (command: string) => tools(command).some((t) => REVERT.test(t))

// reviewerBlocked: agents/reviewer.md uses `changes_required` only when a finding is a blocker.
export const reviewerBlocked = (answer: string) => /\bchanges_required\b/.test(answer)

// scopeGrew: the edits left the known scope. With discovery data that is 4 files outside it. Without any, only the
// count is known, so the bar is the large-change file count.
export function scopeGrew(edited: string[], known: Set<string>, outsideLimit: number, largeFiles: number): boolean {
  return known.size ? edited.filter((p) => !known.has(p)).length >= outsideLimit : edited.length > largeFiles
}

// evidencePacket is what an Opus consult gets instead of the whole conversation.
export function evidencePacket(goal: string, acceptance: string[], history: FailureRecord[], edited: string[], because = ''): string {
  const last = history[history.length - 1]
  const attempts = history.filter((f) => f.fingerprint === last?.fingerprint).length
  return [
    `Goal: ${goal}`,
    acceptance.length ? `Acceptance:\n- ${acceptance.join('\n- ')}` : '',
    because ? `Why you are consulted: ${because}` : '',
    last ? `Failing check (${attempts} attempts): ${last.command} (exit ${last.exitCode ?? 'n/a'})` : '',
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
