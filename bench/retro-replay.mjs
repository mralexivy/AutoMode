#!/usr/bin/env node
// Retrospective replay: what today's AutoMode Auto would have done on every recorded turn of the last N days,
// including plain Opus and Vertex-era sessions. $0: no model call; the real policy code decides.
//
// What runs as shipped: optimizeAuto (eligibility, cheapest eligible pair), switchCheck (cache economics,
// dwell, payback; remaining work from the REMAINING table, never from the future of the session), subagentRoute,
// the Haiku context guard, and escalation after repeated test failures.
// What cannot run: the two judges (paid Haiku calls). Their verdicts are supplied by a named regime:
//   fail     - both judges fail: Auto keeps the running model (fallbackModel). The floor.
//   oracle   - each segment's verdict is the class of the work it actually turned out to be (edits, failing test
//              runs, a correction in the next prompt). Uses hindsight; it is the best a correct judge could do.
//   cautious - oracle, but substantial work stays on Opus; only lookups, exploration and routine changes move.
// Pricing: `today` normalizes every request to today's models and the first-party 1h main-thread cache;
// `era` prices each request on the provider and models of its own date (Vertex: Opus 5, Sonnet 4.6, 5m cache).
// Every saving here is a fixed-trajectory estimate: the same requests and tokens on another route. A cheaper
// model's own trajectory is unknown; `--sensitivity` shows how much longer it may run before the saving is gone.
//
// Usage: node bench/retro-replay.mjs [--days 30] [--out FILE]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseLines, requestsOf, isPersonPrompt, loadSubagents, readRecords } from './lib/transcripts.mjs'
import { costOf, sum, rateOf, familyOf, workloadOf } from './spend-audit.mjs'
import { optimizeAuto, fallbackModel, escalationTarget } from '../hooks/lib/auto.ts'
import { switchCheck, DEFAULT_PARAMS } from '../hooks/lib/policy.ts'
import { DEFAULT_PRIORS } from '../hooks/lib/optimizer.ts'
import { subagentRoute } from '../hooks/lib/subagents.ts'
import { ANTHROPIC } from '../hooks/lib/prices.ts'

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const END = Date.now(), START = END - Number(opt('--days', 30)) * 86_400_000
const PAYBACK = Number(opt('--payback', DEFAULT_PARAMS.paybackFactor))
const QUANTILE = opt('--quantile', 'p25')
// --horizon: price a switch's payback over the requests left on the route (until the session ends or the cache goes
// cold), not over the requests left in the prompt. Calibrated on the Vertex-era engineering sessions only
// (before 2026-10-14 15:00 UTC), so the first-party period is out of sample.
const ROUTE_HORIZON = [
  { k: 0, n: 485, p25: 11, median: 46, p75: 131 }, { k: 1, n: 408, p25: 14, median: 56, p75: 150 }, { k: 2, n: 693, p25: 17, median: 63, p75: 156 },
  { k: 4, n: 1102, p25: 24, median: 73, p75: 171 }, { k: 8, n: 1604, p25: 35, median: 86, p75: 181 }, { k: 16, n: 2291, p25: 39, median: 99, p75: 194 },
  { k: 32, n: 7053, p25: 42, median: 97, p75: 194 },
]
const HORIZON = args.includes('--horizon') ? ROUTE_HORIZON : undefined
const ROOTS = [path.join(os.homedir(), '.claude/projects'), path.join(os.homedir(), '.claude-ectest/projects')]
const DATA = path.join(os.homedir(), '.claude/plugins/data/automode')

