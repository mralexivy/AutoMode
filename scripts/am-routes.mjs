// /automode:usage --routes: what the V4 router decided and sent, per request, from its own records,
// checked against the transcript. Measured values only; counterfactual estimates live in bench/replay.mjs.
//
//   node am-routes.mjs [sessionId | --all] [--json]
//
// Evidence levels, never mixed:
//   sent       the model and effort the hook passed on (request records)
//   confirmed  the same model and effort in the transcript's api-request record, which Claude Code
//              writes from the request parameters it sends
//   effective  not observable: thinking tokens per request are shown as indirect evidence only
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const DATA = process.env.CLAUDE_PLUGIN_DATA || path.join(CONFIG_DIR, 'plugins', 'data', 'automode')
const argv = process.argv.slice(2).filter((a) => a !== '--routes')
const asJson = argv.includes('--json')
const all = argv.includes('--all')
const sid = all ? null : argv.find((a) => !a.startsWith('--')) ?? process.env.CLAUDE_CODE_SESSION_ID ?? null

function lines(file) {
  if (!fs.existsSync(file)) return []
  const out = []
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)) } catch {} }
  return out
}

let recordFiles = []
try { recordFiles = fs.readdirSync(path.join(DATA, 'records')).filter((f) => /\.jsonl(\.1)?$/.test(f)).map((f) => path.join(DATA, 'records', f)) } catch {}
const records = [...lines(path.join(DATA, 'decisions.jsonl.1')), ...lines(path.join(DATA, 'decisions.jsonl')), ...recordFiles.flatMap(lines)]
const mine = records.filter((r) => all || !sid || r.sessionId === sid)
const requests = mine.filter((r) => r.kind === 'request')
const decisions = mine.filter((r) => r.kind === 'decision')

// ---------------------------------------------------------------- transcript confirmation
function transcriptFor(id) {
  const projects = path.join(CONFIG_DIR, 'projects')
  let dirs = []
  try { dirs = fs.readdirSync(projects) } catch { return null }
  for (const d of dirs) { const f = path.join(projects, d, `${id}.jsonl`); if (fs.existsSync(f)) return f }
  return null
}
function confirm(sessionId, reqs) {
  const file = transcriptFor(sessionId)
  if (!file) return { checked: 0, confirmed: 0, mismatched: 0, file: null }
  const sent = lines(file).filter((r) => r.type === 'api-request').map((r) => ({ model: r.params?.model ?? null, effort: r.params?.output_config?.effort ?? null }))
  const main = reqs.filter((r) => r.agentId === undefined)
  let confirmed = 0
  let mismatched = 0
  const n = Math.min(sent.length, main.length)
  // Records and api-request lines are both in request order; compare the overlapping tail.
  const a = sent.slice(sent.length - n)
  const b = main.slice(main.length - n)
  for (let i = 0; i < n; i++) {
    const want = b[i].sent
    if (a[i].model === String(want.model).replace(/\[1m\]$/, '') && (want.effort === null || a[i].effort === want.effort)) confirmed += 1
    else mismatched += 1
  }
  return { checked: n, confirmed, mismatched, file: path.basename(file) }
}

