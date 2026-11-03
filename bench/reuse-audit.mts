#!/usr/bin/env node
// reuse-audit.mts <results.jsonl> --changed hooks/lib/rescue.ts[,...] [--from <sha> --to <sha>] [--arm a]
// For each finished row: may it stand after the code change, or must it be paid for again, and why. It reads the
// row's plugin records and replays its transcript through the current ladder code. No model call. With --from and
// --to it computes the changed behavior files from git instead of --changed.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { BEHAVIOR } from './lib/identity.mts'
import { isResult } from './lib/outcome.mts'
import { readRows } from './lib/plan.mts'
import { replay, toolEvents } from './lib/replay.mts'
import { reuseDecision } from './lib/reuse.mts'
import { configDir } from './lib/run-evidence.mts'
import { findSession } from './transcript-fixture.mts'

export function changedBetween(from: string, to: string): string[] {
  return execFileSync('git', ['diff', '--name-only', from, to], { encoding: 'utf8' }).split('\n').filter((f) => f && BEHAVIOR.test(f) && !/\.test\.(ts|tsx|mts)$|\.md$/.test(f))
}

export function recordedEscalations(sessionId: string | null): number | null {
  if (!sessionId) return null
  const f = path.join(configDir(), 'plugins', 'data', 'automode', 'records', `${sessionId}.jsonl`)
  if (!fs.existsSync(f)) return null
  return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes('"kind":"escalation"') && !l.includes('"action":"none"')).length
}

export function audit(rows: any[], changed: string[]) {
  return rows.filter(isResult).map((r) => {
    const file = r.session_id ? findSession(r.session_id) : null
    const replayed = file ? replay(toolEvents(file), { stop: !!r.plugin?.config?.completionGate && r.plugin.config.completionGate === 'block' }).escalations : null
    const d = reuseDecision({ sameOtherwise: [], changed, recordedEscalations: recordedEscalations(r.session_id), replayedEscalations: replayed })
    return { run_id: r.run_id, arm: r.arm, task: r.task_id, cost: r.cost_usd_api_equiv ?? 0, ...d }
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const arg = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }
  const file = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))
  if (!file) { console.error('usage: reuse-audit.mts <results.jsonl> --changed a,b | --from sha --to sha'); process.exit(1) }
  const changed = arg('from') && arg('to') ? changedBetween(arg('from')!, arg('to')!) : (arg('changed') ?? '').split(',').filter(Boolean)
  const rows = readRows(file).filter((r) => !arg('arm') || r.arm === arg('arm'))
  const out = audit(rows, changed)
  for (const o of out) console.log(`${o.reuse ? 'REUSE ' : 'RERUN '} ${o.task.slice(0, 32).padEnd(32)} ${o.arm.padEnd(20)} $${o.cost.toFixed(2)}  ${o.why}`)
  const keep = out.filter((o) => o.reuse), pay = out.filter((o) => !o.reuse)
  console.log(`\nchanged: ${changed.join(', ') || 'nothing'}. ${keep.length} rows stand ($${keep.reduce((a, o) => a + o.cost, 0).toFixed(2)} not paid again), ${pay.length} rerun ($${pay.reduce((a, o) => a + o.cost, 0).toFixed(2)} expected).`)
}
