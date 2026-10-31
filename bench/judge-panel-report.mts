#!/usr/bin/env node
// Scores bench/results/judge-panel.jsonl with upstream's grader: upstream, and the AutoMode decision under each judge
// input. Design decisions use the development cases only, and the held-out cases score a frozen rule once. Labels
// score effort only, so this says nothing about task quality.
//
//   node bench/judge-panel-report.mts [panel.jsonl]
import fs from 'node:fs'
import path from 'node:path'
import { benchGrade } from '../hooks/lib/effortless.ts'
import { automodeRoute, upstreamRoute, type LabeledCase, type PanelRow, type Route, type Slots } from './lib/judge-replay.mts'
import { pairedDelta } from './lib/stats.mts'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const file = process.argv[2] ?? path.join(REPO, 'bench', 'results', 'judge-panel.jsonl')
const cases: LabeledCase[] = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'external', 'effortless', 'judge-cases.json'), 'utf8')).cases
const rows: PanelRow[] = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const passes = [...new Set(rows.map((r) => r.pass))]
const slotsOf = (pass: number, id: string): Slots => new Map(rows.filter((r) => r.pass === pass && r.id === id).map((r) => [r.slot, r]))
const ARMS: Record<string, (c: LabeledCase, s: Slots) => Route> = {
  'upstream effortless': upstreamRoute,
  'AutoMode, closing line always': (c, s) => automodeRoute(c, s, { input: 'closing' }),
  'AutoMode, closing line on retry': (c, s) => automodeRoute(c, s, { input: 'plain-then-closing' }),
}
export interface Graded { id: string; arm: string; grade: string; hit: number }
const graded: (Graded & { holdout: boolean })[] = Object.entries(ARMS).flatMap(([arm, route]) => cases.flatMap((c) => passes.map((p) => {
  const grade = benchGrade(c, route(c, slotsOf(p, c.id)).effort ?? undefined)
  return { id: c.id, arm, grade, hit: grade === 'hit' ? 1 : 0, holdout: !!c.holdout }
})))
const line = (name: string, rs: Graded[]) => {
  const n = (g: string) => rs.filter((r) => r.grade === g).length
  return `| ${name} | ${((100 * n('hit')) / rs.length).toFixed(1)}% (${n('hit')}/${rs.length}) | ${n('under')} | ${n('over')} | ${n('none')} |`
}
for (const [title, keep] of [['Development cases', (r: { holdout: boolean }) => !r.holdout], ['Held-out cases', (r: { holdout: boolean }) => r.holdout], ['All cases', () => true]] as const) {
  console.log(`\n### ${title}, ${passes.length} passes\n\n| Arm | Right | Too low | Too high | No answer |\n| --- | --- | --- | --- | --- |`)
  for (const arm of Object.keys(ARMS)) console.log(line(arm, graded.filter((r) => r.arm === arm && keep(r))))
}
const of = (arm: string) => graded.filter((r) => r.arm === arm)
const mean = (xs: Graded[]) => xs.reduce((a, r) => a + r.hit, 0) / xs.length
const d = pairedDelta(of('upstream effortless'), of('AutoMode, closing line on retry'), (r) => r.id, mean)
console.log(`\nAutoMode minus upstream, paired by case: ${(100 * d.delta!).toFixed(1)} points, 95% interval ${(100 * d.ci[0]!).toFixed(1)} to ${(100 * d.ci[1]!).toFixed(1)}, ${d.tasks} cases.`)
