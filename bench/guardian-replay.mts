#!/usr/bin/env node
// @ts-nocheck TODO(types): 6 errors with strict off. Fix them and delete this line to turn checking on for this file.
// Guardian replay on 30 days of recorded turns. $0: no model call. It runs the guardian's own pure code
// (hooks/lib/guardian.ts) over every main-loop turn, in order, with only what was known at each step.
//   --calibrate  measure the gaps between outcomes in productive turns of the Vertex period (before 2026-10-14 15:00 UTC):
//                the p90 of requests and of USD is the warning gate
//   default      apply the gates to every turn of both periods, and the lifecycle check at every turn end
// What it reports, and what it cannot know:
//   progress   - where the first warning and pause fall, the cost after each (exposure, not a saving: the model's answer
//                to a note was never run), and how often a pause hits a turn that went on to an outcome (a false pause)
//   lifecycle  - at each turn end, continue / compact / clear, priced with the next turn's actual requests (hindsight, for
//                evaluation only), and how often a clear comes before a prompt that leaned on the old context
//   output     - the characters the reducer would have removed from large results, and what that context cost after
// Prices: today's models (Opus 5 -> 5.5, Sonnet 4.x -> 5.5), as bench/retro-replay.mts.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseLines, requestsOf, isPersonPrompt, quantile, loadSubagents } from './lib/transcripts.mts'
import { costOf, sum, rateOf, familyOf, workloadOf } from './spend-audit.mts'
import { GUARDIAN_DEFAULTS, shouldOffer, newTurn, observeTool, observeOutcome, observeRequest, observeCost, assess, noteFor, lifecycle, reduceOutput, reducible } from '../hooks/lib/guardian.ts'
import { FOLLOW_UP } from '../hooks/lib/classify.ts'

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const END = Date.now(), START = END - 30 * 86_400_000, SPLIT = Date.parse('2026-10-14T15:00:00Z')
const ROOT = path.join(os.homedir(), '.claude/projects')
const TODAY = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }
const CORRECTION = /\b(wrong|not work|doesn'?t work|didn'?t (work|fix)|still (broken|failing|wrong|not)|broken|revert|undo|makes? (zero|no) sense|you (fucking|idiot)|that'?s not|stop)\b/i
const LEANS_ON_CONTEXT = /\b(it|this|that|these|those|above|again|same|continue|also|now|then|the (fix|change|bug|test|plan|file|error))\b/i
const cfg = { ...GUARDIAN_DEFAULTS, mode: 'on', warnRequests: Number(opt('--warn-requests', GUARDIAN_DEFAULTS.warnRequests)), warnUsd: Number(opt('--warn-usd', GUARDIAN_DEFAULTS.warnUsd)) }
const usdToday = (q) => { const f = familyOf(q.model); return sum(costOf(q.tokens, TODAY[f] ?? q.model)) }
const usdEra = (q) => sum(costOf(q.tokens, q.model))
const promptOf = (t) => t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h

// One session, in line order: turns with their requests and finished tool calls.
function turnsOf(L) {
  const reqs = requestsOf(L)
  const calls = new Map() // tool_use id -> { tool, input, requestId }
  const turns = []
  let turn = null
  const seen = new Set()
  for (const r of L) {
    if (isPersonPrompt(r)) {
      const text = typeof r.message.content === 'string' ? r.message.content : r.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      turn = { text, at: Date.parse(r.timestamp), events: [] }
      turns.push(turn)
      continue
    }
    if (!turn) continue
    if (r.type === 'assistant' && r.requestId && !r.isSidechain) {
      if (Array.isArray(r.message?.content)) for (const b of r.message.content) if (b?.type === 'tool_use') calls.set(b.id, { tool: b.name, input: b.input ?? {} })
      if (!seen.has(r.requestId) && reqs.has(r.requestId)) { seen.add(r.requestId); turn.events.push({ kind: 'request', q: reqs.get(r.requestId) }) }
    }
    if (r.type === 'user' && !r.isSidechain && Array.isArray(r.message?.content)) for (const b of r.message.content) {
      if (b?.type !== 'tool_result' || !calls.has(b.tool_use_id)) continue
      const c = b.content, text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x?.type === 'text' ? x.text : '')).join('') : ''
      turn.events.push({ kind: 'tool', ...calls.get(b.tool_use_id), isError: !!b.is_error, text })
    }
  }
  return turns
}

