// Session and cost guardian: the pure part. No `$`, no I/O; hooks/guardian.ts feeds it and acts on its answers.
// It watches one main-loop turn and the session around it, and answers three questions:
//   progress  - is the turn still producing outcomes (a check that passes after a change, an approved plan, a commit),
//               or spending without them (the same call again, the same failure again, many requests since the last
//               outcome)? The answer is a level: normal, optimize, warning, pause.
//   lifecycle - at a task boundary: continue in this context, compact it, or clear with a handoff. Priced on the
//               remaining requests, the cache state, and the cost of rebuilding the state a reset drops.
//   output    - which large tool results to shorten before they stay in context, keeping every error line, with the
//               full text saved where the model can read it.
// Model and effort stay with the router: the guardian prices with the running model and never picks one.
import type { Family } from './types.ts'
import { ANTHROPIC, cacheWriteX } from './prices.ts'

// ---------------------------------------------------------------- configuration
// Modes, each including the one before:
//   off        nothing
//   observe    records only (telemetry)
//   recommend  notes to the model when a turn stops converging, and toasts with the savings case
//   assist     checkpoints, the handoff after /clear (verified), and the one-key /clear or /compact suggestion
//   auto       also the supported automatic actions the person opted into: autoCompact, hardPause, reduceOutputs
// `auto` never accepts edits, runs git, or widens permissions. Old values: `shadow` is observe, `on` is assist.
export type GuardianMode = 'off' | 'observe' | 'recommend' | 'assist' | 'auto'
const MODE_RANK: Record<GuardianMode, number> = { off: 0, observe: 1, recommend: 2, assist: 3, auto: 4 }
export function modeOf(v: unknown): GuardianMode {
  const s = String(v ?? '').trim().toLowerCase()
  if (s === 'shadow') return 'observe'
  if (s === 'on') return 'assist'
  return (s in MODE_RANK ? s : 'observe') as GuardianMode
}
export const atLeast = (m: GuardianMode, floor: GuardianMode) => MODE_RANK[m] >= MODE_RANK[floor]
export interface GuardianConfig {
  mode: GuardianMode
  everySession: boolean              // also outside AutoMode (the plain Opus picker)
  // Progress gates, calibrated from 30 days of turns (bench/guardian-replay.mts, 2026-10-26): the p90 of requests and
  // of API-equivalent USD between two outcomes. Vertex period (n 445): p90 45 requests / $3.36, p95 56 / $4.65;
  // held out, first party (n 85): p90 33 / $2.49. The gates sit at about p95, so a productive stretch rarely crosses them.
  warnRequests: number
  warnUsd: number
  pauseFactor: number                // pause at this multiple of both warning gates, or on a third identical failure
  repeatCalls: number                // the same call this many times in a turn is a repeat
  weakOutcomes: boolean              // count every third new file changed as an outcome where no check exists
  turnBudgetUsd: number | null       // an optional hard budget per turn (null: none)
  hardPause: boolean                 // opt-in, mode auto: end the turn with $.turn.abort at a request boundary (else a note only)
  // Lifecycle
  minContextTokens: number           // below this, a reset never pays: continue
  handoffTokens: number              // the size of a handoff the new session reads
  rebuildTokens: number              // state a reset drops that the next task may read again (estimate)
  summaryTokens: number              // a compaction summary's size
  margin: number                     // a reset must beat continuing by this share
  compactStaleShare: number          // compact only when history older than the task is at least this share of the context
  horizon: number                    // requests a route is expected to run (p25 of the first-party route horizon at a prompt)
  coldReturnRate: number             // at a turn end, the chance the next prompt comes after the cache expired: 30 of 330
                                     // large-context turn ends in 30 days of engineering sessions (2026-10-26)
  autoCompact: boolean               // opt-in, mode auto: call $.session.compact between turns instead of suggesting /compact
  // Output reduction
  reduceOutputs: boolean             // opt-in
  reduceAboveChars: number          // below Claude Code's own bashOutputMaxChars (30,000 by default), which already moves longer
                                     // Bash output to a file; MCP results have no native spill
}

