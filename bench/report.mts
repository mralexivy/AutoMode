#!/usr/bin/env node
// Summarizes bench/results/*.jsonl into markdown. Every number comes from the raw rows.
// Usage: node bench/report.mts [results.jsonl ...] > summary.md
import fs from 'node:fs'
import path from 'node:path'
import { ARMS } from './arms.mts'
import { isDone, isResult } from './lib/outcome.mts'
import { bootstrapCI } from './lib/stats.mts'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const files = process.argv.slice(2).length ? process.argv.slice(2)
  // ledger.jsonl is the spend ledger, not run results. Judge and grade files have no run_id and are skipped below.
  : fs.readdirSync(path.join(REPO, 'bench', 'results')).filter((f) => f.endsWith('.jsonl') && f !== 'ledger.jsonl').map((f) => path.join(REPO, 'bench', 'results', f))
const rows: any[] = files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).filter((r) => r.run_id)
// A run that saw the user's auto-memory is contaminated and excluded from every number.
const contaminated = rows.filter((r) => isResult(r) && r.memory_refs > 0)
const valid = rows.filter((r) => isResult(r) && !(r.memory_refs > 0))
const notRun = rows.filter((r) => !isDone(r))
const CRITICAL_COHORTS = ['security', 'migration']

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const opusUsd = (r: any) => Object.entries<any>(r.model_usage || {}).filter(([m]) => m.includes('opus')).reduce((a, [, u]) => a + (u.cost_usd || 0), 0)
// A run's cost includes the judge router's own Haiku calls (bench/run.mts judgeCost).
const runCost = (r: any) => (r.cost_usd_api_equiv || 0) + (r.judge?.usd || 0)
const costPerAccepted = (sample: any[]) => { const acc = sample.filter((r) => r.accepted).length; return acc ? sample.reduce((a, r) => a + runCost(r), 0) / acc : null }
const opusPerAccepted = (sample: any[]) => { const acc = sample.filter((r) => r.accepted).length; return acc ? sample.reduce((a, r) => a + opusUsd(r), 0) / acc : null }
const acceptRate = (sample: any[]) => mean(sample.map((r) => (r.accepted ? 1 : 0)))
const taskOf = (r: any) => r.task_id
const pct = (x: number | null) => (x === null ? 'n/a' : `${(100 * x).toFixed(0)}%`)
const usd = (x: number | null) => (x === null ? 'n/a' : `$${x.toFixed(2)}`)
const ci = ([lo, hi]: [number | null, number | null], f: (x: number) => string) => (lo === null ? '' : ` [${f(lo)}–${f(hi)}]`)

const armIds = Object.keys(ARMS).filter((a) => valid.some((r) => r.arm === a))
const cohorts = [...new Set(valid.map((r) => r.cohort))].sort()
const out = []
out.push(`Runs: ${rows.length} rows, ${valid.length} valid, ${rows.filter((r) => r.harness_error).length} harness errors, ${contaminated.length} excluded for memory contamination, ${notRun.length} stopped by a usage limit or setup, ${valid.filter((r) => r.cost_usd_api_equiv == null).length} with no reported cost. Tasks: ${[...new Set(valid.map((r) => r.task_id))].length}. Cohorts: ${cohorts.join(', ')}.`)
out.push('All USD values are API list-price equivalents from the CLI, not subscription charges. Intervals are bootstrap 95% CIs that resample tasks (2,000 resamples, seed 42).\n')

out.push('### By arm\n')
out.push('| Arm | Runs | Accepted | Cost per accepted task | Opus USD per accepted task | Median wall time | Runs with commits |')
out.push('|---|---:|---:|---:|---:|---:|---:|')
for (const a of armIds) {
  const rs = valid.filter((r) => r.arm === a)
  out.push(`| ${ARMS[a].label} | ${rs.length} | ${pct(acceptRate(rs))}${ci(bootstrapCI(rs, taskOf, acceptRate), pct)} | ${usd(costPerAccepted(rs))}${ci(bootstrapCI(rs, taskOf, costPerAccepted), usd)} | ` +
    `${usd(opusPerAccepted(rs))}${ci(bootstrapCI(rs, taskOf, opusPerAccepted), usd)} | ${median(rs.map((r) => r.wall_s).filter(Number.isFinite)) ?? 'n/a'}s | ${rs.filter((r) => r.commits_made > 0).length} |`)
}

out.push('\n### Accepted runs by cohort\n')
out.push(`| Cohort | ${armIds.join(' | ')} |`)
out.push(`|---|${armIds.map(() => '---:').join('|')}|`)
for (const c of cohorts) {
  out.push(`| ${c} | ${armIds.map((a) => { const rs = valid.filter((r) => r.arm === a && r.cohort === c); return `${rs.filter((r) => r.accepted).length}/${rs.length}` }).join(' | ')} |`)
}

out.push('\n### Non-inferiority check (declared before the runs)\n')
out.push('Rule: per cohort, an AutoMode arm accepts no fewer runs than the best baseline minus one, and in critical cohorts it accepts no fewer than the best baseline.\n')
// A baseline is any arm with no plugin. An AutoMode arm is one that runs the V4 router.
const baseArms = armIds.filter((a) => !ARMS[a].plugin)
for (const a of armIds.filter((x) => ARMS[x].v4)) {
  const fails = []
  for (const c of cohorts) {
    const count = (arm: string) => valid.filter((r) => r.arm === arm && r.cohort === c && r.accepted).length
    const best = Math.max(0, ...baseArms.map(count))
    const allowed = CRITICAL_COHORTS.includes(c) ? best : best - 1
    if (count(a) < allowed) fails.push(`${c}: ${count(a)} accepted vs best baseline ${best}`)
  }
  out.push(`- **${ARMS[a].label}:** ${baseArms.length ? (fails.length ? `FAILS (${fails.join('; ')})` : 'passes') : 'no baseline runs yet'}`)
}

out.push('\n### Stage cost for AutoMode arms (from the per-stage trace)\n')
out.push('| Arm | Stage | Calls | Output tokens | Est. USD |')
out.push('|---|---|---:|---:|---:|')
for (const a of armIds.filter((x) => ARMS[x].plugin)) {
  const by: Record<string, { calls: number; output: number; usd: number }> = {}
  for (const r of valid.filter((x) => x.arm === a)) for (const t of r.trace || []) {
    const k = t.stage || 'unknown'
    by[k] = by[k] || { calls: 0, output: 0, usd: 0 }
    by[k].calls += t.calls || 0
    by[k].output += t.output || 0
    by[k].usd += t.est_usd || 0
  }
  for (const [k, v] of Object.entries(by)) out.push(`| ${ARMS[a].label} | ${k} | ${v.calls} | ${v.output.toLocaleString('en-US')} | ${usd(v.usd)} |`)
}

const caveats = armIds.filter((a) => ARMS[a].caveat).map((a) => `- ${ARMS[a].label}: ${ARMS[a].caveat}`)
if (caveats.length) out.push('\n### Arm caveats\n\n' + caveats.join('\n'))
console.log(out.join('\n'))
