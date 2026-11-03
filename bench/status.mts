#!/usr/bin/env node
// status.mts --experiment <id> [--json]
// One machine-readable view of an experiment: its slots, what is reused or new, the money spent and the money that
// bought no result, the quota state, missing evidence, the gate and the decision. No model call.
import fs from 'node:fs'
import path from 'node:path'
import { ARMS } from './arms.mts'
import { decide, rowClass, valid, type Policy } from './lib/decide.mts'
import { eventsFile, foldEvents, readEvents } from './lib/events.mts'
import { loadExperiment } from './lib/experiment.mts'
import { gateProblem, readReport, reportPath } from './lib/gate.mts'
import { classify, hashOf, readRows, slotsFor } from './lib/plan.mts'
import { loadTasks } from './lib/task-repo.mts'
import { findSession } from './transcript-fixture.mts'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

export function status(id: string, out = path.join(REPO, 'bench', 'results', `${id}.jsonl`)) {
  const e = loadExperiment(id, Object.keys(ARMS))
  const tasks = loadTasks().filter((t) => (e.tasks ?? []).includes(t.id))
  const slots = slotsFor(tasks, e.arms, e.repeats, e.prompt_template)
  const views = classify(slots, out, (e.reuse_from ?? []).map((f) => path.resolve(REPO, f)))
  const rows = readRows(out)
  const planned = new Set(slots.map((s) => s.runId))
  const mine = rows.filter((r) => planned.has(r.run_id))
  const spent = rows.reduce((a, r) => a + (r.reused_from ? 0 : r.cost_usd_api_equiv ?? 0), 0)
  // Money that bought no result: cut-off, invalid or no-verdict attempts, and rows of this file the plan no longer uses.
  const wasted = rows.reduce((a, r) => a + (r.reused_from ? 0 : (!planned.has(r.run_id) || !valid(rowClass(r))) ? r.cost_usd_api_equiv ?? 0 : 0), 0)
  const states = [...foldEvents(readEvents(eventsFile(out))).values()]
  const stat = (() => { try { return JSON.parse(fs.readFileSync(out.replace(/\.jsonl$/, '') + '.status.json', 'utf8')) } catch { return null } })()
  const missing = mine.filter((r) => valid(rowClass(r)) && (!r.session_id || !findSession(r.session_id) || !fs.existsSync(path.join(path.dirname(out), 'diffs', `${r.run_id}.diff`)))).map((r) => r.run_id)
  const report = readReport(reportPath(path.dirname(out), id))
  const gate = gateProblem(report, hashOf(e, slots, e.budget_usd ?? null, e.run_cap_usd ?? null))
  const policy: Policy | null = e.decision && fs.existsSync(path.join(REPO, e.decision)) ? JSON.parse(fs.readFileSync(path.join(REPO, e.decision), 'utf8')) : null
  const d = policy && mine.length ? decide(mine, policy) : null
  const n = (s: string) => views.filter((v) => v.status === s).length
  return {
    experiment: id, expected_slots: views.length, completed_slots: n('done'), reused_slots: n('reuse'), new_paid_slots: n('new') + n('stale'), stale_slots: n('stale'), unknown_slots: n('unknown'),
    invalid_slots: mine.filter((r) => !valid(rowClass(r))).length, spent_list_usd: Math.round(spent * 100) / 100, wasted_list_usd: Math.round(wasted * 100) / 100,
    quota_status: stat?.state ?? (states.some((s) => s.state === 'QUOTA_PAUSED') ? 'quota_paused' : 'none'), reset_at: stat?.reset_at ?? null,
    missing_evidence: missing, gate_status: gate ?? 'pass', decision_status: d?.status ?? 'no rows', decision: d, slots: views,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--experiment')
  if (i < 0) { console.error('usage: status.mts --experiment <id> [--json]'); process.exit(1) }
  const s = status(process.argv[i + 1])
  if (process.argv.includes('--json')) { console.log(JSON.stringify(s, null, 1)); process.exit(0) }
  const { slots, decision, ...head } = s
  console.log(JSON.stringify(head, null, 1))
}
