// /automode:usage --kpi: cost per accepted task, from the router's own records. $0, read-only, no prompt text.
//
//   node am-kpi.mjs [sessionId | --all] [--json]
//
// Definitions (fixed here, so a number means the same thing every time):
//   task       a task envelope (taskId) in the records. Requests carry it; judge and compaction calls are attributed to
//              the task whose time span holds them.
//   cost       every measured request of the task (main thread, subagents, workers, reviewers) plus its judge and
//              compaction calls, at the price row recorded with each request.
//   accepted   the person's next prompt after the task's last turn moved on (it neither corrected nor retried), and no
//              check of the task was left failing. A task with no next prompt has an unknown outcome: its cost counts
//              in the spend, but it is in neither the numerator nor the denominator of the KPI.
//   KPI        spend on tasks with a known outcome / accepted tasks. A rework-heavy route pays for its failures here.
// Secondary: model and effort by stage, cache reads and writes, model switches, Opus spend by main thread, subagents and
// consults, rework rate, required-review completion, routing overhead and turn latency.
// Baselines reprice the same main requests on one fixed model: a fixed trajectory (same tokens, same steps), labeled as
// an estimate. They say what the same work would have cost on that model, not what it would have achieved.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// USD per million tokens, the Anthropic row of hooks/lib/prices.ts (a test keeps them equal).
export const RATES = {
  opus: { input: 4, output: 20, cacheReadX: 0.05 },
  sonnet: { input: 2, output: 10, cacheReadX: 0.05 },
  haiku: { input: 0.1, output: 0.5, cacheReadX: 0.1, longContext: { above: 100_000, multiplier: 5 } },
}
export const familyOf = (m) => (/haiku/i.test(m) ? 'haiku' : /sonnet/i.test(m) ? 'sonnet' : /opus/i.test(m) ? 'opus' : null)
export function usdAt(u, family) {
  const r0 = RATES[family]
  const prompt = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h
  const m = r0.longContext && prompt > r0.longContext.above ? r0.longContext.multiplier : 1
  const r = { input: r0.input * m, output: r0.output * m }
  return (u.input * r.input + u.output * r.output + u.cacheRead * r.input * r0.cacheReadX + u.cacheWrite5m * r.input * 1.25 + u.cacheWrite1h * r.input * 2) / 1e6
}

const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : null }
const round = (n) => Math.round(n * 10_000) / 10_000

