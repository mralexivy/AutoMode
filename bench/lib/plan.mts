// The plan of an experiment: every slot (task x arm x repetition) with its run id, and what is already known about it.
// bench/run.mts and bench/preflight.mts both build it here, so the plan hash the preflight signs is the one the runner
// checks. No model call.
import fs from 'node:fs'
import path from 'node:path'
import { ARMS } from '../arms.mts'
import type { ExperimentSpec } from './experiment.mts'
import { foldEvents, readEvents, eventsFile } from './events.mts'
import { compareIdentity, type Identity } from './identity.mts'
import { isDone, isResult } from './outcome.mts'
import { loadTemplate } from './prompt.mts'
import { runIdFor } from './run-one.mts'
import type { Task } from './task-repo.mts'
import { planHash } from './gate.mts'

export interface Slot { task: Task; arm: string; rep: number; runId: string; identity: Identity }
export type SlotStatus = 'done' | 'reuse' | 'unknown' | 'stale' | 'new'
export interface SlotView { run_id: string; task: string; arm: string; rep: number; status: SlotStatus; why: string }

export const readRows = (file: string): any[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : [])

export function slotsFor(tasks: Task[], arms: string[], repeats: number, template?: string): Slot[] {
  const out: Slot[] = []
  for (let rep = 1; rep <= repeats; rep++) for (const t of tasks) for (const a of arms) {
    const { runId, identity } = runIdFor(t, a, rep, loadTemplate(template ?? t.prompt_template ?? 'repo-change-v1'))
    out.push({ task: t, arm: a, rep, runId, identity })
  }
  return out
}

export const hashOf = (e: ExperimentSpec | null, slots: Slot[], budget: number | null, runCap: number | null) =>
  planHash({ experiment: e?.id ?? 'adhoc', runIds: slots.map((s) => s.runId), budget, runCap, policy: e?.decision ?? null })

// classify says, for each slot, what a run would do and why: skip a finished row, copy a reusable one, hold an
// unknown one, or pay. A row for the same task, arm and repetition with another id is stale, and the parts of its
// identity that moved are named, so nobody has to guess why it reruns.
export function classify(slots: Slot[], out: string, reuseFrom: string[] = []): SlotView[] {
  const rows = readRows(out)
  const done = new Map(rows.filter(isDone).map((r) => [r.run_id, r]))
  const earlier = reuseFrom.flatMap(readRows).filter((r) => isResult(r) && r.identity)
  const reuse = new Map(earlier.map((r) => [r.run_id, r]))
  const state = foldEvents(readEvents(eventsFile(out)))
  const all = [...rows, ...earlier]
  return slots.map((s) => {
    const base = { run_id: s.runId, task: s.task.id, arm: s.arm, rep: s.rep }
    if (done.has(s.runId)) return { ...base, status: 'done' as const, why: 'finished row in this results file' }
    if (reuse.has(s.runId)) return { ...base, status: 'reuse' as const, why: `same run id in ${path.basename(String(reuse.get(s.runId)!.experiment ?? 'an earlier file'))}` }
    if (state.get(s.runId)?.state === 'UNKNOWN') return { ...base, status: 'unknown' as const, why: state.get(s.runId)!.reason ?? 'started, no result' }
    const old = all.find((r) => r.task_id === s.task.id && r.arm === s.arm && r.repeat === s.rep && isResult(r))
    if (old) return { ...base, status: 'stale' as const, why: `an older row (${old.run_id.split('__').pop()}) differs in: ${compareIdentity(old.identity, s.identity).join(', ')}` }
    return { ...base, status: 'new' as const, why: 'no row yet' }
  })
}

export const isPluginArm = (a: string) => ARMS[a]?.plugin?.kind === 'automode'
