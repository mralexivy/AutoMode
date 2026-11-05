// Calibrates the live savings estimate (hooks/lib/savings.ts) against a measured benchmark. It replays an AutoMode
// arm's own Claude Code transcripts through the estimator, with the arm the sessions were launched on as the baseline,
// and compares the estimated baseline cost with that arm's measured cost on the same sessions. It calls no model and
// costs nothing. It reads transcripts from ~/.claude/projects, so it only runs where the benchmark ran, and it prints
// numbers only: no prompt or reply text leaves the transcripts.
//
//   node bench/savings-replay.mts bench/results/v6-w2-release.jsonl --arm v6c-opus \
//     --baseline-rows bench/results/v6-w1-mixed.jsonl --baseline-arm opus --baseline-model claude-opus-5-5
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { addOverhead, addRequest, netOf, NO_SAVINGS, type Savings } from '../hooks/lib/savings.ts'
import { ANTHROPIC } from '../hooks/lib/prices.ts'

const argv = process.argv.slice(2)
const opt = (k: string, d?: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const rowsPath = argv[0]
const arm = opt('--arm', 'v6c-opus')!
const baseRowsPath = opt('--baseline-rows')
const baseArm = opt('--baseline-arm', 'opus')!
const baseModel = opt('--baseline-model', 'claude-opus-5-5')!
const projects = opt('--projects', join(homedir(), '.claude', 'projects'))!

const rows = (p: string) => readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const usd = (r: any) => (r.cost_usd_api_equiv ?? 0) + (r.judge?.usd ?? 0)

// Every transcript file, by session id, found once.
const files = new Map<string, string>()
for (const dir of readdirSync(projects)) {
  const full = join(projects, dir)
  try { for (const f of readdirSync(full)) if (f.endsWith('.jsonl')) files.set(f.slice(0, -6), join(full, f)) } catch {}
}

// mainRequests: one entry per API message of the main session, the last usage seen for its id.
function mainRequests(sessionId: string) {
  const path = files.get(sessionId)
  if (!path || !existsSync(path)) return null
  const byId = new Map<string, { model: string; at: number; usage: any }>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let d: any
    try { d = JSON.parse(line) } catch { continue }
    if (d.type !== 'assistant' || d.isSidechain || !d.message?.usage || !d.message?.id) continue
    byId.set(d.message.id, { model: d.message.model, at: Date.parse(d.timestamp), usage: d.message.usage })
  }
  return [...byId.values()].sort((a, b) => a.at - b.at)
}
const tokens = (u: any) => {
  const split = u.cache_creation ?? {}
  const w1h = split.ephemeral_1h_input_tokens ?? 0
  const w5m = split.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h)
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite5m: w5m, cacheWrite1h: w1h }
}

const mine = rows(rowsPath).filter((r) => r.arm === arm)
const sessions = [...new Set(mine.map((r) => r.session))].sort()
const base = baseRowsPath ? rows(baseRowsPath).filter((r) => r.arm === baseArm) : []

console.log(`savings replay · ${rowsPath} · arm ${arm} · baseline ${baseModel}${baseRowsPath ? ` (measured: ${baseRowsPath} arm ${baseArm})` : ''}`)
console.log('session          requests  rerouted  actual    estimated baseline  overhead  est. saving  measured baseline  measured saving')
let T = { actual: 0, est: 0, over: 0, net: 0, measured: 0, measuredMine: 0, requests: 0, missing: 0 }
for (const session of sessions) {
  const steps = mine.filter((r) => r.session === session)
  const ids = [...new Set(steps.map((r) => r.session_id).filter(Boolean))]
  let s: Savings = NO_SAVINGS
  let found = 0
  for (const id of ids) {
    const reqs = mainRequests(id)
    if (!reqs) continue
    found++
    for (const q of reqs) s = addRequest(s, { appModel: baseModel, answeredModel: q.model, usage: tokens(q.usage), at: q.at, ttlMs: 3_600_000 }, ANTHROPIC)
  }
  if (!found) { T.missing++; console.log(`${session.padEnd(16)} transcripts not on this machine`); continue }
  for (const r of steps) s = addOverhead(s, r.judge?.usd ?? 0)
  const measured = base.filter((r) => r.session === session).reduce((a, r) => a + usd(r), 0)
  const measuredMine = steps.reduce((a, r) => a + usd(r), 0)
  const net = netOf(s)
  T = { actual: T.actual + s.actualUsd, est: T.est + s.baselineUsd, over: T.over + s.overheadUsd, net: T.net + net, measured: T.measured + measured, measuredMine: T.measuredMine + measuredMine, requests: T.requests + s.requests, missing: T.missing }
  const f = (x: number) => `$${x.toFixed(2)}`.padEnd(10)
  console.log(`${session.padEnd(16)} ${String(s.requests).padEnd(9)} ${String(s.rerouted).padEnd(9)} ${f(s.actualUsd)}${f(s.baselineUsd).padEnd(20)}${f(s.overheadUsd)}${f(net).padEnd(13)}${(base.length ? f(measured) : '—').padEnd(19)}${base.length ? f(measured - measuredMine) : '—'}`)
}
const pct = (x: number, of: number) => (of > 0 ? `${Math.round((x / of) * 100)}%` : '—')
console.log(`\ntotal: ${T.requests} main requests · actual $${T.actual.toFixed(2)} · overhead $${T.over.toFixed(2)}`)
console.log(`estimated: baseline $${T.est.toFixed(2)}, saving $${T.net.toFixed(2)} (${pct(T.net, T.est)})`)
if (base.length) console.log(`measured:  baseline $${T.measured.toFixed(2)}, saving $${(T.measured - T.measuredMine).toFixed(2)} (${pct(T.measured - T.measuredMine, T.measured)}) · this arm in full $${T.measuredMine.toFixed(2)}, subagents included`)
if (T.missing) console.log(`${T.missing} sessions had no transcript here`)
