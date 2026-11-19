#!/usr/bin/env node
// Cache opportunity audit. $0: it reads local transcripts and makes no model call.
// It sizes the money that idle-expiry rewrites cost, and how much of it a keepalive ping or a cold-send
// guard could have saved. It is the ceiling for the cache-keeper work: if the ceiling is small, the
// feature is not worth shipping.
//
// Each main-thread request after a gap longer than the cache lifetime that rewrote most of its prompt is
// an expiry rewrite. For each one the audit prices three counterfactuals from the recorded usage:
//   keepwarm - pings every (ttl - margin) across the gap, each a cache read of the prior prompt, so the
//              rewrite becomes a read. Only gaps within the keepalive cap can be covered.
//   guard    - the send moves to the cheaper family for that rewrite, when the model is not already Haiku.
//              This is a bound, not a result: the router must still find the cheaper model eligible.
// Numbers only. It saves no prompt text, project name or path.
//
// Usage: node bench/cache-opportunity.mts [--days 30] [--margin-min 8] [--cap-hours 4] [--out FILE]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sessionsOf, costOf, sum, rateOf, familyOf } from './spend-audit.mts'

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const DAYS = Number(opt('--days', 30))
const MARGIN_MS = Number(opt('--margin-min', 8)) * 60_000
const CAP_MS = Number(opt('--cap-hours', 4)) * 3_600_000
const END = Date.now()
const START = END - DAYS * 86_400_000
const ROOTS = [path.join(os.homedir(), '.claude/projects')]
const PING_OUTPUT = 5

const promptOf = (t) => t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h
const ttlOf = (t) => (t.cacheWrite1h > t.cacheWrite5m ? 3_600_000 : 300_000)
const BUCKETS = [[5, 15], [15, 60], [60, 240], [240, 1440], [1440, Infinity]]
const bucketOf = (min) => BUCKETS.findIndex(([a, b]) => min >= a && min < b)
const label = ([a, b]) => (b === Infinity ? `>${a}m` : `${a}-${b}m`)

// cheaperFamily maps a family to the one a guard could route to, or null when none is cheaper.
const cheaperOf = (model) => {
  const f = familyOf(model)
  return f === 'opus' ? 'claude-sonnet-5-5' : f === 'sonnet' ? 'claude-haiku-4-5' : null
}

export function opportunity(main, { marginMs = MARGIN_MS, capMs = CAP_MS } = {}) {
  const rows = []
  const sorted = [...main].sort((a, b) => a.at - b.at)
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i]
    const gap = b.at - a.at
    const ttl = ttlOf(b.tokens)
    const written = b.tokens.cacheWrite5m + b.tokens.cacheWrite1h
    const total = promptOf(b.tokens)
    if (!(gap > ttl && total > 30_000 && written > 0.5 * total && written > 20_000)) continue
    const rewrite = (b.cost?.write5m ?? 0) + (b.cost?.write1h ?? 0)
    // A hit would have read the same tokens.
    const asRead = sum(costOf({ input: 0, cacheRead: written, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 }, b.model))
    const step = Math.max(60_000, ttl - marginMs)
    const pings = Math.floor(gap / step)
    const ctx = promptOf(a.tokens)
    const pingUsd = pings * sum(costOf({ input: 0, cacheRead: ctx, cacheWrite5m: 0, cacheWrite1h: 0, output: PING_OUTPUT }, a.model))
    const keepSave = gap <= capMs ? rewrite - asRead - pingUsd : 0
    const cheap = cheaperOf(b.model)
    const cheapRewrite = cheap ? sum(costOf({ input: 0, cacheRead: 0, cacheWrite5m: b.tokens.cacheWrite5m, cacheWrite1h: b.tokens.cacheWrite1h, output: 0 }, cheap)) : rewrite
    rows.push({ ttlMin: ttl / 60_000, gapMin: Math.round(gap / 60_000), tokens: written, family: familyOf(b.model), rewrite, asRead, pings, pingUsd, keepSave, guardSave: Math.max(0, rewrite - cheapRewrite), covered: gap <= capMs })
  }
  return rows
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = []
  let sessions = 0, spend = 0
  for (const s of sessionsOf(ROOTS, START, END)) {
    if (s.workload === 'benchmark') continue
    sessions += 1
    spend += s.requests.reduce((x, q) => x + q.usd, 0)
    rows.push(...opportunity(s.requests.filter((q) => q.agent === 'main')))
  }
  const r2 = (x) => Math.round(x * 100) / 100
  const add = (k) => rows.reduce((x, r) => x + r[k], 0)
  const by = (f) => Object.fromEntries(BUCKETS.map((b, i) => [label(b), f(rows.filter((r) => bucketOf(r.gapMin) === i))]))
  const sumOf = (rs, k) => r2(rs.reduce((x, r) => x + r[k], 0))
  const out = {
    window: { days: DAYS, marginMin: MARGIN_MS / 60_000, capHours: CAP_MS / 3_600_000 },
    basis: 'calculated (recorded usage x list price); counterfactual, not billed',
    sessions, spendUsd: r2(spend), expiryRewrites: rows.length, rewriteUsd: r2(add('rewrite')), rewriteShareOfSpendPct: r2((100 * add('rewrite')) / spend),
    keepwarm: { coveredRewrites: rows.filter((r) => r.covered).length, pings: add('pings'), pingUsd: r2(add('pingUsd')), netSavingUsd: r2(rows.reduce((x, r) => x + Math.max(0, r.keepSave), 0)), netNegativeRewrites: rows.filter((r) => r.covered && r.keepSave < 0).length },
    guardBoundUsd: r2(add('guardSave')),
    byGap: by((rs) => ({ n: rs.length, rewriteUsd: sumOf(rs, 'rewrite'), keepSaveUsd: r2(rs.reduce((x, r) => x + Math.max(0, r.keepSave), 0)), pingUsd: sumOf(rs, 'pingUsd') })),
    byTtl: Object.fromEntries([5, 60].map((t) => { const rs = rows.filter((r) => r.ttlMin === t); return [`${t}m`, { n: rs.length, rewriteUsd: sumOf(rs, 'rewrite'), keepSaveUsd: r2(rs.reduce((x, r) => x + Math.max(0, r.keepSave), 0)) }] })),
    byFamily: Object.fromEntries(['opus', 'sonnet', 'haiku'].map((f) => { const rs = rows.filter((r) => r.family === f); return [f, { n: rs.length, rewriteUsd: sumOf(rs, 'rewrite'), guardBoundUsd: sumOf(rs, 'guardSave') }] })),
  }
  const o = opt('--out')
  if (o) fs.writeFileSync(o, JSON.stringify(out, null, 2) + '\n')
  console.log(JSON.stringify(out, null, 2))
}
