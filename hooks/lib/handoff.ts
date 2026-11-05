// The handoff packet an Opus consult gets in place of the conversation. Pure: no $ and no I/O.
//
// Every fact carries where it came from, so the architect can weigh it and say what is missing. The packet is built
// from what the task already holds: the spec, the person's later messages, the acceptance criteria, the failing
// checks, the diff and the edit log. completeness() then names what that leaves out. Only a gap the conversation
// could fill, and a fork cheap next to the consult, sends a same-model fork to fill it (forkWorth).
import type { PriceRow } from './prices.ts'
import { cacheWriteX, rateAt } from './prices.ts'
import type { Family, FailureRecord } from './types.ts'

export type Source = 'spec' | 'user-prompt' | 'acceptance' | 'git-diff' | 'test-output' | 'edit-log' | 'conversation' | `command:${string}`
export interface Fact { text: string; from: Source }
export interface FailureFact { command: string; exit: number | null; attempts: number; tail: string; from: Source }
export interface Handoff {
  objective: Fact
  constraints: Fact[]
  acceptance: Fact[]
  failures: FailureFact[]
  diff: { stat: string; hunks: string } | null
  attempts: Fact[]
  unknowns: Fact[]
  because: string
}

export const TAIL_LINES = 40
export const MAX_CHARS = 21_000 // about 6k tokens at 3.5 characters a token
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} [... ${s.length - n} chars]` : s)
const tail = (s: string, lines = TAIL_LINES) => s.split('\n').slice(-lines).join('\n')

export interface HandoffInput {
  spec: string
  prompts: string[]          // the person's messages in this task after the first, in order
  acceptance: { text: string; source: string }[]
  failures: FailureRecord[]
  edited: string[]
  editsSinceOpen: string[]   // edits since the episode opened: what was tried
  diffStat?: string
  diffHunks?: string
  because: string
}

// buildHandoff: the latest failure of each failing command, newest first, and the facts around them.
export function buildHandoff(i: HandoffInput): Handoff {
  const latest = new Map<string, FailureRecord>()
  for (const f of i.failures) latest.set(f.command, f)
  const failures = [...latest.values()].reverse().slice(0, 3).map((f) => ({
    command: f.command, exit: f.exitCode, attempts: i.failures.filter((x) => x.fingerprint === f.fingerprint).length, tail: tail(f.evidence), from: `command:${f.command.slice(0, 60)}` as Source,
  }))
  return {
    objective: { text: cut(i.spec, 1500), from: 'spec' },
    constraints: i.prompts.slice(-6).map((p) => ({ text: cut(p, 400), from: 'user-prompt' as const })),
    acceptance: i.acceptance.map((a) => ({ text: a.text, from: a.source === 'user' ? ('user-prompt' as const) : ('acceptance' as const) })),
    failures,
    diff: i.diffStat ? { stat: cut(i.diffStat, 2000), hunks: cut(i.diffHunks ?? '', 6000) } : null,
    attempts: [...new Set(i.editsSinceOpen)].slice(0, 20).map((p) => ({ text: `edited ${p}`, from: 'edit-log' as const })),
    unknowns: [],
    because: i.because,
  }
}

// completeness names what the packet leaves out. A gap the conversation could fill is `conversational`: only those
// can justify a fork. The rest the architect reads for itself.
export function completeness(h: Handoff, edited: string[]): { gaps: string[]; conversational: string[] } {
  const conversational: string[] = []
  const other: string[] = []
  if (h.constraints.length) conversational.push('the person wrote after the spec; what those messages decided is not in it')
  if (!h.acceptance.length) conversational.push('no acceptance criteria')
  if (h.failures.length && !h.diff?.stat.trim() && edited.length) other.push('edits were made but the diff is empty')
  if (!h.failures.length) other.push('no failing check output')
  return { gaps: [...conversational, ...other], conversational }
}

// forkWorth: a fork reads the main prefix (a cache read while warm, a fresh write once it lapsed) and writes a short
// answer. It runs only for a conversational gap, and only while it costs under `share` of the consult itself.
export function forkWorth(x: { conversational: number; prefixTokens: number; warm: boolean; main: Family; prices: PriceRow; ttlMs: number; advisorUsd: number; replyTokens?: number; share?: number }): { run: boolean; forkUsd: number; why: string } {
  const m = rateAt(x.prices.rates[x.main], x.prefixTokens)
  const read = x.warm ? m.cacheReadX : cacheWriteX(x.ttlMs)
  const forkUsd = Math.round(((x.prefixTokens * m.input * read + (x.replyTokens ?? 1_000) * m.output) / 1e6) * 1e6) / 1e6
  const limit = (x.share ?? 0.25) * x.advisorUsd
  if (!x.conversational) return { run: false, forkUsd, why: 'no gap the conversation could fill' }
  if (forkUsd > limit) return { run: false, forkUsd, why: `a fork ($${forkUsd.toFixed(3)}) costs more than ${Math.round((x.share ?? 0.25) * 100)}% of the consult` }
  return { run: true, forkUsd, why: `a fork ($${forkUsd.toFixed(3)}) fills: conversation decisions` }
}

// FORK_PROMPT asks the session's own model, over its own transcript, for what only the conversation holds.
export const FORK_PROMPT = `AutoMode is handing a failing step to an Opus architect that cannot see this conversation. Reply with JSON only, no prose: {"constraints": [...], "unknowns": [...]}.
constraints: decisions and requirements the person stated in this conversation that a reader of the task text alone would miss. At most 8, one short sentence each.
unknowns: what is still unclear about the failure or the intended behavior. At most 5, one short sentence each.
Write facts only. Do not suggest fixes. Use [] when there are none.`

// parseForkFacts: the fork's reply as facts, or null when it is not the JSON asked for.
export function parseForkFacts(text: string): { constraints: Fact[]; unknowns: Fact[] } | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const j = JSON.parse(text.slice(start, end + 1)) as { constraints?: unknown; unknowns?: unknown }
    const list = (v: unknown, n: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, n).map((t) => ({ text: cut(t.trim(), 300), from: 'conversation' as const })) : null)
    const constraints = list(j.constraints, 8)
    const unknowns = list(j.unknowns, 5)
    return constraints && unknowns ? { constraints, unknowns } : null
  } catch { return null }
}

export const withFork = (h: Handoff, f: { constraints: Fact[]; unknowns: Fact[] }): Handoff => ({ ...h, constraints: [...h.constraints, ...f.constraints], unknowns: [...h.unknowns, ...f.unknowns] })

// renderHandoff: the packet as text, each fact with its source, under MAX_CHARS.
// CONSULT_ASK closes a packet for an architect; a rescue builder gets BUILD_ASK, since it implements, not advises.
export const CONSULT_ASK = 'Find the underlying cause. Read only what you need. Return the cause, the fix plan, and the files to change. Put every fact you needed and did not have in missing_evidence.'
export const BUILD_ASK = 'Implement the objective. Run the checks named here, the full suite and not a subset, and fix what fails until they pass. Report each file you changed and each check with its result.'

export function renderHandoff(h: Handoff, gaps: string[] = [], ask = CONSULT_ASK): string {
  const facts = (title: string, xs: Fact[]) => (xs.length ? `${title}:\n${xs.map((x) => `- ${x.text} [${x.from}]`).join('\n')}` : '')
  const parts = [
    `Objective [${h.objective.from}]: ${h.objective.text}`,
    facts('Constraints', h.constraints),
    facts('Acceptance', h.acceptance),
    h.because ? `Why you are consulted: ${h.because}` : '',
    ...h.failures.map((f) => `Failing check (${f.attempts} attempts): ${f.command} (exit ${f.exit ?? 'n/a'}) [${f.from}]\nOutput tail [test-output]:\n${f.tail}`),
    h.diff ? `Current diff [git-diff]:\n${h.diff.stat}${h.diff.hunks ? `\n\n${h.diff.hunks}` : ''}` : '',
    facts('Tried so far', h.attempts),
    facts('Unknowns', h.unknowns),
    gaps.length ? `Not in this packet: ${gaps.join('; ')}.` : '',
    ask,
  ].filter(Boolean)
  return cut(parts.join('\n\n'), MAX_CHARS)
}
