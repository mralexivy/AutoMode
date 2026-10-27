#!/usr/bin/env node
// Historical replay and cost simulator for the V4 engine. $0: no inference, no network, read-only.
//
//   node bench/replay.mjs [--root DIR]... [--decisions FILE]... [--out PREFIX]
//
// Three parts, never mixed:
//   1 measured   what each session's main requests cost, priced from the usage the API reported, by
//                model x effort. Effort is the sent `output_config.effort` from the transcript's
//                api-request record when there is one, else the app's recorded effort.
//   2 replayed   for prompts with a recorded judgment (decisions.jsonl), what V4's optimizer and switch
//                policy would route, and what the same token profile would cost on that route. This is
//                a counterfactual estimate: the token counts are the ones that happened on the actual
//                route; only output is scaled by the effort ratio and cache rewrites are added on a
//                switch. Prompts without a judgment are uncovered and reported, never imputed.
//   3 verdicts   the 60 recorded judge-v2 answers (bench/results/judge-v2-2026-10-20.json) run through
//                the optimizer, scored against their tier labels: under, within, over.
// Plus the outcome dataset from the pilot runs, labeled exploratory (the six tasks were used in tuning).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { listTranscripts, loadSession, recordsBySession } from './lib/transcripts.mjs'
import { ANTHROPIC, familyOf, rateAt, usageUsd } from '../hooks/lib/prices.ts'
import { CAPABILITY, DEFAULT_PRIORS, demandOf, FLOOR_CAPABILITY, mid, optimize, tierOf } from '../hooks/lib/optimizer.ts'
import { prospectiveRisk } from '../hooks/lib/risk.ts'
import { routeFor } from '../hooks/lib/authority.ts'
import { switchCheck } from '../hooks/lib/policy.ts'
import { maxRisk } from '../hooks/lib/types.ts'
import { resolve } from '../hooks/lib/authority.ts'
import { DEFAULT_PARAMS } from '../hooks/lib/policy.ts'
import { FOLLOW_UP } from '../hooks/lib/classify.ts'
import { keepsRoute } from '../hooks/lib/effort.ts'
import { TIERS } from '../hooks/lib/types.ts'

const here = path.dirname(new URL(import.meta.url).pathname)
const args = process.argv.slice(2)
const roots = []
const decisionFiles = []
let out = path.join(here, 'results', `replay-${new Date().toISOString().slice(0, 10)}`)
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') roots.push(args[++i].replace(/^~/, os.homedir()))
  else if (args[i] === '--decisions') decisionFiles.push(args[++i].replace(/^~/, os.homedir()))
  else if (args[i] === '--out') out = args[++i]
}
if (!roots.length) roots.push(path.join(os.homedir(), '.claude', 'projects'), path.join(os.homedir(), '.claude-ectest', 'projects'))
if (!decisionFiles.length) decisionFiles.push(path.join(os.homedir(), '.claude-ectest', 'plugins', 'data', 'automode', 'decisions.jsonl'))

const JUDGE_USD = 0.00019 // measured p50 per in-mod judge call (A7, docs/automode-v4-audit.md)
const TTL = 300_000
const anon = (id) => crypto.createHash('sha256').update(id).digest('hex').slice(0, 10)
const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d

// ---------------------------------------------------------------- pricing helpers

function priceTokens(t, family) {
  return usageUsd({ input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite5m: t.cacheWrite5m, cacheWrite1h: t.cacheWrite1h }, ANTHROPIC.rates[family])
}
const effortOf = (r) => r.sentEffort ?? r.appEffort ?? 'medium'

function addCell(table, key, t, usd) {
  const c = (table[key] ??= { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, thinking: 0, usd: 0 })
  c.requests += 1; c.input += t.input; c.cacheRead += t.cacheRead; c.cacheWrite += t.cacheWrite5m + t.cacheWrite1h; c.output += t.output; c.thinking += t.thinking ?? 0; c.usd += usd
}

// ---------------------------------------------------------------- verdicts from records

function verdictFromDecision(d) {
  const tier = d.candidate?.tier ?? d.effective?.tier
  if (!TIERS.includes(tier)) return null
  const eff = d.effective?.effort
  return {
    tier, complexity: tier === 'T0' ? 'trivial' : tier === 'T3' || tier === 'T4' ? 'complex' : 'standard',
    effort: eff === 'low' || eff === 'medium' || eff === 'high' ? eff : 'high', risk: d.risk?.prospective ?? 'none',
    source: 'recorded', method: d.method,
  }
}