export function kpi(records) {
  const bySession = new Map()
  for (const r of records) { if (!r.sessionId) continue; (bySession.get(r.sessionId) ?? bySession.set(r.sessionId, []).get(r.sessionId)).push(r) }
  const tasks = new Map()
  const task = (id, sid) => tasks.get(id) ?? tasks.set(id, { id, sessionId: sid, policy: null, usd: 0, requests: 0, signals: [], checks: { pass: 0, fail: 0, lastFail: false }, start: Infinity, reviewRequired: false, reviewed: false }).get(id)
  const stageRoutes = {}
  const cache = { read: 0, write: 0 }
  const opus = { main: 0, subagent: 0 }
  let switches = 0
  let consults = 0
  const judge = { n: 0, usd: 0, ms: [] }
  const latency = []
  let agentRecords = false
  const baselines = { sonnet: 0, opus: 0, measuredMain: 0 }
  for (const [sid, rs] of bySession) {
    rs.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    let lastMain = null
    for (const r of rs) {
      const tid = r.taskId && r.taskId !== 'none' ? r.taskId : null
      if (r.kind === 'decision' && tid) {
        const t = task(tid, sid)
        t.start = Math.min(t.start, r.at ?? Infinity)
        t.policy ??= r.policy ?? 'legacy'
        if (r.risk?.reviewRequired) t.reviewRequired = true
        if (r.point === 'prompt' && r.stage) {
          const k = `${r.stage} ${familyOf(r.effective?.model ?? '') ?? '?'}/${r.effective?.effort ?? '?'}`
          stageRoutes[k] = (stageRoutes[k] ?? 0) + 1
        }
      }
      if (r.kind === 'request' && r.usage) {
        const fam = familyOf(r.answered?.model ?? r.sent?.model ?? '')
        const usd = r.usd?.value ?? 0
        cache.read += r.usage.cacheRead
        cache.write += r.usage.cacheWrite5m + r.usage.cacheWrite1h
        if (tid) { const t = task(tid, sid); t.usd += usd; t.requests += 1; t.start = Math.min(t.start, r.at ?? Infinity) }
        if (fam === 'opus') { if (r.agentId) opus.subagent += usd; else opus.main += usd }
        if (!r.agentId) {
          if (lastMain && lastMain !== fam) switches += 1
          lastMain = fam
          baselines.measuredMain += usd
          baselines.sonnet += usdAt(r.usage, 'sonnet')
          baselines.opus += usdAt(r.usage, 'opus')
        }
      }
      if (r.kind === 'signal' && tid) task(tid, sid).signals.push(r.next)
      if (r.kind === 'outcome' && tid) {
        const t = task(tid, sid)
        t.checks.pass += r.checks?.pass ?? 0
        t.checks.fail += r.checks?.fail ?? 0
        t.checks.lastFail = (r.checks?.fail ?? 0) > 0 && !(r.checks?.pass > 0)
        if (typeof r.durationMs === 'number') latency.push(r.durationMs)
      }
      if (r.kind === 'escalation' && r.action === 'consult-opus') consults += 1
      if ((r.kind === 'spawn' || r.kind === 'agent') && /review/i.test(String(r.type ?? '')) && tid) task(tid, sid).reviewed = true
      if (r.kind === 'agent') agentRecords = true
      if (r.kind === 'model-call') {
        if (r.purpose === 'judge') { judge.n += 1; judge.usd += r.usd?.value ?? 0; if (typeof r.ms === 'number') judge.ms.push(r.ms) }
        // A router call belongs to the latest task that had started by then.
        const owner = [...tasks.values()].filter((t) => t.sessionId === sid && t.start <= (r.at ?? 0)).sort((a, b) => b.start - a.start)[0]
        if (owner) owner.usd += r.usd?.value ?? 0
      }
    }
  }
  const byPolicy = {}
  for (const t of tasks.values()) {
    const p = (byPolicy[t.policy ?? 'legacy'] ??= { tasks: 0, known: 0, accepted: 0, reworked: 0, spend: 0, knownSpend: 0, reviewRequired: 0, reviewed: 0 })
    p.tasks += 1
    p.spend += t.usd
    if (t.reviewRequired) { p.reviewRequired += 1; if (t.reviewed) p.reviewed += 1 }
    if (t.signals.some((s) => s !== 'moved-on')) p.reworked += 1
    if (!t.signals.length) continue
    p.known += 1
    p.knownSpend += t.usd
    if (t.signals.at(-1) === 'moved-on' && !t.checks.lastFail) p.accepted += 1
  }
  for (const p of Object.values(byPolicy)) {
    p.costPerAcceptedTask = p.accepted ? round(p.knownSpend / p.accepted) : null
    p.acceptanceRate = p.known ? round(p.accepted / p.known) : null
    p.reworkRate = p.tasks ? round(p.reworked / p.tasks) : null
    p.spend = round(p.spend)
    p.knownSpend = round(p.knownSpend)
  }
  return {
    byPolicy,
    stageRoutes,
    cacheTokens: cache,
    modelSwitches: switches,
    opusUsd: { main: round(opus.main), subagent: round(opus.subagent), consults },
    routingOverhead: { judgeCalls: judge.n, judgeUsd: round(judge.usd), judgeMsP50: q(judge.ms, 0.5) },
    turnLatencyMs: { n: latency.length, p50: q(latency, 0.5), p90: q(latency, 0.9) },
    reviewCompletionKnown: agentRecords, // older records hold no agent spawns: review completion is unknown there
    baselines: { basis: 'fixed-trajectory reprice of the measured main requests (estimate)', measured: round(baselines.measuredMain), allSonnet: round(baselines.sonnet), allOpus: round(baselines.opus) },
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv.includes('--kpi')) {
  const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  const DATA = process.env.CLAUDE_PLUGIN_DATA || path.join(CONFIG_DIR, 'plugins', 'data', 'automode')
  const argv = process.argv.slice(2).filter((a) => a !== '--kpi')
  const all = argv.includes('--all')
  const sid = all ? null : argv.find((a) => !a.startsWith('--')) ?? process.env.CLAUDE_CODE_SESSION_ID ?? null
  const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } }) : [])
  let files = []
  try { files = fs.readdirSync(path.join(DATA, 'records')).filter((f) => /\.jsonl(\.1)?$/.test(f)).map((f) => path.join(DATA, 'records', f)) } catch {}
  const records = files.flatMap(lines).filter((r) => all || !sid || r.sessionId === sid)
  const out = kpi(records)
  if (argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0) }
  console.log(`AutoMode KPI, ${all || !sid ? 'all sessions' : `session ${sid}`}. Cost per accepted task = spend on tasks with a known outcome / accepted tasks.`)
  for (const [p, v] of Object.entries(out.byPolicy)) console.log(`  ${p}: ${v.tasks} tasks, ${v.known} with a known outcome, ${v.accepted} accepted (rate ${v.acceptanceRate ?? '-'}), rework rate ${v.reworkRate ?? '-'}, cost per accepted task ${v.costPerAcceptedTask === null ? '-' : `$${v.costPerAcceptedTask}`}, required reviews done ${out.reviewCompletionKnown ? `${v.reviewed}/${v.reviewRequired}` : `unknown (${v.reviewRequired} required; agent spawns are recorded from this version on)`}`)
  console.log(`  Model switches ${out.modelSwitches}. Opus: main $${out.opusUsd.main}, subagents $${out.opusUsd.subagent}, consults ${out.opusUsd.consults}. Router: ${out.routingOverhead.judgeCalls} judge calls, $${out.routingOverhead.judgeUsd}, p50 ${out.routingOverhead.judgeMsP50 ?? '-'} ms. Turn latency p50 ${out.turnLatencyMs.p50 ?? '-'} ms (n=${out.turnLatencyMs.n}).`)
  console.log(`  Baselines (${out.baselines.basis}): measured $${out.baselines.measured}, all on Sonnet $${out.baselines.allSonnet}, all on Opus $${out.baselines.allOpus}.`)
  console.log(`  Stage x route: ${Object.entries(out.stageRoutes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none (stages are recorded from policy v4.1 on)'}`)
}
