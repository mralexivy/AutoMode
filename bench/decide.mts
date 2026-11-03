#!/usr/bin/env node
// decide.mts <results.jsonl ...> --policy <file> [--grades <grades.jsonl>] [--out decision.json]
// Applies a decision policy to graded rows: SHIP, DO_NOT_SHIP or INCONCLUSIVE, with blockers. No model call. A
// regrade file (bench/regrade.mts) overrides each row's verdict by run id, so a grader fix needs no rerun.
import fs from 'node:fs'
import { decide, type Policy } from './lib/decide.mts'
import { readRows } from './lib/plan.mts'

const argv = process.argv.slice(2)
const arg = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }
const files = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))
const policyFile = arg('policy')
if (!files.length || !policyFile) { console.error('usage: decide.mts <results.jsonl ...> --policy <file> [--grades file] [--out file]'); process.exit(1) }
const policy: Policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'))
const grades = new Map((arg('grades') ? readRows(arg('grades')!) : []).map((g) => [g.run_id, g]))
const rows = files.flatMap(readRows).map((r) => (grades.has(r.run_id) ? { ...r, accepted: grades.get(r.run_id).accepted, regraded: grades.get(r.run_id).grading_key } : r))
const d = decide(rows, policy)
const out = arg('out')
if (out) fs.writeFileSync(out, JSON.stringify(d, null, 1))
console.log(`${d.status} under ${d.policy}: ${d.pairs} pairs; ${policy.treatment} ${d.treatment.accepted}/${d.treatment.valid} at $${d.treatment.usd_per_accepted ?? '-'} per accepted, ${policy.control} ${d.control.accepted}/${d.control.valid} at $${d.control.usd_per_accepted ?? '-'}; ratio ${d.cost_ratio ?? '-'} CI ${d.cost_ratio_ci?.join('-') ?? '-'}`)
for (const b of d.blockers) console.log(`  blocker: ${b}`)
if (d.next) console.log(`  next: ${d.next}`)