// ---------------------------------------------------------------- 1 + 2: sessions

function replaySession(s, decisions) {
  const measured = {}
  const replayed = {}
  const routes = []
  const prompts = s.prompts.filter((p) => p.requests.length)
  const decs = (decisions ?? []).filter((d) => d.kind === 'decision' && d.point === 'prompt').sort((a, b) => a.at - b.at)
  let prev = null
  let current = null
  let warm = {}
  let covered = 0
  let judged = 0
  let measuredUsd = 0
  let measuredCoveredUsd = 0
  let replayedCoveredUsd = 0
  let switches = 0
  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i]
    const until = prompts[i + 1]?.at ?? Infinity
    let pUsd = 0
    for (const r of p.requests) {
      const fam = familyOf(r.model ?? '') ?? 'sonnet'
      const usd = priceTokens(r.tokens, fam)
      pUsd += usd
      addCell(measured, `${fam}/${effortOf(r)}`, r.tokens, usd)
    }
    measuredUsd += pUsd
    // A recorded decision for this prompt, or a follow-up that keeps the previous verdict.
    const d = decs.find((x) => x.at >= p.at - 5_000 && x.at < until)
    let v = d ? verdictFromDecision(d) : null
    if (!v && prev && p.text !== undefined && keepsRoute(p.text, '', FOLLOW_UP)) v = { ...prev, source: 'continuation' }
    if (!v) { routes.push({ covered: false }); continue }
    covered += 1
    if (v.source === 'recorded' && d.judge?.called) judged += 1
    prev = v
    const first = p.requests[0].tokens
    const prefix = first.input + first.cacheRead + first.cacheWrite5m + first.cacheWrite1h
    const cache = { model: current?.model ?? null, effort: current?.effort ?? null, prefixTokens: prefix, lastRequestAt: current ? p.at - 1_000 : null, ttlMs: TTL, effortSharesCache: true }
    // The same pipeline as decide(): rules plus the recorded judgment for consequence, a cache-neutral
    // choice, then the switch check with the cache economics.
    const consequence = p.text !== undefined ? prospectiveRisk(p.text, { risk: v.risk, why: '' }).level : v.risk
    const demand = demandOf({ ...v, consequence })
    const riskFloor = consequence === 'critical' && v.complexity !== 'trivial' ? 'T2' : 'T0'
    const opt = optimize(demand, { cache, warm, now: p.at, prices: ANTHROPIC, priors: DEFAULT_PRIORS, neutral: true }, { minCap: FLOOR_CAPABILITY[riskFloor], haikuMaxContext: DEFAULT_PARAMS.haikuMaxContext })
    const candidate = { tier: tierOf(opt.best.family, opt.best.effort), source: 'judge', confidence: 0.9, reason: 'replay' }
    const route = resolve({
      floor: { tier: riskFloor, because: riskFloor === 'T0' ? [] : ['critical consequence'] }, candidate, effortHint: opt.best.effort, current,
      switchInput: { cache, now: p.at, votes: 2, requestsSinceSwitch: 10, verifiedSinceSwitch: true, sameTask: false, risk: consequence, expectedOutputTokens: DEFAULT_PRIORS.outputPerStep[current?.family ?? 'sonnet'], prices: ANTHROPIC, params: DEFAULT_PARAMS, newTaskSteps: demand.steps, targetWarm: !!(warm[opt.best.family] && warm[opt.best.family].until > p.at) },
    }, !current)
    const actualFam = familyOf(p.requests[0].model ?? '') ?? 'sonnet'
    const moved = current && current.family !== route.family
    if (moved) switches += 1
    // Reprice the same token profile on the replayed route.
    let rUsd = v.source === 'recorded' && d.judge?.called ? JUDGE_USD : 0
    p.requests.forEach((r, k) => {
      const t = { ...r.tokens }
      const ratio = DEFAULT_PRIORS.effortOutput[route.effort] / (DEFAULT_PRIORS.effortOutput[effortOf(r)] ?? 1)
      t.output = Math.round(t.output * ratio)
      const w = warm[route.family]
      const coldHere = k === 0 && route.family !== actualFam && !(w && w.until > r.at)
      if (coldHere) { t.cacheWrite5m += t.cacheRead; t.cacheRead = 0 }
      const usd = priceTokens(t, route.family)
      rUsd += usd
      addCell(replayed, `${route.family}/${route.effort}`, t, usd)
    })
    warm = { ...warm, [route.family]: { effort: route.effort, until: p.requests[p.requests.length - 1].at + TTL, prefixTokens: prefix } }
    current = route
    measuredCoveredUsd += pUsd
    replayedCoveredUsd += rUsd
    routes.push({ covered: true, source: v.source, actual: `${actualFam}/${effortOf(p.requests[0])}`, replayed: `${route.family}/${route.effort}`, owner: route.owner, check: route.check?.verdict ?? null, gate: route.check?.gate ?? null })
  }
  return { measured, replayed, routes, prompts: prompts.length, covered, judged, switches, measuredUsd, measuredCoveredUsd, replayedCoveredUsd }
}