export const GUARDIAN_DEFAULTS: GuardianConfig = {
  mode: 'observe', everySession: false,
  warnRequests: 55, warnUsd: 4.5, pauseFactor: 2, repeatCalls: 3, weakOutcomes: true, turnBudgetUsd: null, hardPause: false,
  minContextTokens: 150_000, handoffTokens: 4_000, rebuildTokens: 20_000, summaryTokens: 10_000, margin: 0.2, compactStaleShare: 0.5, horizon: 8, coldReturnRate: 0.09, autoCompact: false,
  reduceOutputs: false, reduceAboveChars: 12_000,
}

// ---------------------------------------------------------------- progress
export type Outcome = 'check-passed' | 'plan-approved' | 'commit' | 'files-changed'
export type Level = 'normal' | 'optimize' | 'warning' | 'pause'

export interface TurnState {
  turnId: string
  startedAt: number
  requests: number
  usd: number
  sinceOutcome: { requests: number; usd: number }
  outcomes: { kind: Outcome; at: number; request: number }[]
  calls: Record<string, number>           // fingerprint -> count this turn
  failures: Record<string, { hash: string; repeats: number }> // check fingerprint -> last failing output
  editsSinceCheck: number
  newFiles: string[]                       // files changed this turn, for the weak outcome
  filesSinceOutcome: number
  authorized: number                       // the person allowed this many more warning windows (am:continue)
  noted: Level                             // the highest level already told to the model this outcome window
  writesInFlight: boolean                  // the last request issued a write or a transactional command
}

export const newTurn = (turnId: string, at: number, authorized = 0): TurnState => ({
  turnId, startedAt: at, requests: 0, usd: 0, sinceOutcome: { requests: 0, usd: 0 }, outcomes: [], calls: {}, failures: {},
  editsSinceCheck: 0, newFiles: [], filesSinceOutcome: 0, authorized, noted: 'normal', writesInFlight: false,
})

export const CHECK = /\b(go (test|vet|build)|npm (run )?(test|build|lint|typecheck)|pnpm (test|build)|yarn (test|build)|node --test|pytest|jest|vitest|make (test|check|build|lint)|claude plugin (test|validate)|tsc|cargo (test|build|check)|xcodebuild|swift (test|build)|mvn (test|verify)|gradlew? (test|build))\b/
const FAILED = /\b(FAIL(ED)?|error TS\d+|Error:|failed|panic:|Traceback|exit code [1-9]|✗|ERR!)/i
// Summary lines that report zero failures ("ℹ fail 0" from node --test, "0 failed", "failures: 0", "errors: 0").
// Live check L6 (2026-10-26): a passing `node --test` run read as a failure because of "fail 0".
const ZERO_FAILURES = /\b(fail(?:ed|ures?|ing)?|errors?)\s*[:=]?\s*0\b|\b0\s+(fail(?:ed|ures?|ing)?|errors?)\b/gi
// failedOutput: the runtime's error flag (a non-zero exit) first; then the text, with zero-count summaries removed.
export const failedOutput = (isError: boolean, text: string) => isError || FAILED.test(text.replace(ZERO_FAILURES, ''))
const COMMIT = /\bgit commit\b/
// Commands that change state in steps: never end a turn right after one.
const TRANSACTIONAL = /\bgit (rebase|merge|cherry-pick|am|revert|stash pop)\b|\b(migrate|terraform apply|kubectl apply|helm (install|upgrade)|npm publish|docker push)\b/
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// A Bash command that changes files: a redirection into a file, in-place edits, moves, patches, installs. Live check L6
// (2026-10-26): `echo a >> notes.txt` then a passing test was not seen as a change, so no outcome was counted.
const WRITE_CMD = /(^|[^<>&0-9])>{1,2}\s*(?!&|\/dev\/)[\w./~-]|\b(sed|perl)\s+-[a-z]*i|\btee\b|\b(mv|cp|rm|mkdir|touch|ln|truncate|install)\s|\bgit\s+(apply|am|checkout\s+--|restore|mv|rm)\b|\b(npm|pnpm|yarn)\s+(install|add|remove)\b|\bpatch\b/

