#!/usr/bin/env node
// proof-report.mts --experiment <id> --policies a.json,b.json [--out file.md]
// Writes the publishable report of a paired experiment from its result rows and the decision policies fixed before
// any row. No model call: anyone can rerun it on the committed rows and get the same numbers.
import fs from 'node:fs'
import path from 'node:path'
import { ARMS } from './arms.mts'
import { decide, rowClass, valid, type Policy } from './lib/decide.mts'
import { loadExperiment } from './lib/experiment.mts'
import { readRows } from './lib/plan.mts'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const usd = (x: number | null | undefined) => (x === null || x === undefined ? '-' : `$${x.toFixed(2)}`)
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)] }

export function report(id: string, policies: Policy[], file = path.join(REPO, 'bench', 'results', `${id}.jsonl`)): string {
  const e = loadExperiment(id, Object.keys(ARMS))
  const rows = readRows(file)
  const lines: string[] = []
  const fin = rows.filter((r) => valid(rowClass(r)))
  const tasks = new Set(fin.map((r) => r.task_id))
  lines.push(`# ${id}: results`, '')
  lines.push(`${e.description}`, '')
  lines.push(`Rows: ${rows.length} paid attempts, ${fin.length} valid runs over ${tasks.size} tasks. Costs are list-price equivalents (\`cost_usd_api_equiv\`). They count every paid attempt, cut-off ones included. Runs used a Claude subscription, so no money was billed per run.`, '')
  lines.push('## By arm', '', '| Arm | What it is | Accepted | Paid attempts | Spend | $ per accepted | Median minutes |', '|---|---|---:|---:|---:|---:|---:|')
  for (const a of e.arms) {
    const rs = rows.filter((r) => r.arm === a), ok = rs.filter((r) => rowClass(r) === 'accepted'), v = rs.filter((r) => valid(rowClass(r)))
    const spend = rs.reduce((x, r) => x + (r.cost_usd_api_equiv ?? 0), 0)
    lines.push(`| \`${a}\` | ${ARMS[a].label} | ${ok.length} of ${v.length} | ${rs.length} | ${usd(spend)} | ${usd(ok.length ? spend / ok.length : null)} | ${median(v.map((r) => (r.wall_s ?? 0) / 60))?.toFixed(1) ?? '-'} |`)
  }
  lines.push('', '## Decisions', '', 'Each policy was committed before the first row. Thresholds never move after a row exists.', '')
  for (const p of policies) {
    const d = decide(rows, p)
    lines.push(`### ${p.id}: **${d.status}**`, '', `> ${(p as any).question ?? ''}`, '')
    lines.push(`- Pairs: ${d.pairs}. \`${p.treatment}\` accepted ${d.treatment.accepted}, \`${p.control}\` accepted ${d.control.accepted}. Net tasks lost by \`${p.treatment}\`: ${d.pass_loss}.`)
    lines.push(`- Cost per accepted: ${usd(d.treatment.usd_per_accepted)} against ${usd(d.control.usd_per_accepted)}. Paired ratio ${d.cost_ratio ?? '-'}, 90% bootstrap interval ${d.cost_ratio_ci ? `${d.cost_ratio_ci[0]} to ${d.cost_ratio_ci[1]}` : '-'}.`)
    if (d.discordant.treatment_only.length) lines.push(`- Only \`${p.treatment}\` passed: ${d.discordant.treatment_only.join(', ')}.`)
    if (d.discordant.control_only.length) lines.push(`- Only \`${p.control}\` passed: ${d.discordant.control_only.join(', ')}.`)
    for (const b of d.blockers) lines.push(`- Blocker: ${b}.`)
    if (d.next) lines.push(`- Next: ${d.next}.`)
    lines.push('')
  }
  lines.push('## By task', '', `| Task | ${e.arms.map((a) => `\`${a}\``).join(' | ')} |`, `|---|${e.arms.map(() => '---').join('|')}|`)
  for (const t of [...new Set(rows.map((r) => r.task_id))].sort()) {
    const cell = (a: string) => { const v = rows.filter((r) => r.task_id === t && r.arm === a); const last = [...v].reverse().find((r) => valid(rowClass(r))); const cost = v.reduce((x, r) => x + (r.cost_usd_api_equiv ?? 0), 0); return last ? `${last.accepted ? 'pass' : 'fail'} ${usd(cost)}` : v.length ? `no result ${usd(cost)}` : '-' }
    lines.push(`| ${t} | ${e.arms.map(cell).join(' | ')} |`)
  }
  lines.push('', '## What this does and does not show', '')
  lines.push(`- **Scale.** ${tasks.size} tasks with 1 repetition is a release signal of limited precision. It is not a general claim, and the intervals above say how wide the uncertainty is.`)
  lines.push('- **Quality.** The hidden tests decide acceptance: the full suite of the task, never a subset the agent picked. No judge score is used here.')
  lines.push('- **Sample.** The 4 tasks that failed in earlier rounds are in the set on purpose, so the escalation ladder is exercised. The other 26 come in SHA-256 order, at most 3 per repository, with no held-out task.')
  lines.push('- **Order.** The arms ran interleaved by task on the same day and machine. A change in model availability during the run would affect all arms alike.')
  lines.push('', '## Reproduce', '', '```bash')
  lines.push(`node bench/proof-report.mts --experiment ${id} --policies ${policies.map((p) => `bench/experiments/policies/${p.id}.json`).join(',')}   # this report, no model call`)
  lines.push(`node bench/decide.mts bench/results/${id}.jsonl --policy bench/experiments/policies/${policies[0].id}.json   # one decision`)
  lines.push(`node bench/regrade.mts bench/results/${id}.jsonl --diffs bench/results/diffs   # regrade the saved diffs, no model call`)
  lines.push(`node bench/preflight.mts --experiment ${id} && node bench/run.mts --experiment ${id}   # a fresh paid rerun into a new results file (--out)`)
  lines.push('```', '')
  return lines.join('\n')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }
  const id = arg('experiment')
  const pols = (arg('policies') ?? '').split(',').filter(Boolean).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
  if (!id || !pols.length) { console.error('usage: proof-report.mts --experiment <id> --policies a.json,b.json [--out file.md]'); process.exit(1) }
  const md = report(id, pols)
  if (arg('out')) fs.writeFileSync(arg('out')!, md)
  else console.log(md)
}
