#!/usr/bin/env node
// Accounting gate (G3): price each recorded benchmark session from its transcripts with the replay's
// pricer, and compare with what `claude -p` itself reported (`model_usage`, `cost_usd_api_equiv`).
// Tokens are compared per model first, then dollars. $0, read-only.
//
//   node bench/reconcile.mjs [--root ~/.claude-ectest/projects] [--runs bench/results/x.jsonl]...
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listTranscripts, loadSession, readRecords } from './lib/transcripts.mjs'
import { ANTHROPIC, familyOf, usageUsd } from '../hooks/lib/prices.ts'

const here = path.dirname(new URL(import.meta.url).pathname)
const args = process.argv.slice(2)
const roots = []
const runFiles = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') roots.push(args[++i].replace(/^~/, os.homedir()))
  else if (args[i] === '--runs') runFiles.push(args[++i])
}
if (!roots.length) roots.push(path.join(os.homedir(), '.claude-ectest', 'projects'))
if (!runFiles.length) for (const f of fs.readdirSync(path.join(here, 'results'))) if (/^(v4-pilot2?|real-final|real)-2026.*\.jsonl$/.test(f) && !f.includes('grades')) runFiles.push(path.join(here, 'results', f))

export const TOLERANCE = 0.02
const price = (t, model) => usageUsd(t, ANTHROPIC.rates[familyOf(model) ?? 'sonnet'])