// fingerprint: a tool call with its volatile parts dropped, so the same call twice has the same key.
export function fingerprint(tool: string, input: Record<string, unknown>): string {
  if (tool === 'Bash') return `Bash:${String(input.command ?? '').replace(/\s+/g, ' ').trim()}`
  if (tool === 'Read') return `Read:${input.file_path}:${input.offset ?? 0}:${input.limit ?? ''}`
  if (tool === 'Grep' || tool === 'Glob') return `${tool}:${input.pattern}:${input.path ?? ''}:${input.glob ?? ''}`
  if (WRITE_TOOLS.has(tool)) return `${tool}:${input.file_path ?? input.notebook_path}:${hash(String(input.new_string ?? input.content ?? JSON.stringify(input.edits ?? '')))}`
  return `${tool}:${hash(JSON.stringify(input))}`
}

export function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16)
}
// A failure's identity: the output with numbers, paths' line numbers, times and hex ids blanked.
export const failureHash = (text: string) => hash(text.replace(/\b0x[0-9a-f]+\b|\b\d+(\.\d+)?(ms|s)?\b/gi, '#').replace(/\s+/g, ' ').trim().slice(-4000))

export interface ToolObservation { tool: string; input: Record<string, unknown>; isError: boolean; text: string }

// observeTool updates the turn with one finished tool call and returns the outcome it produced, if any.
export function observeTool(t: TurnState, o: ToolObservation, weak = true): Outcome | null {
  const fp = fingerprint(o.tool, o.input)
  const command = o.tool === 'Bash' ? String(o.input.command ?? '') : ''
  // A check rerun after a change is the normal loop, not a repeat: only an unchanged rerun counts.
  if (!(command && CHECK.test(command) && t.editsSinceCheck > 0)) t.calls[fp] = (t.calls[fp] ?? 0) + 1
  // Per segment: `printf a >> notes.txt && node --test` writes, then checks (live check L6). A check that only redirects
  // its own output (`npm test > log.txt`) is not a change.
  const bashWrite = !!command && command.split(/&&|\|\||;|\n/).some((seg) => WRITE_CMD.test(seg) && !CHECK.test(seg))
  t.writesInFlight = WRITE_TOOLS.has(o.tool) || TRANSACTIONAL.test(command) || bashWrite
  if (bashWrite && !o.isError) t.editsSinceCheck += 1
  let outcome: Outcome | null = null
  if (WRITE_TOOLS.has(o.tool) && !o.isError) {
    t.editsSinceCheck += 1
    const file = String(o.input.file_path ?? o.input.notebook_path ?? '')
    if (file && !t.newFiles.includes(file)) { if (t.newFiles.length < 500) t.newFiles.push(file); t.filesSinceOutcome += 1 }
    // A weak outcome where no check exists: every third new file changed counts once.
    if (weak && t.filesSinceOutcome >= 3) outcome = 'files-changed'
  }
  if (o.tool === 'ExitPlanMode' && !o.isError) outcome = 'plan-approved'
  if (command && COMMIT.test(command) && !failedOutput(o.isError, o.text)) outcome = 'commit'
  if (command && CHECK.test(command)) {
    const failed = failedOutput(o.isError, o.text)
    if (failed) {
      const h = failureHash(o.text)
      const prev = t.failures[fp]
      // The same failure again counts only when something was changed in between: rerunning without a change is a
      // repeat call, not a failed attempt.
      t.failures[fp] = { hash: h, repeats: prev && prev.hash === h && t.editsSinceCheck > 0 ? prev.repeats + 1 : prev && prev.hash === h ? prev.repeats : 1 }
    } else {
      if (t.editsSinceCheck > 0 || t.failures[fp]) outcome = 'check-passed'
      delete t.failures[fp]
    }
    t.editsSinceCheck = 0
  }
  return outcome
}

