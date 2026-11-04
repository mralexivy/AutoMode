#!/usr/bin/env node
// v6-baseline.mts [results.jsonl ...]: the v6 starting point, read from committed rows. No model call.
// For each run it prints the auto arm split by route against Sonnet high on the same tasks, and every auto row's
// state: valid, cut off, unknown, contaminated or invalid. With no file, it reads the v2, v4 and v5 proof runs.
import fs from 'node:fs'
import path from 'node:path'
import { rowClass, valid } from './lib/decide.mts'
import { readRows } from './lib/plan.mts'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const RUNS = ['automode-proof-v2', 'automode-proof-v4', 'automode-proof-v5'].map((id) => path.join(REPO, 'bench', 'results', `${id}.jsonl`))

// Rows a run's own record marks as contaminated: bench/experiments/automode-proof-v5.json names them. A row that sets
// `contaminated` itself (bench/run.mts, from v6 on) needs no entry here.
export const CONTAMINATED: Record<string, string[]> = {
  'automode-proof-v5': ['feature-tomlkit-replace-dotted-with-table', 'feature-xmltodict-selective-cdata', 'longctx-dnspython-edns-padding'],
}

export type RouteKind = 'haiku only' | 'sonnet only' | 'opus only' | 'switched'
// routeOf: the models a row's own requests went to, read from its evidence.
export function routeOf(r: any): RouteKind {
  const fams = [...new Set(Object.keys(r.evidence?.requests ?? r.model_usage ?? {}).map((m) => (/haiku/.test(m) ? 'haiku' : /opus/.test(m) ? 'opus' : 'sonnet')))]
  return fams.length === 1 ? (`${fams[0]} only` as RouteKind) : 'switched'
}

export function stateOf(r: any, experiment: string): string {
  if (r.contaminated || CONTAMINATED[experiment]?.includes(r.task_id)) return 'contaminated'
  const c = rowClass(r)
  if (valid(c)) return 'valid'
  return c === 'infra_interrupted' ? (r.exit_reason === 'quota' ? 'cut off' : 'unknown') : 'invalid'
}

export interface Baseline {
  experiment: string
  arms: Record<string, { tasks: number; accepted: number; usd: number }>
  routes: Record<string, { tasks: number; usd: number; sonnet: number }>
  states: Record<string, number>
}

// baseline: the last valid row per task and arm decides the outcome; every paid attempt counts in the cost.
export function baseline(rows: any[], experiment: string): Baseline {
  const paid = (arm: string, task: string) => rows.filter((r) => r.arm === arm && r.task_id === task).reduce((s, r) => s + (r.cost_usd_api_equiv ?? 0), 0)
  const last = (arm: string, task: string) => [...rows].reverse().find((r) => r.arm === arm && r.task_id === task && valid(rowClass(r)))
  const out: Baseline = { experiment, arms: {}, routes: {}, states: {} }
  const tasks = [...new Set(rows.map((r) => r.task_id))].sort()
  for (const arm of [...new Set(rows.map((r) => r.arm))]) {
    const a = { tasks: 0, accepted: 0, usd: 0 }
    for (const t of tasks) { const l = last(arm, t); if (!l) continue; a.tasks++; if (l.accepted) a.accepted++; a.usd += paid(arm, t) }
    out.arms[arm] = a
  }
  for (const t of tasks) {
    const l = last('auto', t)
    if (!l || !last('sonnet-high', t)) continue
    const k = routeOf(l)
    out.routes[k] ??= { tasks: 0, usd: 0, sonnet: 0 }
    out.routes[k].tasks++
    out.routes[k].usd += paid('auto', t)
    out.routes[k].sonnet += paid('sonnet-high', t)
  }
  for (const r of rows.filter((x) => x.arm === 'auto' && !x.reused_from)) { const s = stateOf(r, experiment); out.states[s] = (out.states[s] ?? 0) + 1 }
  return out
}

const usd = (x: number) => `$${x.toFixed(2)}`

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2).length ? process.argv.slice(2) : RUNS.filter((f) => fs.existsSync(f))
  for (const f of files) {
    const id = path.basename(f, '.jsonl')
    const b = baseline(readRows(f), id)
    console.log(`\n## ${id}`)
    for (const [arm, a] of Object.entries(b.arms)) console.log(`${arm.padEnd(13)} ${a.accepted}/${a.tasks} accepted, ${usd(a.usd)}`)
    console.log('auto by route, against sonnet-high on the same tasks:')
    for (const [k, v] of Object.entries(b.routes)) console.log(`  ${k.padEnd(12)} ${String(v.tasks).padStart(2)} tasks  auto ${usd(v.usd)}  sonnet-high ${usd(v.sonnet)}  difference ${v.usd - v.sonnet >= 0 ? '+' : ''}${usd(v.usd - v.sonnet)}`)
    console.log(`auto row states: ${Object.entries(b.states).map(([k, n]) => `${k} ${n}`).join(', ')}`)
  }
}
