#!/usr/bin/env node
// @ts-nocheck TODO(types): 21 errors with strict off. Fix them and delete this line to turn checking on for this file.
// Before/after routing trace: the recorded routes (what ran) next to what policy auto decides on the same prompts.
//
//   node bench/policy-trace.mts [--data DIR] [--roots DIR,DIR] [--text] [--out FILE]               # $0, cached verdicts
//   node bench/policy-trace.mts --rejudge --run --approve-usd 0.5 --batch 2026-10-25               # asks the missing verdicts
//
// Policy auto needs one effortless verdict per candidate model. The recorded decisions hold the AutoMode judge's demand
// but no effortless verdicts, so --rejudge asks Haiku 5.5 once per prompt and model (upstream JUDGE_SYSTEM, the adapted
// input with the recorded running model as Current and the transcript's previous turn as context) and caches each
// answer in bench/results/trace-verdicts.json. Without a verdict a prompt shows "needs a verdict"; nothing is guessed.
// The auto route then comes from the same code the router runs: optimizeAuto for the joint choice, resolve() with the
// recorded cache state for the hold-or-switch check, and the resolution steps for overrides and the short-message
// shortcut. Escalation floors are not replayed (the defect history is not in the decision record).
//
// Costs come in three views that are never added or mixed:
//   measured    what the sessions spent, from the usage the API reported (records).
//   reprice     the SAME token counts priced on the new routes: output scaled by the effort ratio, a cache rewrite
//               added when the model changes. A fixed trajectory: it assumes effort does not change the work done.
//   forecast    reprice, with the number of requests also scaled by the effort ratio. An ESTIMATE from uncontrolled priors.
// Only "measured" is a fact. A reprice or a forecast is never a saving that happened.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSession, readRecords } from './lib/transcripts.mts'
import { ANTHROPIC, usageUsd } from '../hooks/lib/prices.ts'
import { attemptCost, DEFAULT_PRIORS, demandOf, optimize, REMAINING, TIER_DIFFICULTY, TASK_STEPS, tierOf } from '../hooks/lib/optimizer.ts'
import { parseOverride } from '../hooks/lib/classify.ts'
import { transitionOf } from '../hooks/lib/transition.ts'
import { DEFAULT_LADDER, resolve } from '../hooks/lib/authority.ts'
import { DEFAULT_PARAMS } from '../hooks/lib/policy.ts'
import { JUDGE_SYSTEM, keepsEffort, parseVerdict } from '../hooks/lib/effortless.ts'
import { judgeInputFor } from '../hooks/lib/effortless-adapt.ts'
import { fallbackModel, firstCalls, optimizeAuto, ownEffort, runningRuledOut, secondCall, shortcutApplies } from '../hooks/lib/auto.ts'
import { stageOfText } from './calibrate.mts'
import { haikuCall } from './lib/haiku-call.mts'
import { total } from './lib/ledger.mts'

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const dataDir = opt('--data', path.join(os.homedir(), '.claude', 'plugins', 'data', 'automode'))
const roots = opt('--roots', path.join(os.homedir(), '.claude', 'projects')).split(',')
const showText = args.includes('--text')
const outFile = opt('--out', null)
const rejudge = args.includes('--rejudge') && args.includes('--run')
const cap = Number(opt('--approve-usd', 0))
const batch = opt('--batch', new Date().toISOString().slice(0, 10))
const VERDICTS = path.join(path.dirname(new URL(import.meta.url).pathname), 'results', 'trace-verdicts.json')
let cache = {}
try { cache = JSON.parse(fs.readFileSync(VERDICTS, 'utf8')) } catch {}
const DEFAULT_EFFORT = { haiku: 'medium', sonnet: 'high', opus: 'medium' }
const famOf = (m) => String(m ?? '').replace('claude-', '').replace(/-5-5.*/, '')
let asked = 0, missing = 0, calls = 0
const staleRows = new Set(), rejudgedNow = new Set()
const HOUR = 3_600_000
const TIERS = Object.keys(TIER_DIFFICULTY)
const nearest = (v, table) => Object.entries(table).sort((a, b) => Math.abs(a[1] - v) - Math.abs(b[1] - v))[0][0]
const short = (s, n = 54) => String(s).replace(/\s+/g, ' ').slice(0, n)

