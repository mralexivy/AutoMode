#!/usr/bin/env node
// Calibration, with no model calls.
//   node bench/calibration-report.mts --grades run.grades.jsonl --human bench/calibration/human-scores.jsonl
//     Judge scores against human scores, per rubric item.
//   node bench/calibration-report.mts --effort answers.json --arm automode-auto
//     Effort labels against the accepted sets: exact and acceptable accuracy, distance, and, with repeated labels per
//     case, Brier, ECE and NLL from the empirical label frequency.
import fs from 'node:fs'
import path from 'node:path'
import { brier, ece, effortDistance, exactAgreement, mean, nll, replicaForecast, spearman, withinOne } from './lib/calibration.mts'
import { DIMENSIONS } from './lib/grade-core.mts'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }
const jsonl = (f: string) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const fmt = (x: number | null) => (x === null ? 'n/a' : x.toFixed(3))

const gradesFile = arg('grades'), humanFile = arg('human'), effortFile = arg('effort')
if (gradesFile && humanFile) {
  const judged = new Map(jsonl(gradesFile).filter((g) => g.grade).map((g) => [g.run_id, g.grade]))
  const pairs = jsonl(humanFile).filter((h) => judged.has(h.run_id)).map((h) => ({ h, j: judged.get(h.run_id) }))
  console.log(`${pairs.length} runs have both a judge score and a human score.`)
  if (pairs.length < 50) console.log('Under 50 pairs: do not use judge scores as a headline yet.')
  console.log('\n| Item | Rank correlation | Exact agreement | Within one point |\n|---|---:|---:|---:|')
  for (const k of DIMENSIONS) {
    const h = pairs.map((p) => p.h[k]), j = pairs.map((p) => p.j[k])
    console.log(`| ${k} | ${fmt(spearman(h, j))} | ${fmt(exactAgreement(h, j))} | ${fmt(withinOne(h, j))} |`)
  }
} else if (effortFile) {
  const armName = arg('arm') ?? 'automode-auto'
  const casesFile = arg('cases') ?? path.join(REPO, 'bench', 'external', 'effortless', 'judge-cases.json')
  const cases = new Map(JSON.parse(fs.readFileSync(casesFile, 'utf8')).cases.map((c: any) => [c.id, c.ok as string[]]))
  const answers = JSON.parse(fs.readFileSync(effortFile, 'utf8')).answers.filter((a: any) => a.arm === armName && a.effort && cases.has(a.id))
  const byCase = new Map<string, string[]>()
  for (const a of answers) byCase.set(a.id, [...(byCase.get(a.id) ?? []), a.effort])
  const distances = answers.map((a: any) => effortDistance(a.effort, cases.get(a.id) as string[])).filter((d: number | null) => d !== null)
  console.log(`${answers.length} labels from ${armName} on ${byCase.size} cases.`)
  console.log(`Acceptable: ${fmt(mean(distances.map((d: number) => (d === 0 ? 1 : 0))))}. Exact, single accepted label: ${fmt(mean(answers.filter((a: any) => (cases.get(a.id) as string[]).length === 1).map((a: any) => ((cases.get(a.id) as string[])[0] === a.effort ? 1 : 0))))}. Mean distance from nearest acceptable: ${fmt(mean(distances))}.`)
  const forecasts = [...byCase].map(([id, labels]) => replicaForecast(labels, cases.get(id) as string[])).filter(Boolean)
  if (forecasts.length) console.log(`Brier ${fmt(brier(forecasts))}, ECE ${fmt(ece(forecasts))}, NLL ${fmt(nll(forecasts))}, over ${forecasts.length} cases with repeated labels.`)
  else console.log('Brier, ECE and NLL need at least two labels per case. This file has one, so they are not reported.')
} else {
  console.error('usage: node bench/calibration-report.mts --grades g.jsonl --human h.jsonl | --effort answers.json [--arm a] [--cases c.json]')
  process.exit(1)
}
