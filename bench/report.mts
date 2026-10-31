#!/usr/bin/env node
// Summarizes bench/results/*.jsonl into markdown. Every number comes from the raw rows.
// Usage: node bench/report.mts [--manifest out.json] [results.jsonl ...] > summary.md
import fs from 'node:fs'
import path from 'node:path'
import { ARMS } from './arms.mts'
import { isDone, isResult } from './lib/outcome.mts'
import { buildManifest } from './lib/manifest.mts'
import { bootstrapCI, discordant, holm, mcnemarExact, pairedDelta, paretoFrontier, routeSummary, routingRegret, type ArmOutcome } from './lib/stats.mts'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const argv = process.argv.slice(2)
const mi = argv.indexOf('--manifest')
const manifestFile = mi >= 0 ? argv[mi + 1] : null
const named = argv.filter((_, i) => mi < 0 || (i !== mi && i !== mi + 1))
const files = named.length ? named
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
const opts = { cohortOf: (r: any) => r.cohort }
const signed = (f: (x: number) => string) => (x: number) => `${x > 0 ? '+' : ''}${f(x)}`
const points = (x: number) => `${(100 * x).toFixed(0)} pts`
const money = (x: number) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`
const seconds = (x: number) => `${x.toFixed(0)}s`
const rowWall = (r: any) => r.latency?.total_ms != null ? r.latency.total_ms / 1000 : r.wall_s ?? 0
const pct = (x: number | null) => (x === null ? 'n/a' : `${(100 * x).toFixed(0)}%`)
const usd = (x: number | null) => (x === null ? 'n/a' : `$${x.toFixed(2)}`)
const ci = ([lo, hi]: [number | null, number | null], f: (x: number) => string) => (lo === null ? '' : ` [${f(lo)}–${f(hi)}]`)

const armIds = Object.keys(ARMS).filter((a) => valid.some((r) => r.arm === a))
const cohorts = [...new Set(valid.map((r) => r.cohort))].sort()
const out = []
out.push(`Runs: ${rows.length} rows, ${valid.length} valid, ${rows.filter((r) => r.harness_error).length} harness errors, ${contaminated.length} excluded for memory contamination, ${notRun.length} stopped by a usage limit or setup, ${valid.filter((r) => r.cost_usd_api_equiv == null).length} with no reported cost. Tasks: ${[...new Set(valid.map((r) => r.task_id))].length}. Cohorts: ${cohorts.join(', ')}.`)
out.push('All USD values are API list-price equivalents from the CLI, not subscription charges. Intervals are bootstrap 95% CIs that resample tasks, then repeats, stratified by cohort (2,000 resamples, seed 42).\n')

out.push('### By arm\n')
out.push('| Arm | Runs | Accepted | Cost per accepted task | Opus USD per accepted task | Median wall time | Runs with commits |')
out.push('|---|---:|---:|---:|---:|---:|---:|')
for (const a of armIds) {
  const rs = valid.filter((r) => r.arm === a)
  out.push(`| ${ARMS[a].label} | ${rs.length} | ${pct(acceptRate(rs))}${ci(bootstrapCI(rs, taskOf, acceptRate, opts), pct)} | ${usd(costPerAccepted(rs))}${ci(bootstrapCI(rs, taskOf, costPerAccepted, opts), usd)} | ` +
    `${usd(opusPerAccepted(rs))}${ci(bootstrapCI(rs, taskOf, opusPerAccepted, opts), usd)} | ${median(rs.map((r) => r.wall_s).filter(Number.isFinite)) ?? 'n/a'}s | ${rs.filter((r) => r.commits_made > 0).length} |`)
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

const tasksSeen = new Set(valid.map(taskOf)).size
if (tasksSeen < 30) out.splice(1, 0, `**Pilot: ${tasksSeen} tasks. This is too few to support a claim, and intervals may be wide or optimistic.**`)

out.push('\n### Paired comparison against fixed arms\n')
out.push('Each row is the AutoMode arm minus the fixed arm, on the tasks both ran. p is the exact McNemar test on per-task majority verdicts, Holm-adjusted across the rows of one AutoMode arm.\n')
out.push('| AutoMode arm | Fixed arm | Tasks | Solved | Mean cost | Mean wall time | Only fixed solved | Only AutoMode solved | p (Holm) |')
out.push('|---|---|---:|---:|---:|---:|---:|---:|---:|')
for (const a of armIds.filter((x) => ARMS[x].v4)) {
  const mine = valid.filter((r) => r.arm === a)
  const compared = baseArms.map((b) => {
    const theirs = valid.filter((r) => r.arm === b)
    return { b, theirs, d: discordant(theirs, mine, taskOf, (r: any) => r.accepted === true) }
  })
  const adjusted = holm(compared.map((c) => mcnemarExact(c.d.onlyA, c.d.onlyB)))
  compared.forEach(({ b, theirs, d }, i) => {
    const solved = pairedDelta(theirs, mine, taskOf, acceptRate, opts)
    const cost = pairedDelta(theirs, mine, taskOf, (rs) => mean(rs.map(runCost)), opts)
    const wall = pairedDelta(theirs, mine, taskOf, (rs) => mean(rs.map(rowWall)), opts)
    const cell = (x: typeof solved, f: (v: number) => string) => (x.delta === null ? 'n/a' : `${signed(f)(x.delta)}${ci(x.ci, signed(f))}`)
    out.push(`| ${ARMS[a].label} | ${ARMS[b].label} | ${solved.tasks} | ${cell(solved, points)} | ${cell(cost, money)} | ${cell(wall, seconds)} | ${d.onlyA} | ${d.onlyB} | ${adjusted[i].toFixed(3)} |`)
  })
}

const perArm = armIds.map((a) => { const rs = valid.filter((r) => r.arm === a); return { id: a, quality: acceptRate(rs) ?? 0, cost: mean(rs.map(runCost)) ?? 0, wall: mean(rs.map(rowWall)) ?? 0 } })
out.push('\n### Pareto frontiers\n')
out.push('An arm is on a frontier when no other arm is as good on both measures and better on one.\n')
out.push(`- Solved rate and mean cost: ${paretoFrontier(perArm).map((p) => p.id).join(', ') || 'n/a'}`)
out.push(`- Solved rate and mean wall time: ${paretoFrontier(perArm.map((p) => ({ ...p, cost: p.wall }))).map((p) => p.id).join(', ') || 'n/a'}`)

const taskOutcomes: ArmOutcome[][] = [...new Set(valid.map(taskOf))].map((t) => armIds.flatMap((a) => {
  const rs = valid.filter((r) => r.task_id === t && r.arm === a)
  return rs.length ? [{ arm: a, quality: acceptRate(rs), cost: mean(rs.map(runCost)), wall: mean(rs.map(rowWall)) }] : []
}))
out.push('\n### Routing quality\n')
out.push('Regret and these measures are relative to the arms that ran, so they say nothing about arms left out. A task counts as solved at a majority of its repeats. Lambda values are illustrative, not a recommended trade-off.\n')
out.push('| AutoMode arm | Tasks | On the cost frontier | Median excess cost when solved | Failures another arm solved | Solved where a cheaper arm solved too | Mean regret (λ $0.1, 0) | (λ $0.5, 0) | (λ $0.1, 0.001/s) |')
out.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|')
for (const a of armIds.filter((x) => ARMS[x].v4)) {
  const s = routeSummary(taskOutcomes, a)
  const regret = (lc: number, lw: number) => mean(taskOutcomes.map((t) => routingRegret(t, a, lc, lw)).filter((x) => x !== null))
  const n = (x: number | null) => (x === null ? 'n/a' : x.toFixed(3))
  out.push(`| ${ARMS[a].label} | ${s.tasks} | ${pct(s.pareto_share)} | ${usd(s.median_excess_usd)} | ${s.failures_another_arm_solved}/${s.failures} | ${s.solved_where_cheaper_arm_also_solved}/${s.solved} | ${n(regret(0.1, 0))} | ${n(regret(0.5, 0))} | ${n(regret(0.1, 0.001))} |`)
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
if (manifestFile) fs.writeFileSync(manifestFile, JSON.stringify(buildManifest(files), null, 2) + '\n')