// ---------------------------------------------------------------- tables
const byRoute = {}
for (const r of requests) {
  const k = `${r.agentId ? 'worker ' : ''}${String(r.sent.model).replace(/^claude-/, '').replace(/\[1m\]$/, '')}/${r.sent.effort ?? '-'}`
  const c = (byRoute[k] ??= { requests: 0, effortChanged: 0, output: 0, thinking: 0, thinkingKnown: 0, usd: 0 })
  c.requests += 1
  if (r.effortApplied && r.app.effort !== r.sent.effort) c.effortChanged += 1
  c.output += r.usage?.output ?? 0
  if (r.answered?.thinking !== null && r.answered?.thinking !== undefined) { c.thinking += r.answered.thinking; c.thinkingKnown += 1 }
  c.usd += r.usd?.value ?? 0
}
const count = (xs, key) => xs.reduce((m, x) => { const k = key(x); if (k) m[k] = (m[k] ?? 0) + 1; return m }, {})
const owners = count(decisions, (d) => d.effective?.owner)
const gates = count(decisions, (d) => (d.effective?.check ? `${d.effective.check.verdict}${d.effective.check.gate ? `:${d.effective.check.gate}` : ''}` : null))
const escalations = count(mine.filter((r) => r.kind === 'escalation'), (r) => `${r.action} via ${r.via ?? 'switch'}`)
// Over-routing (stronger than the cheapest adequate route, by owner) and under-routing signals
// (escalations, redos, corrections and retries of the previous answer) are counted apart.
const overRouted = count(decisions.filter((d) => d.routing?.overRouted), (d) => d.routing.overRouted)
const underSignals = { escalations: mine.filter((r) => r.kind === 'escalation').length, correctionsOrRetries: mine.filter((r) => r.kind === 'signal' && r.underRouting).length, routedBelowAdequate: decisions.filter((d) => d.routing?.underRouted).length }
const spawns = count(mine.filter((r) => r.kind === 'spawn'), (r) => `${r.type} -> ${r.to}/${r.effort}`)
const modelCalls = mine.filter((r) => r.kind === 'model-call')
const events = count(mine.filter((r) => ['reuse', 'plan-mode', 'worker'].includes(r.kind)), (r) => r.kind)
// Policy auto and the legacy policy run side by side: under auto the legacy route is recorded as
// `compare`. The gap is reported, and a large one is an alert for a person to review. Nothing here changes a threshold.
const short = (model) => String(model).replace(/^claude-/, '').replace(/-5-5.*$/, '')
const routeOf = (d) => `${short(d.effective.model)}/${d.effective.effort}`
const promptDecisions = decisions.filter((d) => d.point === 'prompt' || d.point === undefined)
const compared = promptDecisions.filter((d) => d.compare)
const differ = compared.filter((d) => d.compare.route !== routeOf(d))
const high = (xs, f) => xs.filter((d) => /\/(xhigh|max)$/.test(f(d))).length
const failures = mine.filter((r) => r.kind === 'provider-failure')
const policy = {
  active: count(promptDecisions, (d) => d.policy ?? 'legacy'),
  compared: compared.length,
  differ: differ.length,
  xhighOrMax: { active: high(promptDecisions, routeOf), other: high(compared, (d) => d.compare.route) },
  inadequate: promptDecisions.filter((d) => d.inadequate).length,
  providerFailures: { byClass: count(failures, (r) => r.class ?? 'unclassified'), breaker: count(failures, (r) => r.breaker ?? null), classified: count(mine.filter((r) => r.kind === 'provider-error'), (r) => `${r.class} -> ${r.action}`) },
  interruptsUndone: mine.filter((r) => r.kind === 'interrupt' && r.undone).length,
  overrides: count(promptDecisions, (d) => d.override?.source),
  transitions: count(promptDecisions, (d) => d.transition),
  // Policy auto: the judge calls by kind, the fallbacks, and effort changes that waited for new input.
  auto: {
    judgeCalls: Object.fromEntries(Object.entries(count(modelCalls, (m) => m.purpose ?? 'unknown')).map(([k, v]) => [k, { n: v, failed: modelCalls.filter((m) => (m.purpose ?? 'unknown') === k && !m.ok).length, usd: modelCalls.filter((m) => (m.purpose ?? 'unknown') === k).reduce((a, m) => a + (m.usd?.value ?? 0), 0) }])),
    fallbacks: promptDecisions.filter((d) => d.auto?.fallback).length,
    shortcuts: promptDecisions.filter((d) => d.method === 'continuation' && d.auto).length,
    cachedVerdicts: promptDecisions.filter((d) => d.auto?.steps?.some((x) => String(x).startsWith('verdict cache'))).length,
    deferredEffort: requests.filter((r) => r.application?.deferred).length,
    rules: count(promptDecisions.filter((d) => d.auto), (d) => d.auto.rule),
  },
  alert: compared.length >= 10 && differ.length / compared.length >= 0.3 ? `the other policy differs on ${differ.length} of ${compared.length} prompts: review the traces (node bench/policy-trace.mjs) before changing any default` : null,
}
const sessions = [...new Set(requests.map((r) => r.sessionId))]
const confirmations = sessions.map((s) => ({ sessionId: s, ...confirm(s, requests.filter((r) => r.sessionId === s)) }))
const last = decisions[decisions.length - 1]

const report = {
  scope: all ? 'all sessions' : sid ? `session ${sid}` : 'all sessions (no session id)',
  recordsFile: path.join(DATA, 'records'),
  requests: requests.length,
  byRoute,
  confirmation: confirmations,
  owners, gates, escalations, events, overRouted, underSignals, spawns,
  modelCalls: { n: modelCalls.length, failed: modelCalls.filter((m) => !m.ok).length, usd: modelCalls.reduce((a, m) => a + (m.usd?.value ?? 0), 0) },
  lastDecision: last ? { route: `${last.effective.model}/${last.effective.effort}`, owner: last.effective.owner, reason: last.effective.reason, optimizer: last.optimizer ?? null, strategy: last.strategy ?? null, economics: last.effective.check?.economics ?? null, check: last.effective.check?.reason ?? null } : null,
  triggers: count(decisions.filter((d) => d.trigger), (d) => d.trigger.event),
  policy,
  basis: 'measured (request usage priced at the record time price row)',
}

if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0) }