const TEST = /\b(go test|npm (run )?(test|build)|node --test|pytest|jest|vitest|make (test|check|build)|claude plugin test|tsc( |$)|cargo test|xcodebuild)\b/
const FAIL = /\b(FAIL(ED)?|error TS\d+|Error:|failed|panic:|Traceback|exit code [1-9])/i
const CORRECTION = /\b(wrong|not work|doesn'?t work|didn'?t (work|fix)|still (broken|failing|wrong|not)|broken|revert|undo|makes? (zero|no) sense|you (fucking|idiot)|that'?s not|stop)\b/i
const HAIKU_LIMIT = DEFAULT_PARAMS.haikuMaxContext - 4_000 // the router's first-prefix headroom
const TODAY = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }
const VERTEX_ERA = { opus: 'claude-opus-5', sonnet: 'claude-sonnet-4-6', haiku: 'claude-haiku-4-5' }
// The era price row for switchCheck on Vertex (list prices; Vertex's own rates were not readable here).
const VERTEX_ROW = { provider: 'vertex', source: 'list prices of the Vertex-era models (assumed equal on Vertex)', checkedAt: '2026-10-26', rates: { opus: { input: 5, output: 25, cacheReadX: 0.1 }, sonnet: { input: 3, output: 15, cacheReadX: 0.1 }, haiku: { input: 1, output: 5, cacheReadX: 0.1 } } }

const promptOf = (q) => q.tokens.input + q.tokens.cacheRead + q.tokens.cacheWrite5m + q.tokens.cacheWrite1h

// ---------------------------------------------------------------- reading one session into turns and steps
export function turnsOf(L) {
  const reqs = requestsOf(L)
  const toolsOf = new Map() // requestId -> tool uses
  const resultOf = new Map() // tool_use id -> { error, text }
  for (const r of L) {
    if (r.type === 'assistant' && r.requestId && Array.isArray(r.message?.content)) {
      const list = toolsOf.get(r.requestId) ?? []
      for (const b of r.message.content) if (b?.type === 'tool_use') list.push({ id: b.id, name: b.name, input: b.input ?? {} })
      toolsOf.set(r.requestId, list)
    }
    if (r.type === 'user' && Array.isArray(r.message?.content)) for (const b of r.message.content) if (b?.type === 'tool_result') {
      const c = b.content, text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text ?? '').join('') : ''
      resultOf.set(b.tool_use_id, { error: !!b.is_error, text: text.slice(-4000) })
    }
  }
  const turns = []
  let turn = { text: null, at: null, plan: false, steps: [] }
  let plan = false
  const seen = new Set()
  for (const r of L) {
    if (r.type === 'user' && r.permissionMode) plan = r.permissionMode === 'plan'
    if (isPersonPrompt(r)) {
      if (turn.steps.length || turn.text !== null) turns.push(turn)
      const text = typeof r.message.content === 'string' ? r.message.content : r.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      turn = { text, at: Date.parse(r.timestamp), plan, steps: [] }
      continue
    }
    if (r.type !== 'assistant' || !r.requestId || r.isSidechain || seen.has(r.requestId) || !reqs.has(r.requestId)) continue
    seen.add(r.requestId)
    const q = reqs.get(r.requestId)
    const tools = toolsOf.get(r.requestId) ?? []
    const step = { at: q.at, model: q.model, effort: q.appEffort, tokens: q.tokens, incomplete: q.incomplete, vertex: String(r.message?.id ?? '').startsWith('msg_vrtx'), edits: [], tests: 0, failed: 0, planExit: false, spawns: 0 }
    for (const t of tools) {
      if (t.name === 'Edit' || t.name === 'Write' || t.name === 'MultiEdit' || t.name === 'NotebookEdit') {
        const lines = String(t.input.new_string ?? t.input.content ?? (t.input.edits ?? []).map((e) => e.new_string).join('\n') ?? '').split('\n').length
        step.edits.push({ file: String(t.input.file_path ?? t.input.notebook_path ?? '?'), lines })
      }
      if (t.name === 'Bash' && TEST.test(String(t.input.command ?? ''))) { step.tests += 1; const res = resultOf.get(t.id); if (res && (res.error || FAIL.test(res.text))) step.failed += 1 }
      // The transcript records permissionMode only when it changes into plan mode; an approved ExitPlanMode ends it.
      if (t.name === 'ExitPlanMode') { step.planExit = true; if (!resultOf.get(t.id)?.error) plan = false }
      if (t.name === 'EnterPlanMode') plan = true
      if (t.name === 'Agent' || t.name === 'Task') step.spawns += 1
    }
    turn.steps.push(step)
  }
  if (turn.steps.length || turn.text !== null) turns.push(turn)
  for (let i = 0; i < turns.length; i++) turns[i].corrected = !!turns[i + 1]?.text && CORRECTION.test(turns[i + 1].text.slice(0, 400))
  return turns
}

