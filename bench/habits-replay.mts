#!/usr/bin/env node
// Habits replay over local transcripts. $0, read-only, numbers only.
// Trains the habits on the earlier 60% of interactive sessions and scores keepalive policies on the later 40%, so the
// gated policy never sees the sessions it is scored on. Usage: node bench/habits-replay.mts [--days 60] [--out FILE]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { foldTranscript, type Folded } from '../hooks/lib/scan.ts'
import { flat, gapsOf, gated, none, simulate, train, type GateParams } from './lib/gap-replay.mts'

const args = process.argv.slice(2)
const opt = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const DAYS = Number(opt('--days', '60'))
const now = Date.now()
const root = path.join(os.homedir(), '.claude/projects')

const sessions: Folded[] = []
for (const d of fs.readdirSync(root)) {
  let files: string[] = []
  try { files = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl')) } catch { continue }
  for (const f of files) {
    const file = path.join(root, d, f)
    try { if (now - fs.statSync(file).mtimeMs > DAYS * 86_400_000) continue } catch { continue }
    const s = foldTranscript(fs.readFileSync(file, 'utf8'))
    if (s.prompts >= 2 && s.reqs.length) sessions.push(s)
  }
}
sessions.sort((a, b) => a.reqs[0].at - b.reqs[0].at)
// Three parts in time order: 50% builds the habits, 25% picks the gate's settings, 25% is scored once.
const c1 = Math.floor(sessions.length * 0.5), c2 = Math.floor(sessions.length * 0.75)
const trainSet = sessions.slice(0, c1), valSet = sessions.slice(c1, c2), testSet = sessions.slice(c2)
const habits = train(trainSet, now)
const valGaps = gapsOf(valSet, now), testGaps = gapsOf(testSet, now)
const r2 = (x: number) => Math.round(x * 100) / 100
const grid: GateParams[] = []
for (const minUsd of [0.1, 0.3, 0.6]) for (const capHours of [2, 4]) for (const windowMin of [60, 120, 240]) for (const pool of [false, true]) grid.push({ minUsd, capHours, windowMin, pool })
const scored = grid.map((q) => ({ q, val: simulate(valGaps, gated(habits, q)) })).sort((a, b) => b.val.netUsd - a.val.netUsd)
const best = scored[0].q
const fixed = [none, flat(2), flat(4), gated(habits, best)]
const rows = fixed.map((p) => { const r = simulate(testGaps, p); return { ...r, pingUsd: r2(r.pingUsd), savedUsd: r2(r.savedUsd), netUsd: r2(r.netUsd), rewriteUsd: r2(r.rewriteUsd) } })
const days = (testSet.at(-1)!.reqs.at(-1)!.at - testSet[0].reqs[0].at) / 86_400_000
const out = { basis: 'calculated at the mod price table from recorded usage; counterfactual, not billed', interactiveSessions: sessions.length, train: trainSet.length, validation: valSet.length, test: testSet.length, testDays: r2(days), testGaps: testGaps.length, bestSettings: best, validationTop3: scored.slice(0, 3).map((x) => ({ ...x.q, net: r2(x.val.netUsd) })), rows }
const o = opt('--out')
if (o) fs.writeFileSync(o, JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify(out, null, 2))