export function reconcileRun(run, session, routerCalls = []) {
  const ours = {}
  const add = (r) => {
    const m = ours[r.model] ??= { input: 0, output: 0, cache_read: 0, cache_write: 0, usd: 0, requests: 0, incomplete: 0 }
    m.input += r.tokens.input; m.output += r.tokens.output; m.cache_read += r.tokens.cacheRead; m.cache_write += r.tokens.cacheWrite5m + r.tokens.cacheWrite1h
    m.usd += price(r.tokens, r.model); m.requests += 1
    if (r.incomplete) m.incomplete += 1
  }
  for (const p of session.prompts) for (const r of p.requests) add(r)
  for (const r of session.sidechain) add(r)
  for (const r of session.subagents) add(r)
  // The CLI keys the picker row as `claude-sonnet-5-5[1m]`; the API reports `claude-sonnet-5-5`.
  const theirs = {}
  for (const [k, v] of Object.entries(run.model_usage ?? {})) {
    const m = theirs[k.replace(/\[1m\]$/, '')] ??= { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0 }
    for (const f of ['input', 'output', 'cache_read', 'cache_write', 'cost_usd']) m[f] += v[f] ?? 0
  }
  const models = [...new Set([...Object.keys(ours), ...Object.keys(theirs)])]
  const rows = models.map((m) => {
    const a = ours[m] ?? { input: 0, output: 0, cache_read: 0, cache_write: 0, usd: 0 }
    const b = theirs[m] ?? { input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0 }
    return { model: m, ours: a, reported: b, outputGap: a.output - (b.output ?? 0), usdGap: a.usd - (b.cost_usd ?? 0) }
  })
  const oursUsd = Object.values(ours).reduce((s, m) => s + m.usd, 0)
  const reported = run.cost_usd_api_equiv ?? Object.values(theirs).reduce((s, m) => s + (m.cost_usd ?? 0), 0)
  // Explained gaps, each with its mechanism:
  //   transcriptless   a model the CLI billed that wrote no transcript lines at all
  //   routerCalls      in-mod model calls ($.model.complete: the judge, Haiku compaction), from the
  //                    router's own records (measured usage), which write no transcript lines
  //   incomplete       a response whose final usage line was never written (stop_reason still null; a
  //                    workflow agent that ends on StructuredOutput). Its output is attributed only when
  //                    that model has such requests AND input and cache tokens already match exactly.
  const transcriptless = rows.filter((r) => !ours[r.model]).reduce((s, r) => s + (r.reported.cost_usd ?? 0), 0)
  const router = routerCalls.reduce((s, c) => s + (c.usd ?? 0), 0)
  let incomplete = 0
  const attributions = []
  for (const r of rows) {
    const a = ours[r.model]
    if (!a || !a.incomplete || r.outputGap >= 0) continue
    if (a.input !== (r.reported.input ?? 0) || a.cache_read !== (r.reported.cache_read ?? 0) || a.cache_write !== (r.reported.cache_write ?? 0)) continue
    const fam = familyOf(r.model) ?? 'sonnet'
    const usd = (-r.outputGap * ANTHROPIC.rates[fam].output) / 1e6
    incomplete += usd
    attributions.push({ model: r.model, outputTokens: -r.outputGap, incompleteRequests: a.incomplete, usd })
  }
  const gap = reported ? (oursUsd - reported) / reported : 0
  const explainedGap = reported ? (oursUsd + transcriptless + router + incomplete - reported) / reported : 0
  return { run: run.run_id, oursUsd, reported, transcriptless, router, incomplete, attributions, gap, explainedGap, pass: Math.abs(explainedGap) <= TOLERANCE, rows }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = new Map(listTranscripts(roots).map((f) => [path.basename(f, '.jsonl'), f]))
  // The router's own records of in-mod model calls (judge, compaction), by session: measured usage.
  const recs = readRecords(path.join(os.homedir(), '.claude-ectest', 'plugins', 'data', 'automode'))
  const routerCallsBy = new Map()
  for (const r of recs) {
    const usd = r.kind === 'model-call' ? r.usd?.value : r.kind === 'decision' && r.judge?.called ? r.judge.usd : undefined
    if (usd === undefined || !r.sessionId) continue
    routerCallsBy.set(r.sessionId, [...(routerCallsBy.get(r.sessionId) ?? []), { usd }])
  }
  const results = []
  let missing = 0
  for (const rf of runFiles) for (const l of fs.readFileSync(rf, 'utf8').split('\n').filter(Boolean)) {
    const run = JSON.parse(l)
    const f = files.get(run.session_id)
    if (!f) { missing += 1; continue }
    results.push({ batch: path.basename(rf), ...reconcileRun(run, loadSession(f, { subagents: true }), routerCallsBy.get(run.session_id) ?? []) })
  }
  const fail = results.filter((r) => !r.pass)
  const sum = (k) => results.reduce((s, r) => s + r[k], 0)
  console.log(`runs reconciled: ${results.length} (transcript missing: ${missing})`)
  console.log(`total transcripts $${sum('oursUsd').toFixed(4)} + router calls $${sum('router').toFixed(4)} + incomplete streams $${sum('incomplete').toFixed(4)} + transcriptless $${sum('transcriptless').toFixed(4)} vs reported $${sum('reported').toFixed(4)}`)
  for (const r of results.filter((x) => x.attributions.length)) console.log(`  attributed ${r.run}: ${r.attributions.map((a) => `${a.model} ${a.outputTokens} output tokens from ${a.incompleteRequests} incomplete stream(s), $${a.usd.toFixed(4)}`).join('; ')}`)
  console.log(`within ±${TOLERANCE * 100}% after explained gaps: ${results.length - fail.length}/${results.length}`)
  for (const r of fail.slice(0, 15)) console.log(`  FAIL ${r.batch} ${r.run}: ours $${r.oursUsd.toFixed(4)} reported $${r.reported.toFixed(4)} gap ${(100 * r.explainedGap).toFixed(1)}% | ${r.rows.map((x) => `${x.model.replace('claude-', '')} out ${x.ours.output}/${x.reported.output} cr ${x.ours.cache_read}/${x.reported.cache_read} cw ${x.ours.cache_write}/${x.reported.cache_write} $${x.ours.usd.toFixed(4)}/${(x.reported.cost_usd ?? 0).toFixed(4)}`).join(' ; ')}`)
  const out = path.join(here, 'results', `reconcile-${new Date().toISOString().slice(0, 10)}.json`)
  fs.writeFileSync(out, JSON.stringify({ tolerance: TOLERANCE, runs: results.length, missing, pass: results.length - fail.length, results }, null, 2) + '\n')
}
