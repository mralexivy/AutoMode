// Completion evidence: did the work earn "done"? Pure: no $ and no I/O. Three separate steps, so running a command is
// never mistaken for passing it.
//
//   extractObligations  what the request states as an expected result. It reads text and never runs anything.
//   observeRun          what one command's real output says about each obligation.
//   assessCompletion    one state for the task, from the obligations and the last check.
//
// An obligation holds the request's own words, so it stays in memory. A record takes `publicObligations`: id, kind and
// status, never the text.
import { classify, fnv1a } from './failures.ts'

export type ObligationStatus = 'open' | 'attempted' | 'satisfied' | 'contradicted'
export interface Obligation { id: string; kind: 'example' | 'semantic'; input?: string; expected?: string; status: ObligationStatus }
export type CompletionState = 'none' | 'unverified' | 'partially_verified' | 'failed' | 'verified'
export type CompletionGate = 'off' | 'report' | 'block'

const MAX_EXAMPLES = 16
const MAX_TEXT = 20_000
const LISTED = 8
const CLIP = 120

// A stated result: `<input> generates <expected>`. The prompt's own wording, in lowercase only, because SQL keywords
// such as RETURNS are part of an example.
const STATED = /\s(?:(?:must|should|will)\s+)?(?:generates?|gives?|becomes?|returns?|outputs?|yields?|produces?|prints?)(?:,\s*in\s+\w+,)?\s+|\s(?:->|=>|→)\s|\s(?:must|should)\s+be\s+/
const UNCHANGED = /\s(?:stays|remains|is left|is kept)\s+(?:unchanged|as is)\b/
// A lead-in clause before the example: "Reading as Oracle, SQLite or Hive, SELECT 1 ...".
const LEAD_IN = /^(?:reading|when|if|with|for|given|on|in|generating)\b.*,\s+/i
const REQUIREMENT = /\b(?:must|should|needs? to|has to|have to)\b/
const SENTENCE = /(?<=[.!?])\s+|\n{2,}/
const QUOTES = /^['"`]+|['"`]+$/g

const tidy = (s: string) => s.trim().replace(/[.,;:]$/, '').replace(QUOTES, '').trim()

// literal: text that reads as data, not prose. "SELECT 1", "f(x)" and 'abc' count; "a 400 error" and "The API" do not.
function literal(s: string): boolean {
  if (/[()=<>{}[\]"'`_/*]/.test(s)) return true
  return /\b[A-Z]{2,}\b/.test(s) && /\d/.test(s)
}

// Plain words before the example: "Fix parse so parse('a') ...". An example starts at a symbol or an upper-case keyword.
const LEAD_WORDS = /^(?:[A-Za-z]*[a-z][A-Za-z]*\s+)+(?=\S*[^A-Za-z\s]|[A-Z]{2,})/

const PROSE = /^(?:[A-Za-z]*[a-z][A-Za-z]*\s+){2,}/
const inputOf = (before: string) => tidy((before.split(/:\s+/).pop() ?? before).replace(LEAD_IN, '').replace(LEAD_WORDS, ''))
const obligation = (kind: Obligation['kind'], input?: string, expected?: string): Obligation =>
  ({ id: fnv1a(`${kind}|${input ?? ''}|${expected ?? ''}`), kind, ...(input ? { input } : {}), ...(expected ? { expected } : {}), status: 'open' })

function exampleIn(sentence: string): Obligation | null {
  const same = sentence.match(UNCHANGED)
  if (same) {
    const input = inputOf(sentence.slice(0, same.index))
    return literal(input) ? obligation('example', input, input) : null
  }
  const m = sentence.match(STATED)
  if (!m) return null
  const input = inputOf(sentence.slice(0, m.index))
  const expected = tidy(sentence.slice(m.index! + m[0].length))
  // A literal input can state a bare value: foo(1) returns 2. An expected value that opens with prose describes the
  // result, and no program prints it: "x must be a separate list equal to ['foo']" had every check that named x read
  // as a contradiction, and the gate blocked a finished task (jinja, in the benchmark).
  if (PROSE.test(expected)) return null
  return input && expected && literal(input) && (literal(expected) || !/\s/.test(expected)) ? obligation('example', input, expected) : null
}

// extractObligations: the stated examples of a request, in order and without repeats. A requirement with no example
// becomes one semantic obligation. No output can settle it, so it holds the task below `verified` and never blocks.
export function extractObligations(text: string): Obligation[] {
  const seen = new Map<string, Obligation>()
  let semantic = false
  for (const sentence of text.slice(0, MAX_TEXT).split(SENTENCE)) {
    const example = exampleIn(sentence)
    if (example) { if (seen.size < MAX_EXAMPLES) seen.set(example.id, example) } else if (REQUIREMENT.test(sentence)) semantic = true
  }
  return [...seen.values(), ...(semantic ? [obligation('semantic')] : [])]
}

export interface CommandRun { command: string; output: string; exit: number }

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
// Reading a file or a diff can show the request's own words. That is not the program's result.
const VIEWER = /^\s*(?:cat|head|tail|less|more|grep|rg|sed|awk|ls|find|echo|printf|diff|git\s+(?:diff|show|log|grep))\b/

// observeRun: what one command says about each obligation. An edit reopens them (`reopen`), so a status always rests on
// the code as it stands. Two examples can share an input and differ by dialect. A command that printed one of them says
// nothing against the other.
export function observeRun(obligations: Obligation[], run: CommandRun): Obligation[] {
  if (VIEWER.test(run.command)) return obligations
  const command = flat(run.command)
  const output = flat(run.output)
  const shown = (o: Obligation) => !!o.expected && output.includes(flat(o.expected))
  const named = (o: Obligation) => !!o.input && command.includes(flat(o.input))
  const asserted = (o: Obligation) => named(o) && !!o.expected && command.includes(flat(o.expected))
  const sibling = (o: Obligation) => obligations.some((x) => x !== o && x.input === o.input && shown(x))
  const environment = run.exit !== 0 && classify(run.output) === 'environment'
  return obligations.map((o) => {
    if (o.kind !== 'example') return o
    if (run.exit === 0 && (shown(o) || asserted(o))) return { ...o, status: 'satisfied' as const }
    if (!named(o)) return o
    if (environment) return { ...o, status: 'attempted' as const }
    if (run.exit !== 0 || (output && !sibling(o))) return { ...o, status: 'contradicted' as const }
    return { ...o, status: 'attempted' as const }
  })
}

// reopen: an edit changed the code, so what the earlier runs showed no longer stands.
export const reopen = (obligations: Obligation[]): Obligation[] => obligations.map((o) => (o.status === 'open' ? o : { ...o, status: 'open' as const }))

export interface CompletionEvidence { edited: boolean; editedSinceCheck: boolean; lastCheckPassed: boolean | null; obligations: Obligation[] }

export function assessCompletion(e: CompletionEvidence): CompletionState {
  if (!e.edited) return 'none'
  if (e.obligations.some((o) => o.status === 'contradicted')) return 'failed'
  if (e.lastCheckPassed === null || e.editedSinceCheck) return 'unverified'
  if (!e.lastCheckPassed) return 'failed'
  return e.obligations.every((o) => o.status === 'satisfied') ? 'verified' : 'partially_verified'
}

const clip = (s: string) => (s.length > CLIP ? `${s.slice(0, CLIP)}...` : s)

export interface StopContext { gate: CompletionGate; stopHookActive: boolean; blocks: number; backgroundWork: number }

// blockReason: what to tell the model when the evidence does not support finishing, or null to let it stop. One block
// per task bounds the cost, and it means a fault in this module cannot become a loop.
export function blockReason(state: CompletionState, obligations: Obligation[], c: StopContext): string | null {
  if (c.gate !== 'block' || c.stopHookActive || c.blocks > 0 || c.backgroundWork > 0) return null
  const open = obligations.filter((o) => o.kind === 'example' && o.status !== 'satisfied')
  if (state !== 'unverified' && state !== 'failed' && !open.length) return null
  const lines = [`AutoMode completion check: the work is ${state.replace('_', ' ')}. A passing suite does not show that a stated result holds.`]
  if (state === 'unverified') lines.push('Run the project checks on the code as it stands.')
  if (state === 'failed' && !open.length) lines.push('The last check failed. Fix it, or say why it does not apply.')
  if (open.length) {
    lines.push('Run each stated result below, print the real output, and compare it with the expected text. Fix any difference.')
    for (const o of open.slice(0, LISTED)) lines.push(`- ${o.status}: ${clip(o.input ?? '')} -> ${clip(o.expected ?? '')}`)
    if (open.length > LISTED) lines.push(`- and ${open.length - LISTED} more in the request.`)
  }
  lines.push('If a result cannot be checked here, say so in your answer.')
  return lines.join('\n')
}

export const publicObligations = (obligations: Obligation[]) => obligations.map(({ id, kind, status }) => ({ id, kind, status }))