export function observeOutcome(t: TurnState, kind: Outcome, at: number) {
  t.outcomes.push({ kind, at, request: t.requests })
  t.sinceOutcome = { requests: 0, usd: 0 }
  t.filesSinceOutcome = 0
  t.noted = 'normal'
}

// observeCost: spend in the turn that is not a main-loop request (subagents, the router's judges). It counts toward the
// marginal cost since the last outcome; it is not a request of this turn.
export function observeCost(t: TurnState, usd: number) {
  t.usd += usd
  t.sinceOutcome.usd += usd
}

export function observeRequest(t: TurnState, usd: number) {
  t.requests += 1
  t.usd += usd
  t.sinceOutcome.requests += 1
  t.sinceOutcome.usd += usd
}

export interface Assessment { level: Level; reasons: string[]; repeats: number; sameFailures: number }

export function assess(t: TurnState, c: GuardianConfig): Assessment {
  const reasons: string[] = []
  const repeats = Object.values(t.calls).filter((n) => n >= c.repeatCalls).length
  const sameFailures = Math.max(0, ...Object.values(t.failures).map((f) => f.repeats))
  const scale = 1 + t.authorized // each authorization widens the gates by one window
  const R = c.warnRequests * scale, U = c.warnUsd * scale
  const s = t.sinceOutcome
  const overBudget = c.turnBudgetUsd !== null && t.usd >= c.turnBudgetUsd * scale
  if (overBudget) reasons.push(`turn budget $${c.turnBudgetUsd} reached`)
  if (sameFailures >= 3) reasons.push(`the same check failed ${sameFailures} times with changes in between`)
  if (s.requests >= R * c.pauseFactor && s.usd >= U * c.pauseFactor) reasons.push(`${s.requests} requests and $${s.usd.toFixed(2)} since the last outcome`)
  if (reasons.length) return { level: 'pause', reasons, repeats, sameFailures }
  if (s.requests >= R && s.usd >= U) reasons.push(`${s.requests} requests and $${s.usd.toFixed(2)} since the last outcome`)
  if (sameFailures >= 2 && s.requests >= R / 2) reasons.push(`the same check failed ${sameFailures} times`)
  if (repeats >= 2 && s.requests >= R / 2) reasons.push(`${repeats} calls repeated ${c.repeatCalls}+ times`)
  if (reasons.length) return { level: 'warning', reasons, repeats, sameFailures }
  if (s.requests >= R / 2 || repeats >= 1) return { level: 'optimize', reasons: [repeats ? 'a call was repeated' : 'long stretch without an outcome'], repeats, sameFailures }
  return { level: 'normal', reasons, repeats, sameFailures }
}

const RANK: Record<Level, number> = { normal: 0, optimize: 1, warning: 2, pause: 3 }
// noteFor: the text the model reads after a tool result when the level rises past what it was told. Once per level
// per outcome window, so a productive stretch is never nagged and a warning is not repeated every call.
export function noteFor(t: TurnState, a: Assessment): string | null {
  if (RANK[a.level] < RANK.warning || RANK[a.level] <= RANK[t.noted]) return null
  t.noted = a.level
  const done = t.outcomes.length ? t.outcomes.map((o) => o.kind).join(', ') : 'no verified outcome yet'
  if (a.level === 'warning') return `AutoMode checkpoint: ${a.reasons.join('; ')}. Outcomes this turn: ${done}. Before the next step, state in one or two lines what is done, what blocks, and whether the current approach is working; change the approach if it is not. A focused check beats a full suite, and a bounded subagent beats more reads in this context.`
  return `AutoMode pause: ${a.reasons.join('; ')}. Outcomes this turn: ${done}. Finish the step in progress so nothing is left half-written, then stop and report: what was accomplished, what remains, why the current approach is not converging, and the next concrete action. Do not start another attempt in this turn. The person can reply "am:continue" to allow more work.`
}

