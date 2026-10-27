#!/usr/bin/env node
// 30-day Claude Code spend audit from local records. $0: it reads transcripts and router records and
// makes no model call. Three cost views per session:
//   cli        - the CLI's own cost-state total (what /cost and /usage report), labeled "cli-recorded"
//   calculated - usage tokens x list price per exact model id, labeled "calculated"
//   missing    - requests without final usage (stop_reason null) or with no price row
// Nothing here is billed cost: Anthropic Console billing is not readable from this machine.
//
// Usage: node bench/spend-audit.mjs [--days 30] [--end ISO] [--roots a,b] [--out FILE] [--json]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseLines, requestsOf, loadSubagents, readRecords, quantile } from './lib/transcripts.mjs'

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const DAYS = Number(opt('--days', 30))
const END = opt('--end') ? Date.parse(opt('--end')) : Date.now()
const START = END - DAYS * 86_400_000
const ROOTS = opt('--roots', [path.join(os.homedir(), '.claude/projects'), path.join(os.homedir(), '.claude-ectest/projects')].join(',')).split(',')
const DATA = path.join(os.homedir(), '.claude/plugins/data/automode')

// List price per exact model id, USD per million tokens. Inputs and outputs: Anthropic model table (claude-api
// skill, cached 2026-10-06). Cache-read multiples: least squares of the CLI's own cost-state costs on its
// token counts (2026-10-26): 0.05 for Opus 5.5 and Sonnet 5.5, 0.1 for Opus 5 and Sonnet 4.6. reconcile() checks each row against the
// CLI's own cost and prints the ratio, so a wrong row shows up as a ratio away from 1.
export const MODEL_RATES = [
  { re: /opus-5-5/, input: 4, output: 20, readX: 0.05 },
  { re: /opus-5(?!-5)/, input: 5, output: 25, readX: 0.1 },
  { re: /opus-4/, input: 5, output: 25, readX: 0.1 },
  { re: /sonnet-5-5/, input: 2, output: 10, readX: 0.05 },
  { re: /sonnet-5(?!-5)/, input: 2, output: 10, readX: 0.1 },
  { re: /sonnet-4/, input: 3, output: 15, readX: 0.1 },
  { re: /haiku-5-5/, input: 0.1, output: 0.5, readX: 0.1, long: { above: 100_000, x: 5 } },
  { re: /haiku-4/, input: 1, output: 5, readX: 0.1 },
]
export const rateOf = (model) => MODEL_RATES.find((r) => r.re.test(model ?? '')) ?? null

// costOf splits one request's cost into token categories.
export function costOf(t, model) {
  const r = rateOf(model)
  if (!r) return null
  const prompt = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h
  const m = r.long && prompt > r.long.above ? r.long.x : 1
  const i = r.input * m / 1e6
  return { input: t.input * i, write5m: t.cacheWrite5m * i * 1.25, write1h: t.cacheWrite1h * i * 2, read: t.cacheRead * i * r.readX, output: t.output * r.output * m / 1e6 }
}
export const sum = (c) => c ? c.input + c.write5m + c.write1h + c.read + c.output : 0

export const familyOf = (m) => /opus/.test(m ?? '') ? 'opus' : /sonnet/.test(m ?? '') ? 'sonnet' : /haiku/.test(m ?? '') ? 'haiku' : 'other'

// workloadOf separates normal engineering from AutoMode work and benchmark runs.
export function workloadOf(root, project) {
  if (/claude-ectest/.test(root) || /^-private-tmp-|scratchpad/.test(project)) return 'benchmark'
  if (/automode/.test(project)) return 'automode-dev'
  return 'engineering'
}

