#!/usr/bin/env node
// Habits replay over local transcripts. $0, read-only, numbers only.
// Trains the habits on gaps that ended before a split time (the first 60% of interactive gaps in time order) and scores keepalive policies
// on the gaps after it, so no rule sees what it is scored on. Scripted runs (`sdk-cli`) are left out, as in the mod.
// Reports each policy's net dollars with a 95% interval from resampling sessions, and the paired difference between the habits rule and
// the simple rule. Usage: node bench/habits-replay.mts [--days 90] [--out FILE]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { foldTranscript, interactive, type Folded } from '../hooks/lib/scan.ts'
import { bootstrap, challenger, champion, flat, gapsOf, none, simulate, trainBefore } from './lib/gap-replay.mts'

const args = process.argv.slice(2)
const opt = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const DAYS = Number(opt('--days', '90'))
const now = Date.now()
const root = path.join(os.homedir(), '.claude/projects')

const all: Folded[] = []
let scripted = 0
for (const d of fs.readdirSync(root)) {
  let files: string[] = []
  try { files = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl')) } catch { continue }
  for (const f of files) {
    const file = path.join(root, d, f)
    try { if (now - fs.statSync(file).mtimeMs > DAYS * 86_400_000) continue } catch { continue }
    const s = foldTranscript(fs.readFileSync(file, 'utf8'))
    if (s.entry === 'sdk-cli') scripted += 1
    if (interactive(s) && s.reqs.length) all.push(s)
  }
}
const gapsAll = gapsOf(all, now)
const times = gapsAll.map((g) => g.endAt).sort((a, b) => a - b)
const T = times[Math.floor(times.length * 0.6)] ?? now
const habits = trainBefore(all, T)
const test = gapsOf(all, now, T)
const r2 = (x: number) => Math.round(x * 100) / 100
const r3 = (x: number) => Math.round(x * 1000) / 1000
const row = (p: ReturnType<typeof flat>) => {
  const r = simulate(test, p)
  const [lo, hi] = bootstrap(r.bySession)
  return { policy: r.policy, pings: r.pings, pingUsd: r2(r.pingUsd), savedUsd: r2(r.savedUsd), netUsd: r2(r.netUsd), netCI95: [r2(lo), r2(hi)], losingGaps: r.worse, _by: r.bySession }
}
const rows = [none, flat(2), flat(4), champion(2, 0.3), challenger(habits, 2, 0.3)].map(row)
const diff = new Map<number, number>()
const chal = rows[4]._by, champ = rows[3]._by
for (const k of new Set([...chal.keys(), ...champ.keys()])) diff.set(k, (chal.get(k) ?? 0) - (champ.get(k) ?? 0))
const [dlo, dhi] = bootstrap(diff)
const out = {
  basis: 'calculated at the mod price table from recorded usage; counterfactual, not billed; one person',
  interactiveSessions: all.length, scriptedSessionsLeftOut: scripted, trainPoints: habits.pts.length, modelReportCard: { points: Math.round(habits.ev.n), modelError: r3(habits.ev.bModel / Math.max(1, habits.ev.n)), startingGuessError: r3(habits.ev.bPrior / Math.max(1, habits.ev.n)), baseRateError: r3(habits.ev.bConst / Math.max(1, habits.ev.n)) }, testGaps: test.length,
  testSessions: new Set(test.map((g) => g.session)).size,
  rows: rows.map(({ _by, ...r }) => r),
  habitsMinusSimple: { netUsd: r2([...diff.values()].reduce((a, b) => a + b, 0)), ci95: [r2(dlo), r2(dhi)] },
}
const o = opt('--out')
if (o) fs.writeFileSync(o, JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify(out, null, 2))