// ---------------------------------------------------------------- 2b: cache economics and guardrails, all prompts
// No judgment needed: at every prompt boundary that ran on Opus, would a move to Sonnet pay back its cache
// rewrite under the switch check (if Sonnet were adequate, which this lens does not know)? Plus how often
// the guardrail signals fire. Counterfactual policy arithmetic over measured prefixes and gaps.
function economicsLens(s, acc) {
  const ps = s.prompts.filter((p) => p.requests.length)
  let last = null
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]
    const first = p.requests[0]
    acc.prompts += 1
    if (p.text !== undefined && prospectiveRisk(p.text, null).level === 'critical') acc.rulesCritical += 1
    if (p.compacted) acc.compactions += 1
    if (last) {
      const ttl = last.tokens.cacheWrite1h > 0 ? 3_600_000 : 300_000
      const gap = first.at - last.at
      if (gap > ttl) acc.expired += 1
      const fam = familyOf(first.model ?? '')
      if (fam === 'opus') {
        const t = first.tokens
        const prefix = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h
        const cur = routeFor('T3')
        const r = switchCheck({
          current: cur, target: routeFor('T1'), candidate: { tier: 'T1', source: 'judge', confidence: 0.95, reason: 'lens' }, floor: { tier: 'T0', because: [] }, mandatory: false,
          cache: { model: cur.model, effort: 'high', prefixTokens: prefix, lastRequestAt: first.at - Math.min(gap, 10 * ttl), ttlMs: ttl, effortSharesCache: true },
          now: first.at, votes: 1, requestsSinceSwitch: 99, verifiedSinceSwitch: true, sameTask: false, risk: 'none',
          expectedOutputTokens: DEFAULT_PRIORS.outputPerStep.opus, prices: ANTHROPIC, params: DEFAULT_PARAMS,
        })
        const k = r.verdict === 'switch' ? (r.lowPenaltyPoint ? 'switch: cold or reset cache' : 'switch: pays back') : `hold: ${r.gate}`
        acc.opusBoundaries[k] = (acc.opusBoundaries[k] ?? 0) + 1
        if (r.economics) acc.penalties.push(r.economics.writePenaltyUsd)
      }
    }
    last = p.requests[p.requests.length - 1]
  }
}

// ---------------------------------------------------------------- 3: recorded judge verdicts