// activityOf infers one request's activity from the tools it called. Labeled inferred.
export function activityOf(tools, planMode) {
  if (planMode) return 'planning'
  if (tools.some((t) => t === 'Edit' || t === 'Write' || t === 'NotebookEdit')) return 'implementation'
  if (tools.includes('Bash:test')) return 'testing'
  if (tools.includes('Agent') || tools.includes('Task') || tools.includes('Workflow')) return 'delegation'
  if (tools.some((t) => ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'].includes(t) || /^mcp__/.test(t))) return 'exploration'
  if (tools.includes('Bash')) return 'shell'
  return 'answer'
}
const TEST_CMD = /\b(go test|make (test|check)|npm (run )?test|node --test|pytest|jest|vitest|claude plugin test)\b/

// toolsByRequest collects tool names per requestId (a streamed response spreads blocks over lines).
function toolsByRequest(L) {
  const by = new Map()
  for (const r of L) {
    if (r.type !== 'assistant' || !r.requestId || !Array.isArray(r.message?.content)) continue
    const list = by.get(r.requestId) ?? []
    for (const b of r.message.content) {
      if (b?.type !== 'tool_use') continue
      list.push(b.name === 'Bash' && TEST_CMD.test(String(b.input?.command ?? '')) ? 'Bash:test' : b.name)
      if (b.name === 'Read' && b.input?.file_path) list.push(`read:${b.input.file_path}`)
    }
    by.set(r.requestId, list)
  }
  return by
}

const lastCostState = (L) => { let c = null; for (const r of L) if (r.type === 'cost-state') c = r; return c }

// cliSegments returns the CLI's own totals, one per process (cost-state is cumulative per process and
// restarts with a new startTime when a session is resumed). These are the numbers /cost and /usage show.
export function cliSegments(L) {
  const by = new Map()
  for (const r of L) if (r.type === 'cost-state' && r.startTime) by.set(r.startTime, r)
  return [...by.values()]
}

// sessionsOf yields one entry per session file in the window, with all its requests (main, sidechain,
// subagents), each priced.
// A resumed or forked session copies earlier lines into a new file, so one requestId can appear in
// several files. seen keeps each request once, in the first file read.
export function* sessionsOf(roots, start, end, seen = new Set()) {
  for (const root of roots) {
    let projects = []
    try { projects = fs.readdirSync(root) } catch { continue }
    for (const project of projects) {
      let files = []
      try { files = fs.readdirSync(path.join(root, project)).filter((f) => f.endsWith('.jsonl')) } catch { continue }
      for (const f of files) {
        const file = path.join(root, project, f)
        let st
        try { st = fs.statSync(file) } catch { continue }
        if (st.mtimeMs < start) continue
        const L = parseLines(file)
        const tools = toolsByRequest(L)
        let plan = false
        const planAt = new Map()
        for (const r of L) {
          if (r.type === 'user' && r.permissionMode) plan = r.permissionMode === 'plan'
          if (r.type === 'assistant' && r.requestId && !planAt.has(r.requestId)) planAt.set(r.requestId, plan)
        }
        const reqs = [...requestsOf(L).values()].map(({ line, ...q }) => ({ ...q, agent: q.sidechain ? 'sidechain' : 'main', tools: tools.get(q.requestId) ?? [], plan: planAt.get(q.requestId) ?? false }))
        for (const s of loadSubagents(file)) reqs.push({ ...s, agent: s.agentType, tools: [], plan: false })
        const inWin = reqs.filter((q) => q.at >= start && q.at < end && !seen.has(q.requestId))
        for (const q of inWin) seen.add(q.requestId)
        if (!inWin.length) continue
        for (const q of inWin) { q.cost = costOf(q.tokens, q.model); q.usd = sum(q.cost) }
        const allInWindow = inWin.length === reqs.length
        yield { root, project, sessionId: path.basename(f, '.jsonl'), file, workload: workloadOf(root, project), requests: inWin, allInWindow, cli: lastCostState(L), segments: cliSegments(L) }
      }
    }
  }
}

// expiryRewrites finds main-thread cache writes that follow an idle gap longer than the cache lifetime:
// the prefix had expired, so the request paid to write it again.
export function expiryRewrites(main) {
  const out = []
  const sorted = [...main].sort((a, b) => a.at - b.at)
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i]
    const ttl = b.tokens.cacheWrite1h > b.tokens.cacheWrite5m ? 3_600_000 : 300_000
    const gap = b.at - a.at
    const write = b.tokens.cacheWrite5m + b.tokens.cacheWrite1h
    if (gap > ttl && write > 0.5 * (b.tokens.cacheRead + write) && write > 20_000) out.push({ at: b.at, gapMin: Math.round(gap / 60000), tokens: write, usd: (b.cost?.write5m ?? 0) + (b.cost?.write1h ?? 0), model: b.model })
  }
  return out
}

const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v)
const r2 = (x) => Math.round(x * 100) / 100