const all = readRecords(dataDir)
const bySession = new Map()
for (const r of all) { if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []); bySession.get(r.sessionId).push(r) }

// withContext: each prompt with the person's previous prompt and the assistant's last reply before it (the judge's context).
function withContext(file) {
  const ps = loadSession(file, { withText: true, queued: true }).prompts
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const replies = lines.filter((r) => r.type === 'assistant' && !r.isSidechain && Array.isArray(r.message?.content)).map((r) => ({ at: Date.parse(r.timestamp), text: r.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') })).filter((r) => r.text.trim())
  return ps.map((p, i) => ({ ...p, prevUser: i > 0 ? String(ps[i - 1].text ?? '').slice(0, 400) : '', lastReply: (replies.filter((r) => r.at < p.at).pop()?.text ?? '').slice(-2000) }))
}

function transcriptOf(id) {
  for (const root of roots) {
    let dirs = []
    try { dirs = fs.readdirSync(root) } catch { continue }
    for (const d of dirs) { const f = path.join(root, d, `${id}.jsonl`); if (fs.existsSync(f)) return f }
  }
  return null
}

// The measured size of a session's first request, and its project (the transcript's folder). The estimate for a
// session's first prompt is the median of the OTHER sessions of the same project: what the router would have known.
const firstOf = new Map()
const projectOf = new Map()
for (const [id, rs] of bySession) {
  const r = rs.filter((x) => x.kind === 'request' && !x.agentId && x.usage).sort((a, b) => a.at - b.at)[0]
  if (r) firstOf.set(id, r.usage.input + r.usage.cacheRead + r.usage.cacheWrite5m + r.usage.cacheWrite1h)
  const f = transcriptOf(id)
  if (f) projectOf.set(id, path.dirname(f))
}
// The router's rule: this project's median, else the p75 of every other session on the machine (a new project), each
// with 4,000 tokens of headroom; none at all means unknown.
function estimateFor(id) {
  const others = [...firstOf].filter(([o]) => o !== id)
  const own = others.filter(([o]) => projectOf.get(o) && projectOf.get(o) === projectOf.get(id)).map(([, n]) => n).sort((a, b) => a - b)
  if (own.length) return own[Math.floor(own.length / 2)] + 4_000
  const all = others.map(([, n]) => n).sort((a, b) => a - b)
  return all.length ? all[Math.floor(0.75 * (all.length - 1))] + 4_000 : null
}

const rows = []
const totals = { measured: 0, reprice: 0, forecast: 0, requests: 0 }
// The fair comparison: rows where both policies have a route, priced the same way on the same requests.
const fair = { n: 0, requests: 0, measured: 0, legacy: 0, auto: 0, legacyF: 0, autoF: 0 }
const dist = { before: {}, after: {} }
const bump = (o, k) => { o[k] = (o[k] ?? 0) + 1 }

for (const [id, rs] of bySession) {
  const decs = rs.filter((r) => r.kind === 'decision' && r.point === 'prompt').sort((a, b) => a.at - b.at)
  if (!decs.length) continue
  const file = transcriptOf(id)
  const prompts = file ? withContext(file) : []
  const reqs = rs.filter((r) => r.kind === 'request' && !r.agentId).sort((a, b) => a.at - b.at)
  let prevFamilyNew = null
  let prevFamilyLegacy = null
  let prevAuto = null
  const used = new Set()
  decs.forEach((d, i) => {
    // Each prompt matches one decision: the nearest unused one, within 30 s for a typed prompt and 180 s for a message
    // queued mid-turn (stored when it was delivered, not when it was typed).
    const p = prompts.map((x) => ({ x, dt: Math.abs(x.at - d.at) })).filter((m) => !used.has(m.x) && m.dt < (m.x.midTurn ? 180_000 : 30_000)).sort((a, b) => a.dt - b.dt)[0]?.x
    if (p) used.add(p)
    const text = p?.text ?? ''
    const actual = { family: d.effective.model.replace('claude-', '').replace(/-5-5.*/, ''), effort: d.effective.effort, owner: d.effective.owner, method: d.method }
    const dm = d.optimizer?.demand
    let legacyNow = null
    const prev = i > 0 ? decs[i - 1].effective : null
    const current = prev ? { family: famOf(prev.model), effort: prev.effort } : null
    const lastReply = p?.lastReply ?? ''
    const ctxMsgs = [...(p?.prevUser ? [{ role: 'user', text: p.prevUser }] : []), ...(lastReply ? [{ role: 'assistant', text: lastReply }] : [])]
    const ctx = ctxMsgs.map((m) => `${m.role}: ${m.text}`).join('\n')
    const ov = text ? parseOverride(text) : null
    const tr = text ? transitionOf(text, lastReply) : null
    let after
    if (!text) after = { ...actual, why: 'no prompt text in the transcripts: unchanged' }
    else if (current && shortcutApplies(keepsEffort(text, ctx), text, { required: false }) && tr?.kind !== 'begin-approved' && !ov) after = { ...(prevAuto ?? current), owner: 'continuation', why: 'upstream keepsEffort: keeps the task route' }
    else {
      const dm = d.optimizer?.demand
      const hm = dm ? { tier: nearest(dm.difficulty, TIER_DIFFICULTY), complexity: nearest(dm.steps, TASK_STEPS) } : null
      const prefix = d.cache?.prefixTokens || estimateFor(id) || 0
      const allowed = ['haiku', 'sonnet', 'opus'].filter((f) => !(f === 'haiku' && (!prefix || prefix > DEFAULT_PARAMS.haikuMaxContext)))
      const fixedFamily = ov?.tier ? DEFAULT_LADDER.tiers[ov.tier].family : ov?.effort && current ? current.family : undefined
      // The router's protocol: call 1 with the fixed anchor (A9) and the running model, then at most one second call
      // about the model secondCall names. Verdicts come from the cache; a missing one is asked only with --rejudge.
      const families = firstCalls(fixedFamily, current && allowed.includes(current.family) ? current.family : undefined)
      const anchor = families[0]
      const verdicts = {}
      const askFor = (f) => {
        const key = `${id}|${d.at}|${f}`
        if ((!(key in cache) || (current?.family === f && !d.cache?.warm && current.effort !== DEFAULT_EFFORT[f])) && rejudge && !rejudgedNow.has(key)) {
          const input = judgeInputFor(text, { family: f, effort: current?.family === f && d.cache?.warm ? current.effort : DEFAULT_EFFORT[f], messages: ctxMsgs })
          const r = haikuCall(JUDGE_SYSTEM, input, { cap, batch, what: 'policy-trace rejudge', estimate: 0.0025 })
          cache[key] = r.ok ? parseVerdict(r.text) ?? null : null
          rejudgedNow.add(key)
          asked += 1
          fs.writeFileSync(VERDICTS, JSON.stringify(cache, null, 1))
        }
        // A cached verdict asked with a different Current line than the router now sends (A7: a cold cache names the
        // default effort) is stale: the row is unknown until it is asked again.
        const staleInput = current?.family === f && !d.cache?.warm && current.effort !== DEFAULT_EFFORT[f] && !rejudgedNow.has(key)
        verdicts[f] = staleInput ? undefined : cache[key] ?? null
        if (staleInput) staleRows.add(`${id}|${d.at}`)
      }
      let fixedFallback = null
      legacyNow = null
      for (const f of families) askFor(f)
      if (verdicts[anchor] === undefined) { missing += 1; after = { ...actual, why: 'unknown: the cached verdict was asked with a different Current line (A7); needs --rejudge' } }
      // As the router: a failed anchor call is a fallback (the anchor model at the previous or app effort), with no second call.
      const anchorFailed = !verdicts[anchor]
      if (anchorFailed && cache[`${id}|${d.at}|${anchor}`] !== undefined) {
        // As the router: the model stays unless the AutoMode judge names a stronger one (fallbackModel).
        const fm = fallbackModel(anchor, hm ? { tier: hm.tier, effort: dm?.hmEffort, confidence: dm?.confidence } : null, allowed, d.risk?.effective, 0.3)
        verdicts[anchor] = undefined
        verdicts[fm.family] = { model: fm.family, effort: fm.family === anchor ? (current?.family === anchor ? current.effort : 'medium') : (fm.effort ?? (fm.family === 'haiku' ? 'medium' : 'high')), why: fm.family === anchor ? 'fallback' : 'fallback; the recorded decision has no AutoMode effort: the model default assumed' }
        fixedFallback = fm.family
      }
      const floorsPre = { because: [], ...(d.risk?.effective === 'critical' && hm?.complexity !== 'trivial' ? { exclude: { haiku: 'critical' }, effortMin: { sonnet: 'high' } } : {}) }
      const need = verdicts[anchor] ?? null
      const second = fixedFamily || anchorFailed ? null : secondCall({ allowed, verdicts, need, hm, consequence: d.risk?.effective, floors: floorsPre, current: null, cost: () => 0 }, anchor)
      if (second) askFor(second)
      calls += families.length + (second ? 1 : 0)
      if (after) { /* unknown, set above */ }
      else if (!Object.values(verdicts).some(Boolean)) { missing += 1; after = { ...actual, owner: actual.owner, why: 'needs a verdict (run with --rejudge)' } }
      else {
        const x = { cache: { model: null, effort: null, prefixTokens: prefix, lastRequestAt: null, ttlMs: HOUR, effortSharesCache: true }, warm: {}, now: 0, prices: ANTHROPIC, priors: DEFAULT_PRIORS, neutral: true }
        const cost = (family, effort) => attemptCost({ family, effort, cap: { lo: 0, hi: 0 } }, { steps: TASK_STEPS[hm?.complexity ?? 'standard'] }, x).usd
        const floors = { because: [], ...(fixedFallback ? { fixedFamily: fixedFallback } : {}), ...(d.risk?.effective === 'critical' && hm?.complexity !== 'trivial' ? { exclude: { haiku: 'critical' }, effortMin: { sonnet: 'high' } } : {}), ...(fixedFamily ? { fixedFamily } : {}), ...(ov?.effort ? { fixedEffort: ov.effort } : {}) }
        const choice = optimizeAuto({ allowed, verdicts, need: need ?? (fixedFallback ? verdicts[fixedFallback] : null), hm, consequence: d.risk?.effective, floors, current, cost })
        const own = current ? choice.candidates.find((c) => c.family === current.family) : null
        const currentInadequate = runningRuledOut(current?.family, choice, floors, hm)
        const warm = !!d.cache?.warm
        const route = current ? resolve({
          ...(ov?.tier || ov?.effort ? { override: { tier: tierOf(choice.best.family, choice.best.effort), effort: choice.best.effort, reason: 'user command' } } : {}),
          floor: { tier: 'T0', because: [] }, candidate: { tier: tierOf(choice.best.family, choice.best.effort), source: 'judge', confidence: 0.9, reason: choice.rule },
          effortHint: choice.best.effort, heldEffort: ownEffort(own), ...(currentInadequate ? { currentInadequate } : {}), current: { tier: tierOf(current.family, current.effort), family: current.family, model: DEFAULT_LADDER.models[current.family], effort: current.effort },
          switchInput: { cache: { model: DEFAULT_LADDER.models[current.family], effort: current.effort, prefixTokens: prefix, lastRequestAt: warm ? d.at : null, ttlMs: HOUR, effortSharesCache: true }, now: d.at, votes: 1, requestsSinceSwitch: 5, verifiedSinceSwitch: false, sameTask: true, risk: d.risk?.effective ?? 'none', expectedOutputTokens: DEFAULT_PRIORS.outputPerStep[current.family], prices: ANTHROPIC, params: DEFAULT_PARAMS, requestsInPrompt: 0, remainingTable: REMAINING, switchesThisTask: 0, targetWarm: false },
        }) : null
        const fam = route?.family ?? choice.best.family, eff = route?.effort ?? choice.best.effort
        // Today's legacy policy on the SAME state, guards and cache: the fair comparison (the "ran" column predates v4.1).
        if (dm && hm) {
          const demand = demandOf({ tier: hm.tier, complexity: hm.complexity, risk: 'none', consequence: d.risk?.effective ?? 'none', confidence: dm.confidence }, !!dm.planning, dm.failures ?? 0)
          const optL = optimize(demand, x, { haikuMaxContext: DEFAULT_PARAMS.haikuMaxContext, allowed })
          const heldL = current && allowed.includes(current.family) ? optimize(demand, x, { haikuMaxContext: DEFAULT_PARAMS.haikuMaxContext, allowed, family: current.family }) : null
          const routeL = current ? resolve({
            floor: { tier: d.effective.floor ?? 'T0', because: [] }, candidate: { tier: tierOf(optL.best.family, optL.best.effort), source: 'judge', confidence: dm.confidence, reason: 'legacy' },
            effortHint: optL.best.effort, heldEffort: heldL?.best.feasible ? heldL.best.effort : undefined, current: { tier: tierOf(current.family, current.effort), family: current.family, model: DEFAULT_LADDER.models[current.family], effort: current.effort },
            switchInput: { cache: { model: DEFAULT_LADDER.models[current.family], effort: current.effort, prefixTokens: prefix, lastRequestAt: warm ? d.at : null, ttlMs: HOUR, effortSharesCache: true }, now: d.at, votes: 1, requestsSinceSwitch: 5, verifiedSinceSwitch: false, sameTask: true, risk: d.risk?.effective ?? 'none', expectedOutputTokens: DEFAULT_PRIORS.outputPerStep[current.family], prices: ANTHROPIC, params: DEFAULT_PARAMS, requestsInPrompt: 0, remainingTable: REMAINING, switchesThisTask: 0, targetWarm: false },
          }) : null
          legacyNow = { family: routeL?.family ?? optL.best.family, effort: routeL?.effort ?? optL.best.effort }
        }
        after = { family: fam, effort: eff, owner: route?.owner ?? 'judge', why: `${choice.rule}${route?.check?.gate ? `; ${route.owner} (${route.check.gate})` : ''}; verdicts ${Object.entries(verdicts).map(([f, v]) => `${f}:${v ? `${v.model}/${v.effort}` : '-'}`).join(' ')}` }
      }
    }
    if (actual.owner === 'user-override' && !ov) after = { ...after, why: `${after.why}; the legacy run took this text as an override, auto does not` }
    prevAuto = { family: after.family, effort: after.effort }
    const label = (r) => `${r.family}/${r.effort}`
    bump(dist.before, label(actual)); bump(dist.after, label(after))

    // Requests of this prompt: from this decision to the next.
    const end = decs[i + 1]?.at ?? Infinity
    const mine = reqs.filter((r) => r.at >= d.at && r.at < end)
    let measured = 0
    for (const r of mine) measured += r.usd?.value ?? 0
    // priceOn: the same requests, priced on another route (a fixed trajectory; forecast scales the request count).
    const priceOn = (route, prevFam) => {
      let reprice = 0, forecast = 0
      mine.forEach((r, j) => {
        const m = r.usd?.value ?? 0
        if (!r.usage) { reprice += m; forecast += m; return }
        const oldFam = r.sent.model.replace('claude-', '').replace(/-5-5.*/, '')
        const oldE = r.sent.effort ?? 'medium'
        const outRatio = DEFAULT_PRIORS.effortOutput[route.effort] / DEFAULT_PRIORS.effortOutput[oldE]
        const stepRatio = DEFAULT_PRIORS.effortSteps[route.effort] / DEFAULT_PRIORS.effortSteps[oldE]
        let u = { ...r.usage, output: r.usage.output * (oldFam === route.family ? outRatio : outRatio * (DEFAULT_PRIORS.outputPerStep[route.family] / DEFAULT_PRIORS.outputPerStep[oldFam])) }
        // A model change rewrites the prefix once: the first request of the prompt on a new family reads nothing from cache.
        if (j === 0 && prevFam && prevFam !== route.family) u = { ...u, cacheWrite1h: u.cacheWrite1h + u.cacheRead, cacheRead: 0 }
        const c = usageUsd(u, ANTHROPIC.rates[route.family])
        reprice += c
        forecast += c * stepRatio
      })
      return { reprice, forecast }
    }
    const pa = priceOn(after, prevFamilyNew)
    const legacyRoute = legacyNow ?? { family: actual.family, effort: actual.effort }
    const pl = priceOn(legacyRoute, prevFamilyLegacy)
    const reprice = pa.reprice, forecast = pa.forecast
    if (mine.length) { prevFamilyNew = after.family; prevFamilyLegacy = legacyRoute.family }
    const comparable = !!legacyNow && !/^unknown|needs a verdict|no prompt text/.test(after.why)
    if (comparable) { fair.n += 1; fair.requests += mine.length; fair.measured += measured; fair.legacy += pl.reprice; fair.auto += pa.reprice; fair.legacyF += pl.forecast; fair.autoF += pa.forecast }
    totals.measured += measured; totals.reprice += reprice; totals.forecast += forecast; totals.requests += mine.length
    rows.push({ session: id.slice(0, 4), at: d.at, stage: d.stage ?? stageOfText(text), actual: label(actual), after: label(after), owner: actual.owner, method: actual.method, changed: label(actual) !== label(after), why: after.why, requests: mine.length, measured, reprice, forecast, legacyNow: `${legacyRoute.family}/${legacyRoute.effort}`, legacyReprice: pl.reprice, comparable, ...(showText ? { text: short(text) } : {}) })
  })
}

rows.sort((a, b) => a.at - b.at)
const hhmm = (t) => new Date(t).toISOString().slice(5, 16).replace('T', ' ')
console.log(`Policy auto trace. ${rows.length} prompt decisions in ${bySession.size} sessions. Verdicts asked now: ${asked}; prompts without a usable verdict: ${missing} (${staleRows.size} of them stale under A7); effortless calls the protocol makes: ${calls}. Ledger total in batch ${batch}: $${total(undefined, batch).toFixed(4)}.\n`)
console.log(['when (UTC)', 'ses', 'stage', 'ran (owner)', 'auto', 'reqs', ...(showText ? ['prompt'] : []), 'why'].join(' | '))
for (const r of rows) console.log([hhmm(r.at), r.session, r.stage, `${r.actual} (${r.owner})`, `${r.after}${r.changed ? ' *' : ''}`, r.requests, ...(showText ? [r.text] : []), r.why].join(' | '))
const eff = (o) => Object.entries(o).sort().map(([k, v]) => `${k} ${v}`).join(', ')
console.log(`\nRoutes before: ${eff(dist.before)}\nRoutes after:  ${eff(dist.after)}`)
const changed = rows.filter((r) => r.changed)
console.log(`\nPrompts whose route changes: ${changed.length} of ${rows.length}.`)
const usd = (n) => `$${n.toFixed(2)}`
console.log(`\nCost, three views (never added):\n  measured   ${usd(totals.measured)}   (${totals.requests} main requests; the API's own usage)\n  reprice    ${usd(totals.reprice)}   (same tokens on the new routes; a fixed trajectory, not a forecast)\n  forecast   ${usd(totals.forecast)}   (reprice with the request count scaled by the effort ratio; an estimate from uncontrolled priors)`)
console.log('\nOnly "measured" is a fact. The other two are what the arithmetic gives if effort did not, or did only by the repo\'s prior ratios, change the work. They are not realized savings.')
console.log(`\nFair comparison: today's legacy and auto on the same ${fair.n} prompts (${fair.requests} requests), same state, guards, cache and judge demand, priced the same way:\n  measured (what ran)        ${usd(fair.measured)}\n  legacy today, reprice      ${usd(fair.legacy)}   forecast ${usd(fair.legacyF)}\n  auto, reprice              ${usd(fair.auto)}   forecast ${usd(fair.autoF)}\n  auto vs legacy today       ${(100 * (fair.auto / fair.legacy - 1)).toFixed(1)}% reprice, ${(100 * (fair.autoF / fair.legacyF - 1)).toFixed(1)}% forecast (estimates, not measured)`)
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ totals, fair, dist, rows }, null, 1))