// classOf: the work a segment turned out to be. Hindsight; used only by the oracle and cautious regimes.
export function classOf(steps, { plan = false, corrected = false } = {}) {
  if (plan) return 'plan'
  const files = new Set(steps.flatMap((s) => s.edits.map((e) => e.file)))
  const lines = steps.reduce((a, s) => a + s.edits.reduce((b, e) => b + e.lines, 0), 0)
  const failed = steps.reduce((a, s) => a + s.failed, 0)
  if (!files.size) return steps.length <= 3 ? 'lookup' : 'explore'
  if (failed >= 3 || corrected) return 'hard'
  if (files.size > 3 || lines > 150 || failed === 2 || steps.length > 16) return 'substantial'
  return 'routine'
}

// The verdicts a judge pair gives for a class under a regime: [automode tier, effortless model, effortless effort].
const VERDICT = {
  oracle: { lookup: ['T0', 'haiku', 'low'], explore: ['T1', 'sonnet', 'medium'], routine: ['T1', 'sonnet', 'medium'], substantial: ['T3', 'sonnet', 'high'], hard: ['T3', 'opus', 'high'], plan: ['T3', 'opus', 'high'] },
  cautious: { lookup: ['T0', 'haiku', 'low'], explore: ['T1', 'sonnet', 'medium'], routine: ['T1', 'sonnet', 'medium'], substantial: ['T3', 'opus', 'high'], hard: ['T3', 'opus', 'high'], plan: ['T3', 'opus', 'high'] },
}
const CX = { T0: 'trivial', T1: 'standard', T3: 'complex' }

// measured: the real judges' answers about the real prompt (bench/retro-judge.mjs, cached in results/retro-verdicts.json),
// through the router's own code: a short follow-up keeps the route; a failed anchor call goes to fallbackModel (the
// AutoMode judge decides the model, confidence floor 0.3); otherwise optimizeAuto on the verdicts. A point that was never
// judged keeps the running route, as a failed judge would.
let MEASURED = null
const measuredVerdicts = () => (MEASURED ??= (() => { try { return JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'results', 'retro-verdicts.json'), 'utf8')) } catch { return {} } })())
function decideMeasured(key, running, prefix) {
  const v = measuredVerdicts()[key]
  if (!v || v.error) return { family: running.family, effort: running.effort, why: 'not judged: the running route', calls: 0 }
  if (v.shortcut) return { family: running.family, effort: running.effort, why: 'short follow-up: the route stays', calls: 0 }
  const allowed = ['sonnet', 'opus', ...(prefix <= HAIKU_LIMIT ? ['haiku'] : [])]
  const hm = v.hm ? { tier: v.hm.tier, complexity: v.hm.complexity } : null
  if (!v.verdicts[v.anchor]) {
    const fm = fallbackModel(v.anchor, v.hm ? { tier: v.hm.tier, effort: v.hm.effort, confidence: v.hm.confidence } : null, allowed, undefined, 0.3)
    return { family: fm.family, effort: fm.effort ?? running.effort, why: `effortless failed: ${fm.why}`, calls: v.calls }
  }
  const verdicts = Object.fromEntries(Object.entries(v.verdicts).filter(([, x]) => x).map(([f, x]) => [f, { ...x, why: 'judge' }]))
  const best = optimizeAuto({ allowed, verdicts, hm, floors: { because: [] }, current: running, cost: (f, e) => { const r = ANTHROPIC.rates[f]; return (prefix * r.input * r.cacheReadX + 600 * r.output) / 1e6 } }).best
  return { family: best.family, effort: best.effort, why: `judges: ${Object.entries(v.verdicts).map(([f, x]) => `${f}:${x ? `${x.model}/${x.effort}` : '-'}`).join(' ')} hm:${v.hm?.tier ?? '-'}`, calls: v.calls }
}