// safeToAbort: a hard pause only between requests, never right after a write or a transactional command.
export const safeToAbort = (t: TurnState) => !t.writesInFlight

// ---------------------------------------------------------------- lifecycle
export type Lifecycle = 'continue' | 'compact' | 'clear'
export interface LifecycleInput {
  family: Family
  contextTokens: number         // the prompt size of the last request
  baseTokens: number            // system prompt and tools: what a fresh session starts with
  staleTokens: number           // conversation from before the current task, above the base (system prompt and tools)
  idleMs: number                // since the last request (0 at a turn end: the next prompt's time is not known yet)
  pCold?: number                // at a turn end, the chance the cache expires before the next prompt
  ttlMs: number
  horizon: number               // requests expected on this route before it is decided again (conservative quantile)
  taskClosed: boolean           // the last task ended on an outcome, with no open failure
  openFailures: number          // failing checks still unresolved: diagnostics a reset would drop
}
export interface LifecycleCosts { continue: number; compact: number; clear: number }
export interface LifecycleDecision { action: Lifecycle; costs: LifecycleCosts; why: string }

// lifecycleCosts prices the three options over the horizon at the running model's rates, cache writes included.
export function lifecycleCosts(i: LifecycleInput, c: GuardianConfig): LifecycleCosts {
  const r = ANTHROPIC.rates[i.family]
  const inp = r.input / 1e6, read = inp * r.cacheReadX, write = inp * cacheWriteX(i.ttlMs)
  const cold = i.idleMs > i.ttlMs
  const keep = (tokens: number, warm: boolean) => (warm ? tokens * read : tokens * write) + Math.max(0, i.horizon - 1) * tokens * read
  // Known cold: the rewrite is certain. At a turn end the next prompt's time is unknown: the rewrite is weighed by pCold.
  const p = cold ? 1 : (i.pCold ?? 0)
  const cont = (1 - p) * keep(i.contextTokens, true) + p * keep(i.contextTokens, false)
  // Compaction reads the context once (written again when cold) and writes a summary; the next session starts from it.
  const summarize = (cold ? i.contextTokens * write : i.contextTokens * read) + c.summaryTokens * r.output / 1e6
  const compacted = i.baseTokens + c.summaryTokens + Math.max(0, i.contextTokens - i.staleTokens - i.baseTokens) * 0.25
  const compact = summarize + keep(compacted, false)
  // Clearing writes the base and the handoff, then the state the next task reads again.
  const fresh = i.baseTokens + c.handoffTokens + c.rebuildTokens
  const clear = keep(fresh, false)
  return { continue: cont, compact, clear }
}

export function lifecycle(i: LifecycleInput, c: GuardianConfig): LifecycleDecision {
  const costs = lifecycleCosts(i, c)
  if (i.contextTokens < c.minContextTokens) return { action: 'continue', costs, why: `context ${Math.round(i.contextTokens / 1000)}k is below ${c.minContextTokens / 1000}k` }
  if (i.openFailures > 0) return { action: 'continue', costs, why: 'open failures: a reset would drop their diagnostics' }
  const beats = (x: number) => x < costs.continue * (1 - c.margin)
  if (i.taskClosed && beats(costs.clear) && costs.clear <= costs.compact) return { action: 'clear', costs, why: 'the task ended on an outcome and a fresh session with a handoff is cheaper' }
  if (beats(costs.compact) && i.staleTokens > c.compactStaleShare * i.contextTokens) return { action: 'compact', costs, why: 'most of the context predates this task and a summary is cheaper' }
  return { action: 'continue', costs, why: 'continuing is the cheapest option' }
}

