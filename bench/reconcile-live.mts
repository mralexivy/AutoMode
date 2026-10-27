#!/usr/bin/env node
// Accounting check for live sessions, against the CLI's own running total: the transcript's last
// cost-state record (totalCostUSD, cumulative across --resume calls). $0, read-only.
//   node bench/reconcile-live.mts [sessionId...]   (default: every session with a router record)
// Compared: (1) transcripts (main, sidechain, subagents) plus the router's own model calls, and (2) the
// router ledger (request records plus model calls). A compaction the engine runs on the chat model writes
// no assistant line and passes no turn.step: its cost is attributed only in a window that holds a
// compact_boundary, from the cost-state delta of that call, and named as such.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listTranscripts, loadSession, readRecords } from './lib/transcripts.mts'
import { ANTHROPIC, familyOf, usageUsd } from '../hooks/lib/prices.ts'

const P = path.join(os.homedir(), '.claude-ectest')
const recs = readRecords(path.join(P, 'plugins', 'data', 'automode'))
const files = new Map(listTranscripts([path.join(P, 'projects')]).map((f) => [path.basename(f, '.jsonl'), f]))
const ids = process.argv.slice(2).length ? process.argv.slice(2) : [...new Set(recs.filter((r) => r.kind === 'request').map((r) => r.sessionId))].filter((id) => files.has(id))
const price = (t, m) => usageUsd(t, ANTHROPIC.rates[familyOf(m) ?? 'sonnet'])
const TOL = 0.02
const rows = []
for (const id of ids) {
  const f = files.get(id)
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return {} } })
  const states = lines.filter((l) => l.type === 'cost-state').map((l) => l.totalCostUSD)
  if (!states.length) continue
  const cli = states[states.length - 1]
  // Compaction calls: the cost-state delta of each window that contains a compact_boundary and no assistant line.
  let compaction = 0
  let prev = 0
  let sawBoundary = false
  let sawAssistant = false
  for (const l of lines) {
    if (l.type === 'system' && l.subtype === 'compact_boundary') sawBoundary = true
    if (l.type === 'assistant' && !l.isSidechain) sawAssistant = true
    if (l.type === 'cost-state') { if (sawBoundary && !sawAssistant) compaction += l.totalCostUSD - prev; prev = l.totalCostUSD; sawBoundary = false; sawAssistant = false }
  }
  const s = loadSession(f, { subagents: true })
  const all = [...s.prompts.flatMap((p) => p.requests), ...s.sidechain, ...s.subagents]
  const tx = all.reduce((a, q) => a + price(q.tokens, q.model), 0)
  const mine = recs.filter((r) => r.sessionId === id)
  const calls = mine.filter((r) => r.kind === 'model-call').reduce((a, r) => a + (r.usd?.value ?? 0), 0) + mine.filter((r) => r.kind === 'decision' && r.judge?.called && !mine.some((m) => m.kind === 'model-call')).reduce((a, r) => a + (r.judge.usd ?? 0), 0)
  // The ledger's recorded tokens, repriced with the fixed cache rule (main at the session's lifetime,
  // subagents at 5 minutes): records written before the fix carry the old price, never the old tokens.
  const mainTtl1h = s.prompts.flatMap((p) => p.requests).some((q) => q.tokens.cacheWrite1h > 0)
  const ledger = mine.filter((r) => r.kind === 'request' && r.usage).reduce((a, r) => {
    const w = r.usage.cacheWrite5m + r.usage.cacheWrite1h
    const one = !r.agentId && mainTtl1h
    return a + price({ ...r.usage, cacheWrite5m: one ? 0 : w, cacheWrite1h: one ? w : 0 }, r.answered?.model ?? r.sent.model)
  }, 0)
  const gapTx = (tx + calls + compaction - cli) / cli
  const gapLedger = (ledger + calls + compaction - cli) / cli
  rows.push({ session: id.slice(0, 8), cli: +cli.toFixed(4), transcripts: +tx.toFixed(4), routerCalls: +calls.toFixed(4), compaction: +compaction.toFixed(4), ledger: +ledger.toFixed(4), gapTranscripts: +(100 * gapTx).toFixed(2), gapLedger: +(100 * gapLedger).toFixed(2), requests: { transcripts: all.length, ledger: mine.filter((r) => r.kind === 'request').length }, pass: Math.abs(gapTx) <= TOL })
}
console.log(JSON.stringify({ tolerance: TOL, sessions: rows.length, passTranscripts: rows.filter((r) => r.pass).length, rows }, null, 2))
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'results', `reconcile-live-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify(rows, null, 2) + '\n')