export function decide(regime, cls, running, prefix) {
  if (regime === 'fail') return { family: running.family, effort: running.effort, why: 'judges failed: the running model' }
  const [tier, model, effort] = VERDICT[regime][cls]
  const v = { model, effort, why: cls }
  const allowed = ['sonnet', 'opus', ...(prefix <= HAIKU_LIMIT ? ['haiku'] : [])]
  // The effortless judge is asked about the running model and, when it could win, one more; a correct judge
  // gives the same answer about each, so every family gets the class verdict.
  const best = optimizeAuto({ allowed, verdicts: { haiku: v, sonnet: v, opus: v }, hm: { tier, complexity: CX[tier] }, floors: { because: [] }, current: running, cost: (f, e) => { const r = ANTHROPIC.rates[f]; return (prefix * r.input * r.cacheReadX + 600 * r.output) / 1e6 } }).best
  return { family: best.family, effort: best.effort, why: `${cls}: ${best.why.at(-1) ?? ''}` }
}

const STRENGTH = { haiku: 0, sonnet: 1, opus: 2 }
const route = (family, effort, model) => ({ tier: family === 'opus' ? 'T3' : family === 'sonnet' ? 'T1' : 'T0', family, model, effort })

// ---------------------------------------------------------------- pricing one request on a route
// today: main-thread writes are 1h (first-party since 2026-10-14); a Vertex-era expiry rewrite after an idle gap
// of 5-60 minutes is a cache read under 1h. Applied the same to baseline and Auto, so only routing differs.
function normalize(step, prevAt, scenario) {
  const t = { ...step.tokens }
  if (scenario !== 'today') return t
  const w5 = t.cacheWrite5m
  if (step.vertex && prevAt !== null && step.at - prevAt > 300_000 && step.at - prevAt <= 3_600_000 && w5 > 20_000) { t.cacheRead += w5; t.cacheWrite5m = 0; return t }
  t.cacheWrite1h += t.cacheWrite5m; t.cacheWrite5m = 0
  return t
}
const modelFor = (family, step, scenario) => (scenario === 'today' || !step.vertex ? TODAY : VERTEX_ERA)[family]
const usdOn = (t, model) => sum(costOf(t, model))