// shouldOffer: a declined offer is not repeated on every turn end. The same action comes back only when the context has
// grown by a quarter since it was last offered, or the cache is known to be cold. (Session ae9c951f: 18 compaction offers
// in a row would have netted -$1.63 in the replay; most came from one long session at a steady size.)
export function shouldOffer(last: { action: Lifecycle; contextTokens: number } | null, action: Lifecycle, contextTokens: number, knownCold = false): boolean {
  if (action === 'continue') return false
  if (!last || last.action !== action || knownCold) return true
  return contextTokens >= last.contextTokens * 1.25
}

// ---------------------------------------------------------------- output reduction
const KEEP_LINE = /error|fail|exception|traceback|panic|warn|denied|forbidden|fatal|assert|expected|✗|×|\bat .+:\d+/i
export interface Reduced { text: string; reduced: boolean; keptLines: number; droppedLines: number }

// reduceOutput keeps the head, the tail, and every line that reads like a diagnostic with a line around it; the rest
// is dropped with a marker. Under the threshold the text is returned whole.
export function reduceOutput(text: string, aboveChars: number, savedAt: string | null): Reduced {
  if (text.length <= aboveChars) return { text, reduced: false, keptLines: 0, droppedLines: 0 }
  const lines = text.split('\n')
  const keep = new Set<number>()
  for (let i = 0; i < Math.min(40, lines.length); i++) keep.add(i)
  for (let i = Math.max(0, lines.length - 40); i < lines.length; i++) keep.add(i)
  for (let i = 0; i < lines.length; i++) if (KEEP_LINE.test(lines[i])) for (let j = i - 1; j <= i + 1; j++) if (j >= 0 && j < lines.length) keep.add(j)
  const out: string[] = []
  let gap = 0
  for (let i = 0; i < lines.length; i++) {
    if (keep.has(i)) { if (gap) out.push(`… ${gap} lines omitted …`); gap = 0; out.push(lines[i].length > 2000 ? `${lines[i].slice(0, 2000)} …` : lines[i]) } else gap += 1
  }
  if (gap) out.push(`… ${gap} lines omitted …`)
  const note = savedAt ? `[AutoMode shortened this output from ${text.length} characters; every error and warning line is kept. The full output is at ${savedAt}: Read it if you need the rest.]` : `[AutoMode shortened this output from ${text.length} characters; every error and warning line is kept.]`
  const body = out.join('\n')
  // Never return something barely smaller: below a 30% saving the original stays.
  if (body.length > text.length * 0.7) return { text, reduced: false, keptLines: lines.length, droppedLines: 0 }
  return { text: `${note}\n${body}`, reduced: true, keptLines: keep.size, droppedLines: lines.length - keep.size }
}

// Which results may be shortened: command output and list-like MCP results (search, list, query, logs, snapshots),
// where the head, the tail and every diagnostic line carry the answer. Never file reads or edits, and never document
// retrieval (read_document, fetch): any part of a document may be the answer. Live check, 2026-10-26: a docs-server
// read_document shortened from 51,660 to 2,667 characters, and the model named the wrong last sentence; the whole
// result gave the right one. Never a result AutoMode cannot save first.
const DOCUMENT_READ = /^mcp__.*(read_document|fetch|get_document|read_file|get_page)/i
export const reducible = (tool: string) => tool === 'Bash' || (/^mcp__.*(search|snapshot|list|query|logs?)/i.test(tool) && !DOCUMENT_READ.test(tool))

// ---------------------------------------------------------------- checkpoints
export interface Checkpoint {
  v: 1
  sessionId: string
  cwd: string
  at: number
  objective: string
  acceptance: string[]
  stage: string
  status: 'closed' | 'open'
  outcomes: string[]
  filesChanged: string[]
  filesRead: string[]
  checks: { command: string; passed: boolean }[]
  openFailures: string[]
  git: { branch: string | null; dirty: string[] }
  approvals: string[]
  next: string
}