function verdicts() {
  const file = path.join(here, 'results', 'judge-v2-2026-10-20.json')
  if (!fs.existsSync(file)) return null
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  const cases = JSON.parse(fs.readFileSync(path.join(here, 'judge-cases-v2.json'), 'utf8'))
  const labels = new Map((cases.cases ?? cases).map((c) => [c.id, c]))
  const cache = { model: null, effort: null, prefixTokens: 20_000, lastRequestAt: null, ttlMs: TTL, effortSharesCache: true }
  const rows = []
  for (const r of j.rows) {
    if (!r.answer) continue
    const label = labels.get(r.id)
    // The same floors as decide(): the deterministic rules join the judge on consequence; a critical
    // consequence sets review and a Sonnet-high floor; the demand alone decides whether Opus is needed.
    const a = r.answer
    const consequence = maxRisk(a.risk, prospectiveRisk(r.text ?? label?.text ?? '', null).level)
    const floor = consequence === 'critical' && a.complexity !== 'trivial' ? 'T2' : 'T0'
    const c = optimize(demandOf({ ...a, consequence }), { cache, warm: {}, now: 0, prices: ANTHROPIC, neutral: true }, { minCap: FLOOR_CAPABILITY[floor] })
    const tier = tierOf(c.best.family, c.best.effort)
    const want = label?.tiers ?? []
    const minWant = Math.min(...want.map((t) => TIERS.indexOf(t)))
    const maxWant = Math.max(...want.map((t) => TIERS.indexOf(t)))
    const at = TIERS.indexOf(tier)
    // A ladder route of the lowest acceptable tier gives the capability the label asks for.
    const ladderCap = mid([CAPABILITY.haiku.low, CAPABILITY.sonnet.medium, CAPABILITY.sonnet.high, CAPABILITY.opus.high, CAPABILITY.opus.max][minWant])
    const verdict = at > maxWant ? 'over' : at < minWant ? (mid(c.best.cap) >= ladderCap ? 'within' : 'under') : 'within'
    rows.push({ id: r.id, label: want.join('|'), labelRisk: label?.risk, judgeRisk: a.risk, consequence, reviewRequired: consequence === 'critical', judge: `${r.answer.tier}/${r.answer.effort}`, route: `${c.best.family}/${c.best.effort}`, tier, verdict, adequacy: c.best.adequacy, usd: round(c.best.expectedUsd) })
  }
  const count = (v) => rows.filter((r) => r.verdict === v).length
  const critical = rows.filter((r) => r.labelRisk === 'critical')
  return {
    source: 'bench/results/judge-v2-2026-10-20.json (60 recorded Haiku answers, labels written before the run)',
    n: rows.length, within: count('within'), under: count('under'), over: count('over'),
    criticalUnder: critical.filter((r) => r.verdict === 'under').map((r) => `${r.id}${r.reviewRequired ? ' (review required)' : ' (consequence missed by judge and rules)'}`),
    criticalReviewRecall: `${critical.filter((r) => r.reviewRequired).length}/${critical.length}`,
    note: 'These 60 labels were seen while the V4 optimizer was revised (2026-10-21), so this is a regression check, not a held-out evaluation.',
    routes: Object.fromEntries([...new Set(rows.map((r) => r.route))].map((k) => [k, rows.filter((r) => r.route === k).length])),
    rows,
  }
}

// ---------------------------------------------------------------- outcome dataset