const n = (x) => x.toLocaleString('en-US')
const out = []
out.push(`AutoMode routes, ${report.scope}`)
out.push(`Records: ${report.recordsFile}`)
if (!requests.length) { out.push('No request records. Routes are recorded while the AutoMode row is active and the router is in shadow or auto mode.'); console.log(out.join('\n')); process.exit(0) }
out.push('')
out.push('route (sent)                requests  effort set  output     thinking (known)   USD measured')
for (const [k, c] of Object.entries(byRoute).sort((a, b) => b[1].usd - a[1].usd))
  out.push(`${k.padEnd(27)} ${String(c.requests).padStart(8)}  ${String(c.effortChanged).padStart(10)}  ${n(c.output).padStart(9)}  ${`${n(c.thinking)} (${c.thinkingKnown})`.padStart(17)}  $${c.usd.toFixed(4)}`)
out.push('')
for (const c of confirmations) out.push(c.file ? `Transcript check ${c.sessionId.slice(0, 8)}: ${c.confirmed}/${c.checked} main requests match the sent model and effort${c.mismatched ? `, ${c.mismatched} differ` : ''}.` : `Transcript check ${c.sessionId.slice(0, 8)}: transcript not found.`)
out.push('Effective effort is not observable; thinking tokens are indirect evidence only.')
out.push('')
out.push(`Owners: ${Object.entries(owners).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`)
out.push(`Switch checks: ${Object.entries(gates).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`)
out.push(`Escalations: ${Object.entries(escalations).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`)
out.push(`Other: ${Object.entries(events).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`)
out.push(`Triggers: ${Object.entries(report.triggers).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`)
out.push(`Over-routing (stronger than the cheapest adequate, by owner): ${Object.entries(overRouted).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`)
out.push(`Under-routing signals: ${underSignals.escalations} escalations, ${underSignals.correctionsOrRetries} corrections or retries, ${underSignals.routedBelowAdequate} routes below adequate`)
out.push(`Policy: ${Object.entries(policy.active).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; the other policy is recorded beside it on ${policy.compared} prompts and differs on ${policy.differ}. xhigh or max: ${policy.xhighOrMax.active} applied, ${policy.xhighOrMax.other} in the other policy.`)
out.push(`Inadequate routes (no available model met the need): ${policy.inadequate}. Provider failures: ${Object.entries(policy.providerFailures.byClass).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}${Object.keys(policy.providerFailures.breaker).length ? ` (breaker: ${Object.entries(policy.providerFailures.breaker).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}; classified by Claude Code: ${Object.entries(policy.providerFailures.classified).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; interrupts undone ${policy.interruptsUndone}.`)
out.push(`Commands: ${Object.entries(policy.overrides).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}. Short-message classes: ${Object.entries(policy.transitions).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`)
if (Object.keys(policy.auto.judgeCalls).length) out.push(`Judge calls: ${Object.entries(policy.auto.judgeCalls).map(([k, v]) => `${k} ${v.n} (${v.failed} failed, $${v.usd.toFixed(4)})`).join(', ')}. Auto: ${policy.auto.fallbacks} fallbacks, ${policy.auto.shortcuts} kept by the short-message shortcut, ${policy.auto.cachedVerdicts} from the verdict cache, ${policy.auto.deferredEffort} effort changes that waited for new input. Rules: ${Object.entries(policy.auto.rules).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}.`)
if (policy.alert) out.push(`ALERT (manual review only, nothing changes by itself): ${policy.alert}`)
out.push(`Subagent routing: ${Object.entries(spawns).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`)
out.push(`Router model calls (judge, compaction): ${report.modelCalls.n}, failed ${report.modelCalls.failed}, $${report.modelCalls.usd.toFixed(4)} measured`)
if (report.lastDecision) {
  const l = report.lastDecision
  out.push('')
  out.push(`Last decision: ${l.route} (${l.owner}: ${l.reason})`)
  if (l.optimizer) out.push(`  optimizer (${l.optimizer.basis}; capability bands are assumptions): need ${l.optimizer.required}, accepts ${(l.optimizer.acceptable ?? []).join('/')}; ${l.optimizer.top.map((t) => `${t.route} ${t.adequacy ?? ''} $${t.usd}${t.feasible ? '' : ' x'}`).join(' | ')}`)
  if (l.economics) out.push(`  switch economics (${l.economics.basis}): penalty $${l.economics.writePenaltyUsd}, remaining p25/median/p75 ${l.economics.remaining.p25}/${l.economics.remaining.median}/${l.economics.remaining.p75}, saving p25 $${l.economics.savingUsd.p25}; ${l.check}`)
  if (l.strategy?.estimates?.length) out.push(`  strategy ${l.strategy.chosen} (${l.strategy.basis}): ${l.strategy.estimates.map((e) => `${e.strategy} $${e.p50}-${e.p75}`).join(' | ')}`)
}
console.log(out.join('\n'))
