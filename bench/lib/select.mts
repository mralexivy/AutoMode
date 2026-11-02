// Selective execution: which tasks a change to the router should run on. Pure: no I/O.
//
// Contract:
// - Three parts, each with its rule recorded in the output:
//   disagreement  tasks whose recorded first route moves between policy A and policy B, ranked by route distance.
//   sentinel      tasks whose past runs used the behaviour the changed files own (escalation, delegation, the
//                 completion gate, context). Two policies can share a first route and still part later.
//   control       a fixed, small set across cohorts that always runs.
// - Every part is deterministic. No task is drawn at random, so a conclusion covers the selected tasks only, and the
//   output says so. Selection never stops a run early: repeats and budget come from the experiment file.
import crypto from 'node:crypto'
import type { AutoRouteInput, RouteOutcome } from '../../hooks/lib/auto-route.ts'
import { routeDistance, type BatchPolicy } from './route-replay.mts'

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

export interface Impact { id: string; files: RegExp; evidence: (row: any) => boolean; what: string }

// IMPACTS maps changed files to the run evidence that shows a task exercises them. hooks/v4.ts and register.ts wire
// every behaviour, so a change there pulls in every category.
export const IMPACTS: Impact[] = [
  { id: 'escalation', files: /^hooks\/lib\/(failures|bands|triggers)\.ts$/, evidence: (r) => (r.judge?.escalations ?? 0) > 0, what: 'a run escalated' },
  { id: 'delegation', files: /^(hooks\/lib\/(delegation|subagents|workers|guard|strategy)\.ts|agents\/.*|workflows\/.*)$/, evidence: (r) => (r.judge?.workers?.length ?? 0) > 0 || (r.evidence?.tool_calls?.calls?.Agent ?? 0) > 0, what: 'a run delegated to an agent' },
  { id: 'verification', files: /^hooks\/lib\/(completion|operations|envelope)\.ts$/, evidence: (r) => typeof r.completion?.gate_state === 'string', what: 'the completion gate judged a run' },
  { id: 'context', files: /^hooks\/lib\/(compact|continuity|rent|policy|mode)\.ts$/, evidence: (r) => (r.evidence?.compactions ?? 0) > 0 || (r.evidence?.peak_prompt_tokens ?? 0) >= 150_000, what: 'a run compacted or passed 150k tokens' },
]
const WIRING = /^hooks\/(v4|register)\.ts$/

export function impactsOf(files: string[]): Impact[] {
  if (files.some((f) => WIRING.test(f))) return IMPACTS
  return IMPACTS.filter((i) => files.some((f) => i.files.test(f)))
}

export interface Pick { task: string; part: 'disagreement' | 'sentinel' | 'control'; why: string; distance?: number }

// disagreement: route each task's recorded first-route inputs under both policies. A task's distance is its largest.
export function disagreement(inputsByTask: Record<string, AutoRouteInput[]>, a: BatchPolicy, b: BatchPolicy, top: number): Pick[] {
  const tasks = Object.keys(inputsByTask).filter((t) => inputsByTask[t].length).sort()
  const inputs = tasks.flatMap((t) => inputsByTask[t])
  if (!inputs.length) return []
  const [outA, outB] = [a(inputs), b(inputs)]
  let k = 0
  const scored = tasks.map((task) => {
    let best = 0, ex: [RouteOutcome, RouteOutcome] | null = null
    for (const _ of inputsByTask[task]) { const d = routeDistance(outA[k].route, outB[k].route); if (d > best) { best = d; ex = [outA[k], outB[k]] } k += 1 }
    return { task, distance: best, ex }
  })
  return scored.filter((s) => s.distance > 0).sort((x, y) => y.distance - x.distance || (sha(x.task) < sha(y.task) ? -1 : 1)).slice(0, top)
    .map((s) => ({ task: s.task, part: 'disagreement' as const, distance: s.distance, why: `first route ${s.ex![0].route} -> ${s.ex![1].route}` }))
}

