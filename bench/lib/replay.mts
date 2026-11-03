// Trace replay: a session's tool calls run back through the ladder's pure code, with no model and no engine. It
// answers "what would the current code have seen and done on this real session?" for free. The preflight runs it on
// every saved session, and the reuse rule (lib/reuse.mts) runs it to prove a row unchanged by a code edit.
//
// What it models: check detection and keys, Bash edits, failure classes, passes, the escalation rule, and a stop with
// the last check failing. What it does not: timing, routing and the model's own choices. A replay that differs from
// a recorded run says the code changed what the run saw; it never says what the model would have done next.
import fs from 'node:fs'
import { EMPTY_LADDER, FULL_SUITE, checkKey, checkPassed, escalation, failureOf, isCheck, writesFiles } from '../../hooks/lib/failures.ts'
import { ladderStep, nextEffort } from '../../hooks/lib/bands.ts'
import type { FailureRecord, LadderState, Effort, Family } from '../../hooks/lib/types.ts'

export interface ToolEvent { tool: string; cmd: string; out: string; err: boolean }

// toolEvents reads a Claude Code session transcript (JSONL) into tool calls with their results, in order.
export function toolEvents(file: string): ToolEvent[] {
  const evs: ToolEvent[] = []
  const pend = new Map<string, { tool: string; cmd: string }>()
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue
    let j: any
    try { j = JSON.parse(l) } catch { continue }
    const c = j.message?.content
    if (!Array.isArray(c)) continue
    for (const x of c) {
      if (x.type === 'tool_use') pend.set(x.id, { tool: x.name, cmd: String(x.input?.command ?? x.input?.file_path ?? '') })
      if (x.type === 'tool_result' && pend.has(x.tool_use_id)) {
        const t = typeof x.content === 'string' ? x.content : (x.content ?? []).map((y: any) => y.text ?? '').join('\n')
        evs.push({ ...pend.get(x.tool_use_id)!, out: t, err: !!x.is_error })
      }
    }
  }
  return evs
}

export interface ReplayStep { i: number; kind: 'pass' | 'fail' | 'stop'; key: string; class?: FailureRecord['class']; edited?: boolean; level: string; because: string; step?: string }
export interface Replay { steps: ReplayStep[]; escalations: number; failures: number; passes: number; bashEdits: number; lastCheckFailed: boolean; fullSuiteFailedAtEnd: boolean }

// replay walks the tool calls through the ladder. `start` is the running route; `stop: true` adds the stop the gate
// would send back when the last check failed. The full suite is the broadest check key seen: a pass of a narrower
// subset never clears it (the sqlglot narrowing incident).
export function replay(events: ToolEvent[], opts: { start?: { family: Family; effort: Effort }; effortFirst?: boolean; stop?: boolean } = {}): Replay {
  let route = opts.start ?? { family: 'sonnet' as Family, effort: 'medium' as Effort }
  let l: LadderState = { ...EMPTY_LADDER }
  const hist: FailureRecord[] = []
  const steps: ReplayStep[] = []
  let edited = false, bashEdits = 0, passes = 0, at = 0
  const status = new Map<string, boolean>()
  const act = (i: number, kind: ReplayStep['kind'], key: string, f?: FailureRecord) => {
    const esc = escalation(hist, { ...l, effortCapped: !nextEffort(route.family, route.effort) })
    const s: ReplayStep = { i, kind, key, ...(f ? { class: f.class, edited: f.editedSince } : {}), level: esc.level, because: esc.because }
    if (esc.level !== 'none') {
      const count = esc.count ?? (esc.fingerprint ? hist.filter((x) => x.fingerprint === esc.fingerprint).length : 0)
      l = { ...l, fired: [...l.fired, esc.key], raised: esc.fingerprint ? { ...l.raised, [esc.fingerprint]: count } : l.raised }
      const step = ladderStep(route, esc.level as 'weak' | 'strong', ['sonnet', 'opus'], { effortFirst: opts.effortFirst ?? true })
      if (step) { s.step = `${step.kind}:${step.family}/${step.effort}`; route = { family: step.family, effort: step.effort } }
    }
    steps.push(s)
  }
  events.forEach((e, i) => {
    at++
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(e.tool)) { edited = true; return }
    if (e.tool !== 'Bash') return
    if (!isCheck(e.cmd)) { if (writesFiles(e.cmd)) { edited = true; bashEdits++ } return }
    if (writesFiles(e.cmd)) { edited = true; bashEdits++ }
    const key = checkKey(e.cmd)
    const ex = e.out.match(/Exit code (\d+)/)
    const exit = ex ? Number(ex[1]) : e.err ? 1 : 0
    if (checkPassed(e.cmd, exit, e.err, e.out)) { passes++; status.set(key, true); l = { ...l, passed: { ...l.passed, [key]: at } }; edited = false; steps.push({ i, kind: 'pass', key, level: 'none', because: '' }); return }
    const f = failureOf(key, exit || 1, e.out.slice(-8000), at, edited)
    edited = false
    status.set(key, false)
    if (!f) return
    hist.push(f)
    act(i, 'fail', key, f)
  })
  // The full suite is the check the task is judged by (FULL_SUITE in hooks/lib/failures.ts).
  const full = [...status.keys()].filter((k) => FULL_SUITE.test(k))
  const fullSuiteFailedAtEnd = full.some((k) => status.get(k) === false)
  const lastCheckFailed = hist.length > 0 && [...status.values()].at(-1) === false
  if (opts.stop && (lastCheckFailed || fullSuiteFailedAtEnd)) { l = { ...l, stops: (l.stops ?? 0) + 1 }; act(events.length, 'stop', 'stop') }
  return { steps, escalations: steps.filter((s) => s.level !== 'none').length, failures: hist.length, passes, bashEdits, lastCheckFailed, fullSuiteFailedAtEnd }
}
