#!/usr/bin/env node
// @ts-nocheck TODO(types): 4 errors with strict off. Fix them and delete this line to turn checking on for this file.
// What large contexts cost, and how much of it a context action could reach. $0: transcripts only, read-only.
//
//   node bench/context-tax.mts [--days 30] [--base 60000] [--out FILE]
//
// Per main-thread request, priced at today's first-party prices (1 h cache) on the model that ran:
//   carry     cache reads above `--base` tokens (the system prompt, tools and a working set). The price of keeping
//             history in the context. Not all of it is waste: the next request may need that history.
//   rewrite   a cache write of 100k+ tokens after more than 1 h idle (a cold return to a large context).
// Where a context action could act:
//   new task  the request belongs to a turn that starts after a turn that ended on a passing check or a commit, and its
//             prompt is not a follow-up. A clear with a handoff there loses the least. This is the guardian's boundary.
//   cold      the first request after more than 1 h idle on a context over 150k. A compaction or a clear before it
//             replaces the rewrite with a smaller one.
//   in task   everything else. Only compaction mid-task reaches it, at a quality risk the transcripts cannot price.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseLines } from './lib/transcripts.mts'
import { workloadOf, familyOf, rateOf, costOf, sum } from './spend-audit.mts'
import { turnsOf } from './retro-replay.mts'
import { FOLLOW_UP } from '../hooks/lib/classify.ts'

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const END = Date.now(), START = END - Number(opt('--days', 30)) * 86_400_000
const BASE = Number(opt('--base', 60_000))
const ROOT = path.join(os.homedir(), '.claude/projects')
// Today's prices, from the same table as the replay (spend-audit.mts MODEL_RATES), on today's model of the family.
const TODAY = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }
const PRICE = TODAY
const Z = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }
const read = (fam, n) => costOf({ ...Z, cacheRead: n }, TODAY[fam]).read
const write = (fam, n) => costOf({ ...Z, cacheWrite1h: n }, TODAY[fam]).write1h

const r2 = (x) => Math.round(x * 100) / 100
const out = { window: { start: new Date(START).toISOString(), end: new Date(END).toISOString() }, base: BASE, requests: 0, mainUsd: 0, carry: { newTask: 0, cold: 0, inTask: 0 }, rewrite: { cold: 0, n: 0 }, contextBands: {} }
const band = (n) => (n < 100_000 ? '<100k' : n < 200_000 ? '100-200k' : n < 350_000 ? '200-350k' : n < 550_000 ? '350-550k' : '550k+')

for (const project of fs.readdirSync(ROOT)) {
  if (workloadOf(ROOT, project) !== 'engineering') continue
  let files = []
  try { files = fs.readdirSync(path.join(ROOT, project)).filter((f) => f.endsWith('.jsonl')) } catch { continue }
  for (const f of files) {
    const file = path.join(ROOT, project, f)
    if (fs.statSync(file).mtimeMs < START) continue
    const turns = turnsOf(parseLines(file))
    let prevAt = null, prevClosed = false
    for (const turn of turns) {
      const newTask = prevClosed && turn.text !== null && !FOLLOW_UP.test(turn.text.trim())
      turn.steps.forEach((s, i) => {
        const fam = familyOf(s.model)
        if (!(fam in PRICE) || s.at < START || !rateOf(s.model)) { prevAt = s.at; return }
        // Normalized as bench/retro-replay.mts does: a Vertex-era 5 min expiry rewrite inside 1 h is a read under today's
        // 1 h cache; every other write is a 1 h write.
        const gap = prevAt === null ? Infinity : s.at - prevAt
        const t = { ...s.tokens }
        if (s.vertex && gap > 300_000 && gap <= 3_600_000 && t.cacheWrite5m > 20_000) { t.cacheRead += t.cacheWrite5m; t.cacheWrite5m = 0 }
        const ctx = t.cacheRead + t.cacheWrite5m + t.cacheWrite1h + t.input
        const cold = prevAt !== null && s.at - prevAt > 3_600_000
        out.requests += 1
        const all = sum(costOf({ ...t, cacheWrite1h: t.cacheWrite1h + t.cacheWrite5m, cacheWrite5m: 0 }, TODAY[fam]))
        out.mainUsd += all
        const carry = read(fam, Math.max(0, t.cacheRead - BASE))
        const where = cold && i === 0 && ctx > 150_000 ? 'cold' : newTask ? 'newTask' : 'inTask'
        out.carry[where] += carry
        if (cold && t.cacheWrite5m + t.cacheWrite1h >= 100_000) { out.rewrite.cold += write(fam, t.cacheWrite5m + t.cacheWrite1h); out.rewrite.n += 1 }
        const b = (out.contextBands[band(ctx)] ??= { requests: 0, usd: 0 })
        b.requests += 1; b.usd += all
        prevAt = s.at
      })
      prevClosed = turn.steps.some((s) => s.tests > s.failed) && !turn.corrected
    }
  }
}
for (const k of Object.keys(out.carry)) out.carry[k] = r2(out.carry[k])
out.rewrite.cold = r2(out.rewrite.cold); out.mainUsd = r2(out.mainUsd)
for (const b of Object.values(out.contextBands)) b.usd = r2(b.usd)
if (opt('--out')) fs.writeFileSync(opt('--out'), JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 1))
