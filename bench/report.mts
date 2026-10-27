#!/usr/bin/env node
// @ts-nocheck TODO(types): 7 errors with strict off. Fix them and delete this line to turn checking on for this file.
// Summarizes bench/results/*.jsonl into markdown. Every number comes from the raw rows.
// Usage: node bench/report.mts [results.jsonl ...] > summary.md
import fs from 'node:fs'
import path from 'node:path'
import { ARMS } from './arms.mts'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const files = process.argv.slice(2).length ? process.argv.slice(2)
  // ledger.jsonl is the spend ledger, not run results. Judge and grade files have no run_id and are skipped below.
  : fs.readdirSync(path.join(REPO, 'bench', 'results')).filter((f) => f.endsWith('.jsonl') && f !== 'ledger.jsonl').map((f) => path.join(REPO, 'bench', 'results', f))
const rows = files.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).filter((r) => r.run_id)
// A run that saw the user's auto-memory is contaminated and excluded from every number.
const contaminated = rows.filter((r) => !r.harness_error && r.memory_refs > 0)
const valid = rows.filter((r) => !r.harness_error && !(r.memory_refs > 0))
const BASELINES = ['sonnet', 'opus', 'opusplan']
const CRITICAL_COHORTS = ['security', 'migration', 'concurrency']

// Seeded PRNG (mulberry32) so the bootstrap is reproducible.
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
function bootstrapCI(values, stat, n = 2000, seed = 42) {
  if (!values.length) return [null, null]
  const r = rng(seed)
  const stats = []
  for (let i = 0; i < n; i++) {
    const sample = Array.from({ length: values.length }, () => values[Math.floor(r() * values.length)])
    const s = stat(sample)
    if (s !== null && Number.isFinite(s)) stats.push(s)
  }
  stats.sort((a, b) => a - b)
  return stats.length ? [stats[Math.floor(0.025 * stats.length)], stats[Math.floor(0.975 * stats.length)]] : [null, null]
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const opusUsd = (r) => Object.entries(r.model_usage || {}).filter(([m]) => m.includes('opus')).reduce((a, [, u]) => a + (u.cost_usd || 0), 0)
// A run's cost includes the judge router's own Haiku calls (bench/run.mts judgeCost).
const runCost = (r) => (r.cost_usd_api_equiv || 0) + (r.judge?.usd || 0)
const costPerAccepted = (sample) => { const acc = sample.filter((r) => r.accepted).length; return acc ? sample.reduce((a, r) => a + runCost(r), 0) / acc : null }
const opusPerAccepted = (sample) => { const acc = sample.filter((r) => r.accepted).length; return acc ? sample.reduce((a, r) => a + opusUsd(r), 0) / acc : null }
const pct = (x) => (x === null ? 'n/a' : `${(100 * x).toFixed(0)}%`)
const usd = (x) => (x === null ? 'n/a' : `$${x.toFixed(2)}`)
const ci = ([lo, hi], f) => (lo === null ? '' : ` [${f(lo)}–${f(hi)}]`)

const armIds = Object.keys(ARMS).filter((a) => valid.some((r) => r.arm === a))
const cohorts = [...new Set(valid.map((r) => r.cohort))].sort()
const out = []
out.push(`Runs: ${rows.length} rows, ${valid.length} valid, ${rows.filter((r) => r.harness_error).length} harness errors, ${contaminated.length} excluded for memory contamination. Tasks: ${[...new Set(valid.map((r) => r.task_id))].length}. Cohorts: ${cohorts.join(', ')}.`)
out.push('All USD values are API list-price equivalents from the CLI, not subscription charges. Intervals are bootstrap 95% CIs (2,000 resamples, seed 42).\n')

out.push('### By arm\n')
out.push('| Arm | Runs | Accepted | Cost per accepted task | Opus USD per accepted task | Median wall time | Runs with commits |')
out.push('|---|---:|---:|---:|---:|---:|---:|')
for (const a of armIds) {
  const rs = valid.filter((r) => r.arm === a)
  const acc = rs.map((r) => (r.accepted ? 1 : 0))
  out.push(`| ${ARMS[a].label} | ${rs.length} | ${pct(mean(acc))}${ci(bootstrapCI(acc, mean), pct)} | ${usd(costPerAccepted(rs))}${ci(bootstrapCI(rs, costPerAccepted), usd)} | ` +
    `${usd(opusPerAccepted(rs))}${ci(bootstrapCI(rs, opusPerAccepted), usd)} | ${median(rs.map((r) => r.wall_s).filter(Number.isFinite)) ?? 'n/a'}s | ${rs.filter((r) => r.commits_made > 0).length} |`)
}

out.push('\n### Accepted runs by cohort\n')
out.push(`| Cohort | ${armIds.join(' | ')} |`)
out.push(`|---|${armIds.map(() => '---:').join('|')}|`)
for (const c of cohorts) {
  out.push(`| ${c} | ${armIds.map((a) => { const rs = valid.filter((r) => r.arm === a && r.cohort === c); return `${rs.filter((r) => r.accepted).length}/${rs.length}` }).join(' | ')} |`)
}

out.push('\n### Non-inferiority check (declared before the runs)\n')
out.push('Rule: per cohort, an AutoMode arm accepts no fewer runs than the best baseline minus one, and in critical cohorts it accepts no fewer than the best baseline.\n')
const baseArms = armIds.filter((a) => BASELINES.includes(a))
for (const a of armIds.filter((x) => x.startsWith('v2'))) {
  const fails = []
  for (const c of cohorts) {
    const count = (arm) => valid.filter((r) => r.arm === arm && r.cohort === c && r.accepted).length
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
  const by = {}
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