// sentinels: for each impacted category, the tasks with the most AutoMode-arm runs that showed its evidence.
export function sentinels(rows: any[], impacts: Impact[], perImpact: number): Pick[] {
  const out: Pick[] = []
  for (const imp of impacts) {
    const hits: Record<string, number> = {}
    for (const r of rows) if (r?.plugin && r.plugin.kind === 'automode' && imp.evidence(r)) hits[r.task_id] = (hits[r.task_id] ?? 0) + 1
    Object.entries(hits).sort((x, y) => y[1] - x[1] || (sha(x[0]) < sha(y[0]) ? -1 : 1)).slice(0, perImpact)
      .forEach(([task, n]) => out.push({ task, part: 'sentinel', why: `${imp.id}: ${imp.what} in ${n} run${n === 1 ? '' : 's'}` }))
  }
  return out
}

// controls: per cohort, the first tasks in SHA-256 order of their id. The rule never looks at results.
export function controls(tasks: { id: string; cohort: string }[], perCohort: number): Pick[] {
  const byCohort: Record<string, string[]> = {}
  for (const t of tasks) (byCohort[t.cohort] ??= []).push(t.id)
  return Object.keys(byCohort).sort().flatMap((c) => byCohort[c].sort((x, y) => (sha(x) < sha(y) ? -1 : 1)).slice(0, perCohort).map((task) => ({ task, part: 'control' as const, why: `control for cohort ${c}` })))
}

// PR_CHECK fixes the run before any result exists: repeats, budget and template. Nothing stops early, because a
// significance test checked during collection inflates false alarms. bench/select.mts --experiment writes it with the
// picked tasks, so the experiment names its tasks like every other.
export const PR_CHECK = {
  schema_version: 1 as const, track: 'automode-system' as const, arms: ['auto', 'sonnet-high'], repeats: 2, parallel: 1,
  prompt_template: 'repo-change-v2', run_cap_usd: 1.5, budget_usd: 10, window_usd: 60,
  description: 'Regression discovery for a router change, on the tasks bench/select.mts picked. It never supports a claim of non-inferiority or improvement. See CANARIES.md.',
}

export function prCheckExperiment(name: string, tasks: string[]) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('the experiment name must be lowercase words with hyphens')
  if (!tasks.length) throw new Error('no task was selected')
  return { ...PR_CHECK, id: `pr-check-${name}`, tasks }
}

export interface Selection {
  rules: Record<string, string>
  picks: Pick[]
  tasks: string[]
  impacts: string[]
  unscored: number
  scope: string
}

export function select(o: { inputsByTask: Record<string, AutoRouteInput[]>; a: BatchPolicy; b: BatchPolicy | null; rows: any[]; files: string[]; tasks: { id: string; cohort: string }[]; top?: number; perImpact?: number; perCohort?: number }): Selection {
  const top = o.top ?? 6, perImpact = o.perImpact ?? 3, perCohort = o.perCohort ?? 1
  const impacts = impactsOf(o.files)
  const known = new Set(o.tasks.map((t) => t.id))
  const picks = [
    ...(o.b ? disagreement(o.inputsByTask, o.a, o.b, top) : []),
    ...sentinels(o.rows, impacts, perImpact),
    ...controls(o.tasks, perCohort),
  ].filter((p) => known.has(p.task))
  return {
    rules: {
      disagreement: `top ${top} tasks by first-route distance between the policies (a model change is 1, an effort step 0.25)`,
      sentinel: `for each category the changed files touch, the ${perImpact} tasks with the most AutoMode runs that showed it`,
      control: `per cohort, the first ${perCohort} task(s) in SHA-256 order of the id`,
    },
    picks, tasks: [...new Set(picks.map((p) => p.task))], impacts: impacts.map((i) => i.id),
    unscored: o.tasks.filter((t) => !o.inputsByTask[t.id]?.length).length,
    scope: 'Deterministic selection: a result covers the selected tasks only, and it is regression discovery, not a claim of non-inferiority or improvement.',
  }
}
