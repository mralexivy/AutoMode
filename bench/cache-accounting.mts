#!/usr/bin/env node
// Request-level cache accounting for effort changes. $0: reads transcripts only, no inference.
//
//   node bench/cache-accounting.mts [--file F.jsonl ...] [--roots DIR,DIR] [--days N] [--json]
//
// For each pair of consecutive main-thread requests on the same model within the cache lifetime:
//   prior     the earlier request's whole prompt (uncached input + cache read + cache writes): the prefix the later
//             request can read from cache. The earlier output is new input to the later request (written there), so it
//             is not counted as readable.
//   rewritten the part of that prior the later request did NOT read from cache, in tokens and in USD (as a write)
// Pairs with an effort change are compared with CONTROL pairs from the same transcripts: pairs with no effort change and
// no model change, at the same position (the first request of a prompt, where new text and injected context arrive, or
// a continuation inside a turn). A change keeps the cache when its rewritten share is at most the matched control's 95th
// percentile. No fixed threshold: the control sets the bar on the same machine and sessions.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { listTranscripts, loadSession } from './lib/transcripts.mts'
import { ANTHROPIC, usageUsd } from '../hooks/lib/prices.ts'
import { familyOf } from '../hooks/lib/prices.ts'

const HOUR = 3_600_000
const prompt = (t) => t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h

// pairsOf returns every consecutive same-model main pair of one session, with its accounting.
export function pairsOf(session) {
  const reqs = session.prompts.flatMap((p) => p.requests.map((r, i) => ({ ...r, first: i === 0 }))).filter((r) => r.tokens && !r.incomplete)
  const out = []
  for (let i = 1; i < reqs.length; i++) {
    const a = reqs[i - 1], b = reqs[i]
    if (a.model !== b.model || b.at - a.at > HOUR) continue
    const prior = prompt(a.tokens)
    const rewritten = Math.max(0, prior - b.tokens.cacheRead)
    const fam = familyOf(b.model) ?? 'sonnet'
    const rate = ANTHROPIC.rates[fam]
    const rewriteUsd = (rewritten * rate.input * (b.tokens.cacheWrite1h > b.tokens.cacheWrite5m ? 2 : 1.25)) / 1e6
    out.push({
      session: session.sessionId, model: b.model, from: a.sentEffort ?? null, to: b.sentEffort ?? null,
      position: b.first ? 'prompt' : 'continuation',
      effortChange: a.sentEffort != null && b.sentEffort != null && a.sentEffort !== b.sentEffort,
      beta: b.perMessageEffortBeta ?? null,
      prior, cacheRead: b.tokens.cacheRead, cacheWrite: b.tokens.cacheWrite5m + b.tokens.cacheWrite1h, uncached: b.tokens.input,
      rewritten, rewrittenShare: prior ? rewritten / prior : 0, rewriteUsd, usd: usageUsd(b.tokens, rate),
    })
  }
  return out
}

const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] }

export function account(pairs) {
  const control = pairs.filter((p) => !p.effortChange && p.from != null)
  const changes = pairs.filter((p) => p.effortChange)
  const ctl = (pos) => control.filter((p) => p.position === pos)
  const bars = Object.fromEntries(['prompt', 'continuation'].map((pos) => [pos, pct(ctl(pos).map((p) => p.rewrittenShare), 0.95)]))
  const rows = changes.map((p) => ({ ...p, bar: bars[p.position], kept: bars[p.position] !== null ? p.rewrittenShare <= bars[p.position] : null }))
  return {
    control: Object.fromEntries(['prompt', 'continuation'].map((pos) => [pos, { n: ctl(pos).length, medianShare: pct(ctl(pos).map((p) => p.rewrittenShare), 0.5), p95Share: bars[pos] }])),
    changes: rows,
    kept: rows.filter((r) => r.kept === true).length,
    notKept: rows.filter((r) => r.kept === false).length,
    rewriteUsd: rows.reduce((a, r) => a + r.rewriteUsd, 0),
    controlRewriteUsdMedian: pct(control.map((p) => p.rewriteUsd), 0.5),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
  const files = args.flatMap((a, i) => (args[i - 1] === '--file' ? [a] : []))
  const days = Number(opt('--days', 30))
  const roots = opt('--roots', path.join(os.homedir(), '.claude', 'projects')).split(',')
  const cut = Date.now() - days * 24 * HOUR
  const list = files.length ? files : listTranscripts(roots).filter((f) => { try { return fs.statSync(f).mtimeMs >= cut } catch { return false } })
  const pairs = []
  for (const f of list) { try { pairs.push(...pairsOf(loadSession(f))) } catch {} }
  const a = account(pairs)
  if (args.includes('--json')) { console.log(JSON.stringify(a, null, 2)); process.exit(0) }
  const f2 = (x) => (x === null ? '-' : `${(100 * x).toFixed(2)}%`)
  for (const [pos, c] of Object.entries(a.control)) console.log(`Control at ${pos} (no effort change): ${c.n} pairs. Rewritten share: median ${f2(c.medianShare)}, p95 ${f2(c.p95Share)}.`)
  console.log(`Effort changes: ${a.changes.length}. Inside the control range: ${a.kept}. Outside: ${a.notKept}. Rewrite cost of the changes: $${a.rewriteUsd.toFixed(4)}.\n`)
  console.log('model | from -> to | at | beta | prior | cache read | rewritten | share | rewrite USD | kept')
  for (const r of a.changes) console.log(`${r.model.replace(/^claude-/, '')} | ${r.from} -> ${r.to} | ${r.position} | ${r.beta ? 'yes' : r.beta === false ? 'no' : '?'} | ${r.prior} | ${r.cacheRead} | ${r.rewritten} | ${f2(r.rewrittenShare)} | ${r.rewriteUsd.toFixed(5)} | ${r.kept === null ? '?' : r.kept ? 'yes' : 'NO'}`)
  console.log('\nThe control comes from the same transcripts. A miss can still have another cause (an expired cache, a changed tool set).')
}