// classifyTurn: what a long turn was, from its recorded behavior (hindsight, for the report only). First match wins.
export function classifyTurn(x) {
  if (x.sameFailures >= 3 || (x.corrected && x.outcomes <= 2)) return 'looping'
  if (x.maxRepeat >= 5) return 'inefficient strategy'
  if (x.outcomes >= Math.max(2, x.requests / 40) && !x.corrected) return x.maxCtx > 300_000 && x.readShare > 0.8 ? 'useful, context-heavy' : 'useful'
  if (x.maxCtx > 300_000 && x.readShare > 0.8) return 'redundant context'
  return 'unclear'
}

function replay(file, project, workload) {
  const turns = turnsOf(parseLines(file))
  // Subagent requests are attributed to the turn whose time window holds them; the runtime sees them in the session's
  // cost total, so the replay counts them toward the turn's marginal cost too.
  const subs = loadSubagents(file).filter((q) => q.at >= START && rateOf(q.model)).sort((a, b) => a.at - b.at)
  let si = 0
  const out = { turns: [], gaps: [], lifecycle: [], reduce: { results: 0, chars: 0, usd: 0 } }
  let lastReq = null
  let lastOffer = null
  for (let ti = 0; ti < turns.length; ti++) {
    const turn = turns[ti], nextText = turns[ti + 1]?.text ?? null
    const reqs = turn.events.filter((e) => e.kind === 'request' && e.q.at >= START && rateOf(e.q.model))
    if (!reqs.length) continue
    const t = newTurn(String(ti), turn.at, /\bam:continue\b/i.test(turn.text) ? 1 : 0)
    const nextAt = turns[ti + 1]?.at ?? Infinity
    let era = 0, subToday = 0, subEra = 0, reads = 0, prompt = 0, maxCtx = 0
    const notesAt = []
    const cmds = {}
    let first = { warning: null, pause: null }, usdAt = { warning: 0, pause: 0 }, lastOutcomeReq = 0, lastOutcomeUsd = 0
    let reducedPending = [] // { chars, from request index }
    for (const e of turn.events) {
      if (e.kind === 'request') {
        if (e.q.at < START || !rateOf(e.q.model)) continue
        while (si < subs.length && subs[si].at <= e.q.at) { const q = subs[si++]; if (q.at >= turn.at && q.at < nextAt) { const u = usdToday(q); subToday += u; subEra += usdEra(q); observeCost(t, u) } }
        const usd = usdToday(e.q)
        observeRequest(t, usd)
        era += usdEra(e.q)
        const c = costOf(e.q.tokens, TODAY[familyOf(e.q.model)] ?? e.q.model); reads += c.read; prompt += sum(c) - c.output
        maxCtx = Math.max(maxCtx, promptOf(e.q.tokens))
        // Output reduction: the dropped characters stay in context for every later request of the session until compaction;
        // here they are priced to the end of the turn only (a conservative bound).
        for (const p of reducedPending) out.reduce.usd += (p.chars / 3.5) * (rateOf(TODAY[familyOf(e.q.model)]).input * rateOf(TODAY[familyOf(e.q.model)]).readX) / 1e6
        lastReq = e.q
      } else {
        if (e.tool === 'Bash') { const k = String(e.input.command ?? '').trim(); cmds[k] = (cmds[k] ?? 0) + 1 }
        const outcome = observeTool(t, { tool: e.tool, input: e.input, isError: e.isError, text: e.text }, !args.includes('--strict'))
        if (outcome) { out.gaps.push({ requests: t.sinceOutcome.requests, usd: t.sinceOutcome.usd, train: turn.at < SPLIT }); observeOutcome(t, outcome, e.at ?? 0); lastOutcomeReq = t.requests; lastOutcomeUsd = t.usd }
        if (reducible(e.tool) && e.text.length > cfg.reduceAboveChars) {
          const r = reduceOutput(e.text, cfg.reduceAboveChars, '/data/outputs/x.txt')
          if (r.reduced) { out.reduce.results += 1; out.reduce.chars += e.text.length - r.text.length; reducedPending.push({ chars: e.text.length - r.text.length }) }
        }
        const a = assess(t, cfg)
        const note = noteFor(t, a)
        if (note) notesAt.push({ at: t.requests, tokens: Math.ceil(note.length / 3.5) })
        if (note && a.level === 'warning' && first.warning === null) { first.warning = t.requests; usdAt.warning = t.usd }
        if (note && a.level === 'pause' && first.pause === null) { first.pause = t.requests; usdAt.pause = t.usd }
      }
    }
    while (si < subs.length && subs[si].at < nextAt) { const q = subs[si++]; if (q.at >= turn.at) { subToday += usdToday(q); subEra += usdEra(q) } }
    const corrected = !!nextText && CORRECTION.test(nextText.slice(0, 400))
    const endedOnOutcome = t.outcomes.length > 0 && lastOutcomeReq >= t.requests - 5
    // A pause is false when the turn went on to an outcome after it and the next prompt was not a correction.
    const outcomeAfterPause = first.pause !== null && t.outcomes.some((o) => o.request > first.pause)
    out.turns.push({ project, workload, at: turn.at, train: turn.at < SPLIT, requests: t.requests, usd: t.usd, outcomes: t.outcomes.length, corrected, endedOnOutcome,
      warnAt: first.warning, pauseAt: first.pause, afterWarnUsd: first.warning === null ? 0 : t.usd - usdAt.warning, afterPauseUsd: first.pause === null ? 0 : t.usd - usdAt.pause,
      falsePause: first.pause !== null && outcomeAfterPause && !corrected, afterLastOutcomeUsd: t.usd - lastOutcomeUsd, prompt: turn.text.replace(/\s+/g, ' ').slice(0, 70),
      usdEra: era + subEra, subToday, subEra, readShare: prompt ? reads / (prompt + 1e-9) : 0, maxCtx, notification: /^\s*<task-notification>/.test(turn.text),
      maxRepeat: Math.max(0, ...Object.values(cmds)), sameFailures: Math.max(0, ...Object.values(t.failures).map((f) => f.repeats)),
      // The guardian's own cost: each note is written once and read on every later request of the turn (Opus 5.5 prices).
      noteOverhead: notesAt.reduce((a, n) => a + n.tokens * (4 * 2 + Math.max(0, t.requests - n.at - 1) * 4 * 0.05) / 1e6, 0), notes: notesAt.length,
      kind: classifyTurn({ requests: t.requests, outcomes: t.outcomes.length, corrected, sameFailures: Math.max(0, ...Object.values(t.failures).map((f) => f.repeats)), maxRepeat: Math.max(0, ...Object.values(cmds)), maxCtx, readShare: prompt ? reads / prompt : 0 }) })
    // Lifecycle at the end of this turn, priced with the next turn's actual requests.
    const nxt = turns[ti + 1]
    const nreqs = nxt ? nxt.events.filter((e) => e.kind === 'request' && e.q.at >= START && rateOf(e.q.model)).map((e) => e.q) : []
    if (lastReq && nreqs.length) {
      const fam = familyOf(lastReq.model)
      const ctx = promptOf(lastReq.tokens)
      const base = Math.min(...turns.slice(0, ti + 1).flatMap((x) => x.events.filter((e) => e.kind === 'request').map((e) => promptOf(e.q.tokens))).filter((n) => n > 5000), 40_000)
      const startCtx = promptOf(reqs[0].q.tokens)
      const d = lifecycle({ family: fam === 'other' ? 'opus' : fam, contextTokens: ctx, baseTokens: base, staleTokens: Math.max(0, startCtx - base), idleMs: 0, pCold: cfg.coldReturnRate, ttlMs: 3_600_000, horizon: cfg.horizon, taskClosed: endedOnOutcome && !corrected, openFailures: Object.keys(t.failures).length }, cfg)
      const offered = shouldOffer(lastOffer, d.action, ctx)
      if (offered) lastOffer = { action: d.action, contextTokens: ctx }
      if (d.action !== 'continue' && offered) {
        // Hindsight price of the next turn: actual, against the same requests on a context reduced to the fresh size plus
        // the next turn's own growth. The rebuild tokens are written once. The reset's own cost is included.
        const r = rateOf(TODAY[fam] ?? lastReq.model), inp = r.input / 1e6
        // Both resets drop state the next turn may read again: the rebuild is charged to compaction as well as to clearing.
        const fresh = d.action === 'clear' ? base + cfg.handoffTokens + cfg.rebuildTokens : base + cfg.summaryTokens + cfg.rebuildTokens
        const actual = nreqs.reduce((a, q) => a + usdToday(q), 0)
        let alt = d.action === 'compact' ? ctx * inp * r.readX + cfg.summaryTokens * r.output / 1e6 : 0
        nreqs.forEach((q, j) => {
          const growth = Math.max(0, promptOf(q.tokens) - promptOf(nreqs[0].tokens))
          const p = fresh + growth
          alt += (j === 0 ? p * inp * 2 : p * inp * r.readX) + q.tokens.output * r.output / 1e6
        })
        const leans = !!nxt.text && (FOLLOW_UP.test(nxt.text.trim()) || CORRECTION.test(nxt.text) || (nxt.text.length < 120 && LEANS_ON_CONTEXT.test(nxt.text)))
        out.lifecycle.push({ session: path.basename(file).slice(0, 8), project, action: d.action, ctx, actual, alt, saving: actual - alt, leansOnContext: leans, idleMin: Math.round((nreqs[0].at - lastReq.at) / 60000), why: d.why })
      }
    }
  }
  return out
}