// ---------------------------------------------------------------- one session
export function replaySession(L, regime, scenario, start = START, end = END, file = '') {
  const base = path.basename(file, '.jsonl')
  const turns = turnsOf(L)
  let sim = null // { family, effort } Auto's running route
  let cache = { prefix: 0, at: null }
  let since = { requests: 0, verified: false, switches: 0 }
  let prevAt = null
  // Each model's own cache: when it last ran and how long its prefix was. Anthropic caches a prefix per model, so going
  // back to a model inside its TTL reads the old prefix and writes only what was added since (router: targetWarm).
  const warm = {}
  const out = { base: 0, auto: 0, switchUsd: 0, downAuto: 0, held: [], perStep: [], effortDelta: 0, longTurns: [], decisions: [], steps: 0, replayable: 0, replayableBase: 0, unknownBase: 0, byClass: {}, judgeCalls: 0 }
  for (const turn of turns) {
    const live = turn.steps.filter((s) => s.at >= start && s.at < end && rateOf(s.model))
    if (!live.length) { for (const s of turn.steps) prevAt = s.at; continue }
    let turnBase = 0, turnAuto = 0
    const replayable = turn.text !== null && live.every((s) => !s.incomplete || s === live.at(-1))
    // Segments: a plan-mode turn splits at ExitPlanMode into planning and the work after approval.
    const exit = turn.steps.findIndex((s) => s.planExit)
    const segments = turn.plan && exit >= 0 && exit < turn.steps.length - 1 ? [turn.steps.slice(0, exit + 1), turn.steps.slice(exit + 1)] : [turn.steps]
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si]
      const cls = classOf(seg, { plan: turn.plan && si === 0 && segments.length > 1 ? true : turn.plan && segments.length === 1, corrected: turn.corrected })
      out.byClass[cls] ??= { base: 0, auto: 0, n: 0 }
      out.byClass[cls].n += 1
      let failures = 0
      for (let k = 0; k < seg.length; k++) {
        const s = seg[k]
        const inWin = s.at >= start && s.at < end && rateOf(s.model)
        const actual = { family: familyOf(s.model), effort: s.effort ?? 'medium' }
        if (!sim || regime === 'fail') sim = actual // judges failed: Auto keeps whatever the app runs
        // Decision points: the segment's first request (a new prompt or the plan exit), and an escalation.
        let target = null, why = null, mandatory = false
        if (k === 0 && replayable) { const d = regime === 'measured' ? decideMeasured(si === 0 ? `${base}|${turn.at}` : `${base}|${s.at}|exit`, sim, cache.prefix || promptOf(s)) : decide(regime, cls, sim, cache.prefix || promptOf(s)); target = d; why = d.why; out.judgeCalls += regime === 'fail' ? 0 : regime === 'measured' ? d.calls : 2 }
        // Escalation as the router does it (auto.ts escalationTarget): one band up toward the T3 floor, the running model first.
        // Before 2026-10-26 this replay jumped straight to Opus high, which overstated the cost of hard work.
        if (k > 0 && failures >= 2 && regime !== 'fail') { const up = escalationTarget(sim, 'T3', ['sonnet', 'opus']); if (up.family !== sim.family || up.effort !== sim.effort) { target = { family: up.family, effort: up.effort }; why = 'escalation: repeated failing checks, one band up'; mandatory = true }; failures = -99 }
        if (!replayable) target = { family: actual.family, effort: actual.effort } // unknown turn: no change
        let switched = false
        if (target && target.family !== sim.family) {
          const prices = scenario === 'era' && s.vertex ? VERTEX_ROW : ANTHROPIC
          const ttl = scenario === 'today' || !s.vertex ? 3_600_000 : 300_000
          const up = target.family === 'opus' || (target.family === 'sonnet' && sim.family === 'haiku')
          const check = switchCheck({
            current: route(sim.family, sim.effort, TODAY[sim.family]), target: route(target.family, target.effort, TODAY[target.family]),
            candidate: { tier: up ? 'T3' : 'T1', source: 'judge', confidence: 0.9, reason: why }, floor: { tier: 'T1', because: [] },
            mandatory: mandatory || up, cache: { model: TODAY[sim.family], effort: sim.effort, prefixTokens: cache.prefix, lastRequestAt: cache.at, ttlMs: ttl, effortSharesCache: scenario === 'today' || !s.vertex },
            now: s.at, targetWarm: !!warm[target.family] && s.at - warm[target.family].at <= ttl, votes: 2, requestsSinceSwitch: since.requests, verifiedSinceSwitch: since.verified, sameTask: k > 0, risk: 'none', expectedOutputTokens: 600,
            prices, requestsInPrompt: k, switchesThisTask: since.switches, params: { ...DEFAULT_PARAMS, paybackFactor: PAYBACK, paybackQuantile: QUANTILE }, remainingTable: HORIZON,
          })
          if (check.verdict === 'switch') { sim = { family: target.family, effort: target.effort }; switched = true; since = { requests: 0, verified: false, switches: since.switches + (mandatory ? 0 : 1) } }
          if (check.verdict === 'hold' && check.gate === 'payback') out.held.push({ idx: out.steps, write: check.estUsd, from: sim.family, to: target.family, prefix: cache.prefix })
          if (k === 0 || mandatory) out.decisions.push({ at: s.at, cls, from: `${actual.family}/${actual.effort}`, to: `${target.family}/${target.effort}`, ran: `${sim.family}/${sim.effort}`, verdict: check.verdict, gate: check.gate ?? null, reason: check.reason, why, prefix: cache.prefix, estUsd: Math.round(check.estUsd * 100) / 100 })
        } else if (target) { sim = { family: sim.family, effort: target.effort } }
        if (k === 0 && turn.text !== null) since.switches = 0
        // Price this request on the actual route (baseline) and on Auto's route.
        if (inWin) {
          const t = normalize(s, prevAt, scenario)
          const base = usdOn(t, modelFor(actual.family, s, scenario))
          let ta = t
          // A model change rewrites the warm prefix on the first request of the new model.
          const changed = sim.family !== actual.family
          if (switched || (changed && out.steps === 0)) {
            const w = warm[sim.family], ttlNow = scenario === 'today' || !s.vertex ? 3_600_000 : 300_000
            const keep = w && s.at - w.at <= ttlNow ? Math.min(ta.cacheRead, w.prefix) : 0
            const write = ta.cacheRead - keep
            ta = scenario === 'today' || !s.vertex ? { ...ta, cacheRead: keep, cacheWrite1h: ta.cacheWrite1h + write } : { ...ta, cacheRead: keep, cacheWrite5m: ta.cacheWrite5m + write }
          }
          warm[sim.family] = { at: s.at, prefix: promptOf(s) }
          const auto = usdOn(ta, modelFor(sim.family, s, scenario))
          if (switched) out.switchUsd += auto - usdOn(t, modelFor(sim.family, s, scenario))
          out.perStep.push({ family: sim.family, t, model: s.model, cls, vertex: s.vertex })
          // Effort, behavioral and uncalibrated: output scales by the router's prior ratio between the two efforts.
          const pr = DEFAULT_PRIORS.effortOutput, ae = actual.effort in pr ? actual.effort : 'medium'
          out.effortDelta += costOf(t, modelFor(sim.family, s, scenario)).output * ((pr[sim.effort] ?? 1) / pr[ae] - 1)
          out.base += base; out.auto += auto; out.steps += 1
          if ((STRENGTH[sim.family] ?? 2) < (STRENGTH[actual.family] ?? 2)) out.downAuto += auto
          turnBase += base; turnAuto += auto
          out.byClass[cls].base += base; out.byClass[cls].auto += auto
          if (replayable) { out.replayable += 1; out.replayableBase += base } else out.unknownBase += base
        }
        failures += s.failed > 0 ? 1 : 0
        if (s.edits.length) failures = Math.max(0, failures)
        if (s.tests > s.failed && s.tests > 0) since.verified = true
        since.requests += 1
        cache = { prefix: promptOf(s), at: s.at }
        prevAt = s.at
      }
    }
    if (live.length > 100) out.longTurns.push({ at: turn.at, requests: live.length, cls: segments.map((g, i) => classOf(g, { plan: turn.plan && (segments.length === 1 || i === 0), corrected: turn.corrected })).join('>'), prompt: String(turn.text ?? '').replace(/\s+/g, ' ').slice(0, 80), base: turnBase, auto: turnAuto })
  }
  for (const h of out.held) {
    let save = 0
    for (let j = h.idx; j < out.perStep.length; j++) {
      const st = out.perStep[j]
      if (st.family !== h.from || st.cls === 'plan' || st.cls === 'hard') break
      save += usdOn(st.t, TODAY[h.from]) - usdOn(st.t, TODAY[h.to])
    }
    h.realized = save - h.write
  }
  out.regret = { held: out.held.length, wouldHavePaid: out.held.filter((h) => h.realized > 0).length, missedUsd: out.held.filter((h) => h.realized > 0).reduce((a, h) => a + h.realized, 0), avoidedLossUsd: -out.held.filter((h) => h.realized <= 0).reduce((a, h) => a + h.realized, 0) }
  delete out.perStep; delete out.held
  return out
}