export function audit(roots = ROOTS, start = START, end = END) {
  const by = Object.fromEntries(['workload', 'project', 'model', 'family', 'effort', 'agent', 'activity', 'day', 'familyAgent'].map((k) => [k, new Map()]))
  const tokenCat = { input: 0, write5m: 0, write1h: 0, read: 0, output: 0 }
  const sessions = []
  const recon = new Map()
  let total = 0, requests = 0, incomplete = 0, unpriced = 0
  // CLI-recorded view: process segments that started inside the window. Straddling segments are counted apart.
  const cli = { usd: 0, straddleUsd: 0, segments: 0, coveredCalc: 0, uncoveredCalc: 0, uncoveredByModel: new Map(), byModel: new Map(), byWorkload: new Map(), tokens: new Map() }
  const ctx = { opus: [], sonnet: [], haiku: [], other: [] }
  for (const s of sessionsOf(roots, start, end)) {
    const main = s.requests.filter((q) => q.agent === 'main')
    for (const q of s.requests) { q.cost = q.cost ?? null }
    const sUsd = s.requests.reduce((a, q) => a + q.usd, 0)
    const covered = s.segments.some((seg) => seg.startTime >= start && seg.startTime < end)
    if (covered) cli.coveredCalc += sUsd; else { cli.uncoveredCalc += sUsd; add(cli.uncoveredByModel, 'all', sUsd); for (const q of s.requests) add(cli.uncoveredByModel, q.model, q.usd) }
    for (const seg of s.segments) {
      const usd = seg.totalCostUSD ?? 0
      if (seg.startTime < start || seg.startTime >= end) { if (seg.startTime < start) cli.straddleUsd += usd; continue }
      cli.usd += usd; cli.segments += 1; add(cli.byWorkload, s.workload, usd)
      for (const [m, u] of Object.entries(seg.modelUsage ?? {})) {
        const k = m.replace(/\[1m\]$/, '')
        add(cli.byModel, k, u.costUSD ?? 0)
        const t = cli.tokens.get(k) ?? { output: 0, cacheRead: 0, cacheWrite: 0, input: 0 }
        t.output += u.outputTokens ?? 0; t.cacheRead += u.cacheReadInputTokens ?? 0; t.cacheWrite += u.cacheCreationInputTokens ?? 0; t.input += u.inputTokens ?? 0
        cli.tokens.set(k, t)
      }
    }
    const fam = new Map(), cat = { input: 0, write5m: 0, write1h: 0, read: 0, output: 0 }
    const reads = new Map()
    for (const q of s.requests) {
      requests += 1
      if (q.incomplete) incomplete += 1
      if (!q.cost) { unpriced += 1; continue }
      total += q.usd
      const f = familyOf(q.model)
      const agentKind = q.agent === 'main' ? 'main' : q.agent === 'sidechain' ? 'sidechain' : /^Explore$/.test(q.agent) ? 'Explore' : /general-purpose/.test(q.agent) ? 'general-purpose' : /^automode:/.test(q.agent) ? q.agent : q.role === 'workflow' ? 'workflow' : 'other-subagent'
      add(by.workload, s.workload, q.usd); add(by.project, `${s.workload}|${s.project}`, q.usd); add(by.model, q.model, q.usd); add(by.family, f, q.usd)
      add(by.effort, `${f}/${q.appEffort ?? 'unrecorded'}`, q.usd); add(by.agent, agentKind, q.usd); add(by.familyAgent, `${f}|${agentKind}`, q.usd)
      add(by.activity, q.agent === 'main' ? activityOf(q.tools, q.plan) : 'subagent', q.usd)
      add(by.day, new Date(q.at).toISOString().slice(0, 10), q.usd)
      add(fam, f, q.usd)
      for (const k of Object.keys(cat)) { cat[k] += q.cost[k]; tokenCat[k] += q.cost[k] }
      ctx[f]?.push(q.tokens.input + q.tokens.cacheRead + q.tokens.cacheWrite5m + q.tokens.cacheWrite1h)
      for (const t of q.tools) if (t.startsWith('read:')) add(reads, t.slice(5), 1)
    }
    const rewrites = expiryRewrites(main)
    const subUsd = s.requests.filter((q) => q.agent !== 'main' && q.agent !== 'sidechain').reduce((a, q) => a + q.usd, 0)
    const opusSubUsd = s.requests.filter((q) => q.agent !== 'main' && q.agent !== 'sidechain' && familyOf(q.model) === 'opus').reduce((a, q) => a + q.usd, 0)
    const tests = main.filter((q) => q.tools.includes('Bash:test')).length
    const repeatedReads = [...reads.values()].filter((n) => n > 2).reduce((a, n) => a + n - 1, 0)
    const at = s.requests.map((q) => q.at)
    sessions.push({
      workload: s.workload, project: s.project, sessionId: s.sessionId, usd: r2(sUsd), requests: s.requests.length, main: main.length,
      durationMin: Math.round((Math.max(...at) - Math.min(...at)) / 60000), families: Object.fromEntries([...fam].map(([k, v]) => [k, r2(v)])),
      tokenUsd: Object.fromEntries(Object.entries(cat).map(([k, v]) => [k, r2(v)])), subagentUsd: r2(subUsd), opusSubagentUsd: r2(opusSubUsd),
      expiryRewrites: rewrites.length, expiryRewriteUsd: r2(rewrites.reduce((a, x) => a + x.usd, 0)), testRuns: tests, repeatedReads,
      mainContextP50: quantile(main.map((q) => q.tokens.input + q.tokens.cacheRead + q.tokens.cacheWrite5m + q.tokens.cacheWrite1h), 0.5),
      incomplete: s.requests.filter((q) => q.incomplete).length,
    })
    // Reconcile only sessions whose whole history is inside the window, against the CLI's cumulative total.
    if (s.allInWindow && s.cli?.modelUsage) {
      for (const [m, u] of Object.entries(s.cli.modelUsage)) {
        const mine = s.requests.filter((q) => q.model === m.replace(/\[1m\]$/, '').replace(/@.*$/, '') || q.model === m)
        const calc = mine.reduce((a, q) => a + q.usd, 0)
        const key = m.replace(/\[1m\]$/, '')
        const e = recon.get(key) ?? { cli: 0, calc: 0, sessions: 0 }
        e.cli += u.costUSD ?? 0; e.calc += calc; e.sessions += 1
        recon.set(key, e)
      }
    }
  }
  const records = readRecords(DATA)
  const routed = new Set(records.filter((r) => r.kind === 'decision').map((r) => r.sessionId))
  const judge = records.filter((r) => r.kind === 'model-call').reduce((a, r) => a + (r.usd?.value ?? 0), 0)
  const routedUsd = sessions.filter((s) => routed.has(s.sessionId)).reduce((a, s) => a + s.usd, 0)
  const tab = (m, of = total) => Object.fromEntries([...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, { usd: r2(v), pct: r2((100 * v) / of) }]))
  sessions.sort((a, b) => b.usd - a.usd)
  const topShare = (n) => r2((100 * sessions.slice(0, n).reduce((a, s) => a + s.usd, 0)) / total)
  return {
    window: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone, days: DAYS },
    basis: 'calculated (usage x list price per model id); not billed', roots,
    cli: { basis: 'cli-recorded (cost-state, the /cost and /usage source); not billed', usd: r2(cli.usd), segments: cli.segments, straddlingBeforeWindowUsd: r2(cli.straddleUsd),
      coveredCalculatedUsd: r2(cli.coveredCalc), uncoveredCalculatedUsd: r2(cli.uncoveredCalc),
      // Sessions without any cost-state (older CLI builds) are scaled by the covered sessions' CLI/calculated ratio.
      scale: cli.coveredCalc ? Math.round((cli.usd / cli.coveredCalc) * 1000) / 1000 : null,
      reconstructedUsd: r2(cli.usd + (cli.coveredCalc ? cli.uncoveredCalc * (cli.usd / cli.coveredCalc) : cli.uncoveredCalc)),
      uncoveredByModel: tab(cli.uncoveredByModel, cli.uncoveredCalc),
      byModel: tab(cli.byModel, cli.usd), byWorkload: tab(cli.byWorkload, cli.usd), tokens: Object.fromEntries(cli.tokens) },
    total: r2(total), requests, sessions: sessions.length, incomplete, unpriced,
    byWorkload: tab(by.workload), byFamily: tab(by.family), byModel: tab(by.model), byEffort: tab(by.effort), byAgent: tab(by.agent), byFamilyAgent: tab(by.familyAgent),
    byActivity: tab(by.activity), byDay: Object.fromEntries([...by.day].sort().map(([k, v]) => [k, r2(v)])), byProject: tab(by.project),
    byTokenCategory: Object.fromEntries(Object.entries(tokenCat).map(([k, v]) => [k, { usd: r2(v), pct: r2((100 * v) / total) }])),
    contextTokens: Object.fromEntries(Object.entries(ctx).filter(([, v]) => v.length).map(([k, v]) => [k, { n: v.length, p50: quantile(v, 0.5), p90: quantile(v, 0.9) }])),
    concentration: { top5: topShare(5), top10: topShare(10), top20: topShare(20) },
    automode: { routedSessions: routed.size, routedUsd: r2(routedUsd), routedPct: r2((100 * routedUsd) / total), routerCallsUsd: r2(judge) },
    reconcile: Object.fromEntries([...recon].map(([m, e]) => [m, { cli: r2(e.cli), calc: r2(e.calc), ratio: e.calc ? Math.round((e.cli / e.calc) * 1000) / 1000 : null, sessions: e.sessions }])),
    topSessions: sessions.slice(0, 25),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = audit()
  const file = opt('--out')
  if (file) fs.writeFileSync(file, JSON.stringify(out, null, 2))
  if (args.includes('--json')) console.log(JSON.stringify(out, null, 2))
  else {
    const { topSessions, byProject, byDay, ...head } = out
    console.log(JSON.stringify(head, null, 1))
    console.log('top sessions'); for (const s of topSessions.slice(0, 20)) console.log(JSON.stringify(s))
    console.log('projects'); for (const [k, v] of Object.entries(byProject).slice(0, 15)) console.log(k, v)
  }
}