const all = { turns: [], gaps: [], lifecycle: [], reduce: { results: 0, chars: 0, usd: 0 } }
for (const project of fs.readdirSync(ROOT)) {
  const workload = workloadOf(ROOT, project)
  if (workload !== 'engineering' && !(args.includes('--all-workloads') && workload === 'automode-dev')) continue
  for (const f of fs.readdirSync(path.join(ROOT, project)).filter((f) => f.endsWith('.jsonl'))) {
    const file = path.join(ROOT, project, f)
    if (fs.statSync(file).mtimeMs < START) continue
    const r = replay(file, project.replace(/^-Users-[^-]+-/, ''), workload)
    all.turns.push(...r.turns.map((t) => ({ ...t, session: f.slice(0, 8) }))); all.gaps.push(...r.gaps); all.lifecycle.push(...r.lifecycle)
    for (const k of ['results', 'chars', 'usd']) all.reduce[k] += r.reduce[k]
  }
}
const r2 = (x) => Math.round(x * 100) / 100
const s = (xs, f) => xs.reduce((a, x) => a + f(x), 0)
if (args.includes('--calibrate')) {
  const g = all.gaps.filter((x) => x.train)
  console.log(JSON.stringify({ gaps: g.length, requests: { p50: quantile(g.map((x) => x.requests), 0.5), p90: quantile(g.map((x) => x.requests), 0.9), p95: quantile(g.map((x) => x.requests), 0.95) }, usd: { p50: r2(quantile(g.map((x) => x.usd), 0.5)), p90: r2(quantile(g.map((x) => x.usd), 0.9)), p95: r2(quantile(g.map((x) => x.usd), 0.95)) } }))
  const test = all.gaps.filter((x) => !x.train)
  console.log('held-out', JSON.stringify({ gaps: test.length, requests: { p90: quantile(test.map((x) => x.requests), 0.9) }, usd: { p90: r2(quantile(test.map((x) => x.usd), 0.9)) } }))
  process.exit(0)
}
const T = all.turns
const long = T.filter((t) => t.requests > 100)
const summary = (xs) => ({
  turns: xs.length, usd: r2(s(xs, (t) => t.usd)),
  warned: xs.filter((t) => t.warnAt !== null).length, paused: xs.filter((t) => t.pauseAt !== null).length,
  usdAfterWarning: r2(s(xs, (t) => t.afterWarnUsd)), usdAfterPause: r2(s(xs, (t) => t.afterPauseUsd)),
  falsePauses: xs.filter((t) => t.falsePause).length,
  pausedProductive: xs.filter((t) => t.pauseAt !== null && t.endedOnOutcome && !t.corrected).length,
  warnedShortTurns: xs.filter((t) => t.warnAt !== null && t.requests <= 30).length,
  notes: s(xs, (t) => t.notes), noteOverheadUsd: Math.round(s(xs, (t) => t.noteOverhead) * 10000) / 10000,
})
const lc = (xs) => ({ n: xs.length, saving: r2(s(xs, (x) => x.saving)), positive: xs.filter((x) => x.saving > 0).length, leansOnContext: xs.filter((x) => x.leansOnContext).length, savingWhenNotLeaning: r2(s(xs.filter((x) => !x.leansOnContext), (x) => x.saving)) })
const out = {
  gates: { warnRequests: cfg.warnRequests, warnUsd: cfg.warnUsd, pauseFactor: cfg.pauseFactor },
  engineering: summary(T), vertex: summary(T.filter((t) => t.train)), firstParty: summary(T.filter((t) => !t.train)), longTurns: summary(long),
  reconcile: { longTurns: long.length, usdToday: r2(s(long, (t) => t.usd)), usdEraMain: r2(s(long, (t) => t.usdEra - t.subEra)), usdEraWithSubagents: r2(s(long, (t) => t.usdEra)), subToday: r2(s(long, (t) => t.subToday)) },
  longKinds: Object.fromEntries(['useful', 'useful, context-heavy', 'redundant context', 'inefficient strategy', 'looping', 'unclear'].map((k) => [k, { turns: long.filter((t) => t.kind === k).length, usd: r2(s(long.filter((t) => t.kind === k), (t) => t.usd)) }])),
  notificationTurns: { long: long.filter((t) => t.notification).length, usd: r2(s(long.filter((t) => t.notification), (t) => t.usd)) },
  topLong: [...long].sort((a, b) => b.usd - a.usd).slice(0, 45).map((t) => ({ project: t.project, session: t.session, requests: t.requests, usd: r2(t.usd), usdEra: r2(t.usdEra), kind: t.kind, notification: t.notification, maxRepeat: t.maxRepeat, maxCtx: t.maxCtx, outcomes: t.outcomes, warnAt: t.warnAt, pauseAt: t.pauseAt, afterPause: r2(t.afterPauseUsd), falsePause: t.falsePause, corrected: t.corrected, prompt: t.prompt })),
  lifecycle: { clear: lc(all.lifecycle.filter((x) => x.action === 'clear')), compact: lc(all.lifecycle.filter((x) => x.action === 'compact')) },
  outputReduction: { results: all.reduce.results, charsRemoved: all.reduce.chars, usdWithinTurn: r2(all.reduce.usd) },
}
if (opt('--out')) fs.writeFileSync(opt('--out'), JSON.stringify({ ...out, lifecycleRows: all.lifecycle }, null, 2))
console.log(JSON.stringify(out, null, 1))