function outcomes() {
  const out = []
  for (const name of ['v4-pilot-2026-10-20', 'v4-pilot2-2026-10-20']) {
    const runs = path.join(here, 'results', `${name}.jsonl`)
    const grades = path.join(here, 'results', `${name}.grades.jsonl`)
    if (!fs.existsSync(runs)) continue
    const g = new Map()
    if (fs.existsSync(grades)) for (const l of fs.readFileSync(grades, 'utf8').split('\n').filter(Boolean)) { const x = JSON.parse(l); g.set(x.run_id, x.grade) }
    for (const l of fs.readFileSync(runs, 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(l)
      const gr = g.get(r.run_id)
      const q = gr ? ['correctness', 'completeness', 'scope', 'tests', 'maintainability'].reduce((a, k) => a + (gr[k] ?? 0), 0) / 5 : null
      out.push({ batch: name, task: r.task_id, arm: r.arm, accepted: r.accepted, usd: round(r.cost_usd_api_equiv ?? 0), quality: q === null ? null : round(q, 2), tunedOn: true })
    }
  }
  const arms = [...new Set(out.map((o) => o.arm))]
  const summary = Object.fromEntries(arms.map((a) => {
    const xs = out.filter((o) => o.arm === a)
    const acc = xs.filter((o) => o.accepted)
    const usd = xs.reduce((s, o) => s + o.usd, 0)
    return [a, { runs: xs.length, accepted: acc.length, usd: round(usd, 2), usdPerAccepted: acc.length ? round(usd / acc.length, 2) : null, meanQuality: round(xs.filter((o) => o.quality !== null).reduce((s, o) => s + o.quality, 0) / Math.max(1, xs.filter((o) => o.quality !== null).length), 2) }]
  }))
  return { label: 'exploratory: the six tasks were used while tuning V3 and V4; no confirmatory claim', runs: out, summary }
}

// ---------------------------------------------------------------- main

const files = listTranscripts(roots)
const recs = new Map()
for (const f of decisionFiles) for (const [k, v] of recordsBySession(f)) recs.set(k, [...(recs.get(k) ?? []), ...v])
const totals = { sessions: 0, prompts: 0, covered: 0, judged: 0, switches: 0, measuredUsd: 0, measuredCoveredUsd: 0, replayedCoveredUsd: 0 }
const measured = {}
const replayed = {}
const sessions = []
const ownerCount = {}
const lens = { prompts: 0, rulesCritical: 0, compactions: 0, expired: 0, opusBoundaries: {}, penalties: [] }
const byRole = {}
for (const f of files) {
  const s = loadSession(f, { withText: true, subagents: true }) // text stays in memory for the rules; never written
  if (!s.prompts.some((p) => p.requests.length)) continue
  economicsLens(s, lens)
  for (const r of [...s.sidechain.map((x) => ({ ...x, role: 'sidechain' })), ...s.subagents]) {
    const fam = familyOf(r.model ?? '') ?? 'sonnet'
    addCell(byRole, `${r.role}: ${fam}`, r.tokens, priceTokens(r.tokens, fam))
  }
  const r = replaySession(s, recs.get(s.sessionId))
  totals.sessions += 1
  for (const k of ['prompts', 'covered', 'judged', 'switches', 'measuredUsd', 'measuredCoveredUsd', 'replayedCoveredUsd']) totals[k] += r[k]
  for (const [k, c] of Object.entries(r.measured)) for (const [f2, v] of Object.entries(c)) ((measured[k] ??= {})[f2] = (measured[k]?.[f2] ?? 0) + v)
  for (const [k, c] of Object.entries(r.replayed)) for (const [f2, v] of Object.entries(c)) ((replayed[k] ??= {})[f2] = (replayed[k]?.[f2] ?? 0) + v)
  for (const x of r.routes.filter((y) => y.covered)) ownerCount[`${x.owner}${x.gate ? `:${x.gate}` : ''}`] = (ownerCount[`${x.owner}${x.gate ? `:${x.gate}` : ''}`] ?? 0) + 1
  if (r.covered) sessions.push({ session: anon(s.sessionId), prompts: r.prompts, covered: r.covered, switches: r.switches, measuredCoveredUsd: round(r.measuredCoveredUsd), replayedCoveredUsd: round(r.replayedCoveredUsd), routes: r.routes.filter((x) => x.covered) })
}
const v = verdicts()
const o = outcomes()
const report = {
  generatedAt: new Date().toISOString(),
  cost: '$0: no inference; transcripts and records read locally',
  prices: `${ANTHROPIC.provider} ${ANTHROPIC.checkedAt}; models of older generations priced at the 5.5 row of their family`,
  coverage: { ...totals, coveredShare: round(totals.covered / Math.max(1, totals.prompts), 3), measuredUsd: round(totals.measuredUsd, 2), measuredCoveredUsd: round(totals.measuredCoveredUsd, 2), replayedCoveredUsd: round(totals.replayedCoveredUsd, 2) },
  measured: { basis: 'measured', byModelEffort: measured, subagentsByRole: byRole, judge: 'in-mod judge calls write no transcript lines; their measured cost is in the decision records (judge.usd)' },
  economics: {
    basis: 'counterfactual policy arithmetic on measured prefixes and gaps', prompts: lens.prompts,
    rulesCriticalShare: round(lens.rulesCritical / Math.max(1, lens.prompts), 3), compactions: lens.compactions, expiredAtBoundary: lens.expired,
    opusBoundaryDowngrade: lens.opusBoundaries,
    writePenaltyUsd: (() => { const xs = [...lens.penalties].sort((a, b) => a - b); const q = (f) => (xs.length ? round(xs[Math.floor(f * (xs.length - 1))]) : null); return { n: xs.length, p25: q(0.25), median: q(0.5), p75: q(0.75), p95: q(0.95) } })(),
  },
  reconciliation: (() => { try { const r = JSON.parse(fs.readFileSync(path.join(here, 'results', `reconcile-${new Date().toISOString().slice(0, 10)}.json`), 'utf8')); return { runs: r.runs, withinTolerance: r.pass, tolerance: r.tolerance } } catch { return 'run bench/reconcile.mjs first' } })(),
  replayed: { basis: 'estimate (counterfactual)', byModelEffort: replayed, owners: ownerCount, sessions },
  verdicts: v,
  outcomes: o,
}
fs.writeFileSync(`${out}.json`, JSON.stringify(report, null, 2) + '\n')

const table = (t) => {
  const rows = Object.entries(t).sort((a, b) => b[1].usd - a[1].usd)
  return ['| model/effort | requests | input | cache read | cache write | output | thinking | USD |', '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map(([k, c]) => `| ${k} | ${c.requests} | ${c.input} | ${c.cacheRead} | ${c.cacheWrite} | ${c.output} | ${c.thinking} | ${round(c.usd, 2)} |`)].join('\n')
}
const md = [
  `# V4 replay, ${report.generatedAt.slice(0, 10)}`,
  '',
  `Cost of this report: ${report.cost}. Prices: ${report.prices}.`,
  '',
  '## Coverage',
  '',
  `${totals.sessions} sessions, ${totals.prompts} prompts with requests. ${totals.covered} prompts (${(100 * report.coverage.coveredShare).toFixed(1)}%) have a recorded judgment or continue one; ${totals.judged} of them had a judge call. The rest are uncovered and are not replayed.`,
  '',
  '## Measured (all prompts, basis: measured)',
  '',
  table(measured),
  '',
  `Total: $${report.coverage.measuredUsd}.`,
  '',
  'Subagents and sidechains (measured):',
  '',
  table(byRole),
  '',
  `Accounting check (bench/reconcile.mjs): ${typeof report.reconciliation === 'string' ? report.reconciliation : `${report.reconciliation.withinTolerance}/${report.reconciliation.runs} benchmark sessions within ±${report.reconciliation.tolerance * 100}% of the CLI's own cost`}.`,
  '',
  '## Cache economics at prompt boundaries (all prompts, counterfactual arithmetic)',
  '',
  `At each prompt that ran on Opus after an earlier request, the switch check was asked: would moving to Sonnet pay back its cache rewrite (assuming Sonnet were adequate, which this lens does not know)? ${Object.entries(lens.opusBoundaries).map(([k, n]) => `${k}: ${n}`).join('; ')}. Write penalty per boundary: ${JSON.stringify(report.economics.writePenaltyUsd)}. Guardrails: rules flag ${(100 * report.economics.rulesCriticalShare).toFixed(1)}% of prompts critical (review), ${lens.compactions} compactions, ${lens.expired} prompts start on an expired cache.`,
  '',
  '## Replayed (covered prompts only, basis: counterfactual estimate)',
  '',
  `Covered prompts cost $${report.coverage.measuredCoveredUsd} as measured. The same token profiles on the V4 routes: $${report.coverage.replayedCoveredUsd}, with ${totals.switches} model switches and the judge overhead included. The two numbers are never added.`,
  '',
  table(replayed),
  '',
  `Route owners and switch gates: ${Object.entries(ownerCount).map(([k, n]) => `${k} ${n}`).join(', ')}.`,
  '',
  '## Recorded judge verdicts through the optimizer',
  '',
  v ? `${v.n} answers: ${v.within} within the labeled tiers, ${v.under} under, ${v.over} over. Critical cases that get the required review: ${v.criticalReviewRecall}. Critical cases routed under their tier label: ${v.criticalUnder.length ? v.criticalUnder.join(', ') : 'none'}. Routes: ${Object.entries(v.routes).map(([k, n]) => `${k} ${n}`).join(', ')}. ${v.note}` : 'judge-v2 results not found.',
  '',
  '## Outcome dataset (exploratory)',
  '',
  o.label,
  '',
  '| arm | runs | accepted | USD | USD per accepted | mean grade |', '|---|---:|---:|---:|---:|---:|',
  ...Object.entries(o.summary).map(([a, s]) => `| ${a} | ${s.runs} | ${s.accepted} | ${s.usd} | ${s.usdPerAccepted ?? '-'} | ${s.meanQuality} |`),
  '',
].join('\n')
fs.writeFileSync(`${out}.md`, md)
console.log(md)