// Secrets never enter a checkpoint: key-like tokens and assignments are blanked.
const SECRET = /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b|((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)\S+/gi
export const scrub = (s: string) => s.replace(SECRET, (m, _k, assign) => (assign ? `${assign}[redacted]` : '[redacted]'))

// Restrictions the person stated in the task ("do not push", "never touch the schema"): kept verbatim, secrets blanked.
const RESTRICTION = /\b(?:do not|don't|never|no need to|without)\b[^.\n]{0,80}?\b(?:commit|push|merge|deploy|delete|remove|modify|change|touch|edit|run|install|publish|rebase)\b[^.\n]{0,60}/gi
export const restrictionsIn = (text: string) => [...new Set((text.match(RESTRICTION) ?? []).map((r) => scrub(r.trim().slice(0, 160))))]

export interface CheckpointInput {
  sessionId: string; cwd: string; at: number; objective: string; closed: boolean
  turn: TurnState; filesRead: string[]; checks: { command: string; passed: boolean }[]
  approvals: string[]; restrictions: string[]; git: { branch: string | null; dirty: string[] }; next: string
}
// buildCheckpoint: the task state, from observed facts only. A failing check stays failing; a check never run is not
// listed as passed; approvals and restrictions carry over whole.
export function buildCheckpoint(i: CheckpointInput): Checkpoint {
  const failing = i.checks.filter((c) => !c.passed).map((c) => c.command)
  const open = Object.keys(i.turn.failures).map((f) => scrub(f.replace(/^Bash:/, '').slice(0, 160)))
  return {
    v: 1, sessionId: i.sessionId, cwd: i.cwd, at: i.at, objective: scrub(i.objective), acceptance: [], stage: i.closed ? 'done' : 'in progress',
    status: i.closed && !open.length && !failing.length ? 'closed' : 'open',
    outcomes: i.turn.outcomes.map((o) => o.kind), filesChanged: [...i.turn.newFiles], filesRead: i.filesRead.slice(-20),
    checks: i.checks.map((c) => ({ command: scrub(c.command), passed: c.passed })),
    openFailures: [...new Set([...open, ...failing.map(scrub)])],
    git: i.git, approvals: [...i.approvals, ...i.restrictions.map((r) => `restriction: ${r}`)], next: scrub(i.next),
  }
}

// verifyRestore: before a handoff is used, the repository must still be where the checkpoint left it: the same branch,
// and the files it left uncommitted still uncommitted. A mismatch means someone changed the tree; the handoff waits.
export function verifyRestore(cp: Checkpoint, now: { branch: string | null; dirty: string[] }): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  if (cp.git.branch !== now.branch) problems.push(`branch is ${now.branch ?? 'none'}, the checkpoint was on ${cp.git.branch ?? 'none'}`)
  const gone = cp.git.dirty.filter((f) => !now.dirty.includes(f))
  if (gone.length) problems.push(`no longer uncommitted: ${gone.slice(0, 5).join(', ')}${gone.length > 5 ? ' …' : ''}`)
  return { ok: problems.length === 0, problems }
}

export function validateCheckpoint(cp: Partial<Checkpoint> | null, now: number, cwd: string, maxAgeMs = 24 * 3_600_000): { ok: boolean; missing: string[] } {
  const missing: string[] = []
  if (!cp) return { ok: false, missing: ['checkpoint'] }
  if (cp.v !== 1) missing.push('version')
  if (!cp.objective?.trim()) missing.push('objective')
  if (!cp.next?.trim()) missing.push('next action')
  if (!cp.git || cp.git.branch === undefined) missing.push('git state')
  if (cp.cwd !== cwd) missing.push('same project')
  if (typeof cp.at !== 'number' || now - cp.at > maxAgeMs) missing.push('fresh (24 h)')
  if (cp.status === 'open' && !cp.filesChanged?.length && !cp.checks?.length && !cp.outcomes?.length) missing.push('work state of an open task')
  return { ok: missing.length === 0, missing }
}

// sealCheckpoint / openCheckpoint: a checkpoint carries a checksum of its own content. A torn or edited file fails the
// check and is not used (the caller falls back to the previous version).
export function sealCheckpoint(cp: Checkpoint): string {
  const { sum: _drop, ...body } = cp as Checkpoint & { sum?: string }
  return JSON.stringify({ ...body, sum: hash(JSON.stringify(body)) })
}
// checkpointSum: the checksum a /clear pointer names. A pointer that names another checkpoint than the one on disk is stale.
export const checkpointSum = (cp: Checkpoint) => hash(JSON.stringify(cp))
export function openCheckpoint(text: string | null | undefined): { cp: Checkpoint | null; problem: string | null } {
  if (!text) return { cp: null, problem: 'missing' }
  let parsed: any
  try { parsed = JSON.parse(text) } catch { return { cp: null, problem: 'unreadable' } }
  if (parsed?.v !== 1) return { cp: null, problem: 'unknown version' }
  const { sum, ...body } = parsed
  if (typeof sum !== 'string' || sum !== hash(JSON.stringify(body))) return { cp: null, problem: 'checksum mismatch' }
  return { cp: body as Checkpoint, problem: null }
}

// reduceMcp: an MCP result in either shape: the protocol's `{ content, isError, structuredContent? }`, or the bare
// array of content blocks that Claude Code hands a tool.call hook (live check, 2026-10-26: a 54,508-character docs-server
// read_document arrived as `[{ type: 'text', text }]`). Only a successful, text-only result with no structured part is
// shortened; image and resource blocks are kept. The result keeps the shape it came in. null: leave the result alone.
export function reduceMcp(result: unknown, aboveChars: number, savedAt: string | null): { result: unknown; from: number; to: number; full: string } | null {
  type Block = { type: string; text?: string }
  const bare = Array.isArray(result)
  const r = (bare ? { content: result } : result) as { content?: Block[]; isError?: boolean; structuredContent?: unknown } | null
  if (!r || !Array.isArray(r.content) || r.isError || r.structuredContent !== undefined) return null
  const texts = r.content.filter((b) => b?.type === 'text' && typeof b.text === 'string')
  const total = texts.reduce((a, b) => a + (b.text as string).length, 0)
  if (total <= aboveChars) return null
  const joined = texts.map((b) => b.text).join('\n')
  const red = reduceOutput(joined, aboveChars, savedAt)
  if (!red.reduced) return null
  const content = [{ type: 'text', text: red.text }, ...r.content.filter((b) => b?.type !== 'text')]
  return { result: bare ? content : { ...r, content }, from: total, to: red.text.length, full: joined }
}

export function handoffText(cp: Checkpoint): string {
  const list = (xs: string[], n = 15) => (xs.length ? xs.slice(0, n).map((x) => `- ${x}`).join('\n') : '- none')
  return scrub([
    `AutoMode handoff from session ${cp.sessionId.slice(0, 8)} (${new Date(cp.at).toISOString()}). The files on disk are the source of truth; this is a map, not a substitute.`,
    `Objective: ${cp.objective}`,
    `Status: ${cp.status === 'closed' ? 'finished' : 'in progress'}; stage: ${cp.stage}`,
    cp.acceptance.length ? `Acceptance:\n${list(cp.acceptance)}` : '',
    `Outcomes: ${cp.outcomes.join(', ') || 'none'}`,
    `Files changed:\n${list(cp.filesChanged)}`,
    `Files read:\n${list(cp.filesRead, 10)}`,
    `Checks:\n${list(cp.checks.map((c) => `${c.passed ? 'pass' : 'FAIL'}: ${c.command}`), 8)}`,
    cp.openFailures.length ? `Open failures:\n${list(cp.openFailures, 5)}` : '',
    `Git: ${cp.git.branch ?? 'no repository'}${cp.git.dirty.length ? `, uncommitted: ${cp.git.dirty.slice(0, 15).join(', ')}` : ', clean'}`,
    cp.approvals.length ? `Earlier approvals and limits (a record only: they grant no permission in this session; Claude Code asks again):\n${list(cp.approvals)}` : '',
    `Next: ${cp.next}`,
  ].filter(Boolean).join('\n'))
}