// Subagents: subagentRoute moves built-in Explore to Haiku and general-purpose of an Opus parent to Sonnet.
// A subagent starts its own cache, so the move pays no rewrite. Under `fail` the spawn hook still runs (it needs no judge).
export function replaySubagents(file, scenario, start = START, end = END) {
  let base = 0, auto = 0, moved = 0, movedBase = 0, movedAuto = 0
  for (const q of loadSubagents(file)) {
    if (q.at < start || q.at >= end || !rateOf(q.model)) continue
    const vertex = /@|claude-opus-5$|claude-sonnet-4/.test(q.model) && scenario === 'era'
    const m = (f) => (vertex ? VERTEX_ERA : TODAY)[f]
    const fam = familyOf(q.model)
    const b = usdOn(q.tokens, scenario === 'today' ? TODAY[fam] ?? q.model : q.model)
    const r = subagentRoute({ type: q.agentType, parentFamily: fam === 'opus' ? 'opus' : fam, demand: null })
    const a = r && q.modelSet !== 'explicit' ? usdOn(q.tokens, m(r.model)) : b
    if (a !== b) { moved += 1; movedBase += b; movedAuto += a }
    base += b; auto += a
  }
  return { base, auto, moved, movedBase, movedAuto }
}

export function run(regime, scenario) {
  const sessions = []
  for (const root of ROOTS) {
    let projects = []
    try { projects = fs.readdirSync(root) } catch { continue }
    for (const project of projects) {
      let files = []
      try { files = fs.readdirSync(path.join(root, project)).filter((f) => f.endsWith('.jsonl')) } catch { continue }
      for (const f of files) {
        const file = path.join(root, project, f)
        if (fs.statSync(file).mtimeMs < START) continue
        const L = parseLines(file)
        const m = replaySession(L, regime, scenario, START, END, file)
        const sub = replaySubagents(file, scenario)
        if (!m.steps && !sub.base) continue
        const vertexShare = L.filter((r) => r.type === 'assistant' && String(r.message?.id ?? '').startsWith('msg_vrtx')).length
        sessions.push({ project: project.replace(/^-Users-[^-]+-/, ''), session: f.slice(0, 8), workload: workloadOf(root, project), vertex: vertexShare > 0, main: m, sub })
      }
    }
  }
  return sessions
}

const r2 = (x) => Math.round(x * 100) / 100
function summarize(sessions, judgeUsd) {
  const pick = (f) => sessions.filter(f)
  const tot = (ss) => {
    const base = ss.reduce((a, s) => a + s.main.base + s.sub.base, 0), auto = ss.reduce((a, s) => a + s.main.auto + s.sub.auto, 0)
    const judge = ss.reduce((a, s) => a + s.main.judgeCalls, 0) * judgeUsd
    const mainSave = ss.reduce((a, s) => a + s.main.base - s.main.auto, 0), subSave = ss.reduce((a, s) => a + s.sub.base - s.sub.auto, 0)
    // Behavior: if a cheaper model needs d times more of its own requests, the extra cost is d x its fixed-trajectory cost.
    const down = ss.reduce((a, s) => a + s.main.downAuto, 0)
    // Subagents, net: saving = sum(b - a) over the moved runs (avoided cost on the parent's model minus the replacement's
    // cost, same tokens). Two ways that can fail: the replacement needs d times more requests of its own (extra cost
    // d x a), or a share r of the moved runs is redone on the original model (extra cost r x b).
    const mB = ss.reduce((a, s) => a + s.sub.movedBase, 0), mA = ss.reduce((a, s) => a + s.sub.movedAuto, 0), mN = ss.reduce((a, s) => a + s.sub.moved, 0)
    const subNet = {
      movedRequests: mN, avoidedOnOriginalModelUsd: r2(mB), replacementUsd: r2(mA), fixedTrajectorySavingUsd: r2(mB - mA),
      breakEvenExtraRequestsPct: mA ? r2((100 * (mB - mA)) / mA) : null, breakEvenRedoPct: mB ? r2((100 * (mB - mA)) / mB) : null,
      netIfExtraRequests: Object.fromEntries([0.1, 0.25, 0.5, 1].map((d) => [`+${d * 100}%`, r2(mB - mA - d * mA)])),
      netIfRedone: Object.fromEntries([0.05, 0.1, 0.25].map((r) => [`${r * 100}% redone on the original model`, r2(mB - mA - r * mB)])),
    }
    const sens = Object.fromEntries([0.1, 0.25, 0.5].map((d) => [`+${d * 100}% requests on cheaper routes`, r2(base - auto - judge - d * down)]))
    const rg = ss.reduce((a, s) => ({ held: a.held + s.main.regret.held, paid: a.paid + s.main.regret.wouldHavePaid, missed: a.missed + s.main.regret.missedUsd, avoided: a.avoided + s.main.regret.avoidedLossUsd }), { held: 0, paid: 0, missed: 0, avoided: 0 })
    return { base: r2(base), auto: r2(auto + judge), effortBehavioral: r2(-ss.reduce((a, s) => a + s.main.effortDelta, 0)), holdRegret: { held: rg.held, wouldHavePaid: rg.paid, missedUsd: r2(rg.missed), avoidedLossUsd: r2(rg.avoided) }, downgradedAuto: r2(down), breakEvenExtraRequests: down ? r2(mainSave / down) : null, sensitivity: sens, saving: r2(base - auto - judge), pct: r2((100 * (base - auto - judge)) / base), mainSaving: r2(mainSave), subagentSaving: r2(subSave), subagentNet: subNet, switchCost: r2(ss.reduce((a, s) => a + s.main.switchUsd, 0)), judgeUsd: r2(judge),
      coverage: { replayablePct: r2((100 * ss.reduce((a, s) => a + s.main.replayableBase, 0)) / Math.max(1e-9, ss.reduce((a, s) => a + s.main.base, 0))), unknownUsd: r2(ss.reduce((a, s) => a + s.main.unknownBase, 0)) } }
  }
  const classes = {}
  for (const s of sessions) for (const [k, v] of Object.entries(s.main.byClass)) { classes[k] ??= { n: 0, base: 0, auto: 0 }; classes[k].n += v.n; classes[k].base += v.base; classes[k].auto += v.auto }
  return {
    all: tot(sessions), engineering: tot(pick((s) => s.workload === 'engineering')), engineeringVertex: tot(pick((s) => s.workload === 'engineering' && s.vertex)), engineeringFirstParty: tot(pick((s) => s.workload === 'engineering' && !s.vertex)),
    automodeDev: tot(pick((s) => s.workload === 'automode-dev')), benchmark: tot(pick((s) => s.workload === 'benchmark')),
    byClass: Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, { segments: v.n, base: r2(v.base), auto: r2(v.auto), saving: r2(v.base - v.auto) }])),
    gates: sessions.flatMap((s) => s.main.decisions).reduce((m, d) => { const k = `${d.verdict}${d.gate ? ':' + d.gate : ''}`; m[k] = (m[k] ?? 0) + 1; return m }, {}),
    longTurns: sessions.flatMap((s) => s.main.longTurns.map((t) => ({ project: s.project, session: s.session, workload: s.workload, ...t, base: r2(t.base), auto: r2(t.auto), saving: r2(t.base - t.auto) }))).sort((a, b) => b.base - a.base),
    top: [...sessions].sort((a, b) => (b.main.base + b.sub.base) - (a.main.base + a.sub.base)).slice(0, 20).map((s) => ({ project: s.project, session: s.session, workload: s.workload, vertex: s.vertex, base: r2(s.main.base + s.sub.base), auto: r2(s.main.auto + s.sub.auto), saving: r2(s.main.base + s.sub.base - s.main.auto - s.sub.auto), sub: r2(s.sub.base - s.sub.auto), switch: r2(s.main.switchUsd), decisions: s.main.decisions.length })),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const calls = readRecords(DATA).filter((r) => r.kind === 'model-call' && r.ok && r.usd?.value)
  const judgeUsd = calls.reduce((a, r) => a + r.usd.value, 0) / Math.max(1, calls.length)
  const out = { window: { start: new Date(START).toISOString(), end: new Date(END).toISOString() }, judgeUsdPerCall: judgeUsd, judgeCallsMeasured: calls.length, runs: {} }
  for (const scenario of ['today', 'era']) for (const regime of ['fail', 'cautious', 'oracle', 'measured']) {
    const sessions = run(regime, scenario)
    out.runs[`${scenario}/${regime}`] = summarize(sessions, judgeUsd)
    if (scenario === 'today' && regime !== 'fail') out.runs[`${scenario}/${regime}`].timelines = sessions.sort((a, b) => (b.main.base + b.sub.base) - (a.main.base + a.sub.base)).slice(0, 6).map((s) => ({ project: s.project, session: s.session, decisions: s.main.decisions.slice(0, 40) }))
  }
  if (opt('--out')) fs.writeFileSync(opt('--out'), JSON.stringify(out, null, 2))
  for (const [k, v] of Object.entries(out.runs)) { const { timelines, top, ...rest } = v; console.log(k, JSON.stringify(rest)) }
}
