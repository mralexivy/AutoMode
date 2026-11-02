// Selective execution (bench/lib/select.mts): the three parts, their rules, and the pr-check experiment.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SNAPSHOT } from '../tests/golden/auto-route-records.ts'
import { outcomeOf, routeAuto, type AutoRouteInput } from '../hooks/lib/auto-route.ts'
import { controls, disagreement, impactsOf, prCheckExperiment, select, sentinels } from './lib/select.mts'
import { replayable, type BatchPolicy } from './lib/route-replay.mts'
import { policy as mutant } from './fixtures/mutant-drop-critical-floor.mts'
import { experimentProblems } from './lib/experiment.mts'
import { ARMS } from './arms.mts'

const local: BatchPolicy = (inputs) => inputs.map((i) => outcomeOf(routeAuto(i)))
const broken: BatchPolicy = (inputs) => inputs.map(mutant)
// One synthetic task per snapshot case, holding that session's recorded route inputs.
const inputsByTask: Record<string, AutoRouteInput[]> = Object.fromEntries(Object.entries(SNAPSHOT as Record<string, any[]>).map(([name, recs]) => [name, replayable(recs).rows.map((r) => r.input)]))

test('changed files map to impact categories; the wiring files pull in all of them', () => {
  assert.deepEqual(impactsOf(['hooks/lib/failures.ts']).map((i) => i.id), ['escalation'])
  assert.deepEqual(impactsOf(['hooks/lib/compact.ts', 'agents/explorer.md']).map((i) => i.id), ['delegation', 'context'])
  assert.deepEqual(impactsOf(['README.md']), [])
  assert.equal(impactsOf(['hooks/v4.ts']).length, 4)
})

test('disagreement finds the tasks a broken policy moves, and nothing for the same policy', () => {
  assert.deepEqual(disagreement(inputsByTask, local, local, 10), [])
  const picks = disagreement(inputsByTask, local, broken, 10)
  assert.ok(picks.length > 0)
  assert.ok(picks.every((p) => p.distance! > 0 && p.part === 'disagreement'))
  assert.ok(picks.some((p) => /critical/.test(p.task)), JSON.stringify(picks))
})

test('sentinels read AutoMode runs only, ranked by how many runs showed the evidence', () => {
  const row = (task: string, kind: string, escalations: number) => ({ task_id: task, plugin: { kind }, judge: { escalations } })
  const rows = [row('a', 'automode', 1), row('a', 'automode', 2), row('b', 'automode', 1), row('c', 'none', 5), row('d', 'automode', 0)]
  const picks = sentinels(rows, impactsOf(['hooks/lib/failures.ts']), 3)
  assert.deepEqual(picks.map((p) => p.task), ['a', 'b'])
  assert.match(picks[0].why, /escalation: a run escalated in 2 runs/)
})

test('controls are fixed per cohort and never read results', () => {
  const tasks = [{ id: 't1', cohort: 'x' }, { id: 't2', cohort: 'x' }, { id: 't3', cohort: 'y' }]
  const once = controls(tasks, 1)
  assert.deepEqual(controls([...tasks].reverse(), 1), once)
  assert.equal(once.length, 2)
  assert.deepEqual(once.map((p) => p.part), ['control', 'control'])
})

test('a selection states its rules and its scope, and drops unknown tasks', () => {
  const tasks = [{ id: 'critical floor', cohort: 'x' }, { id: 'other', cohort: 'y' }]
  const s = select({ inputsByTask, a: local, b: broken, rows: [], files: ['hooks/lib/auto-route.ts'], tasks })
  assert.ok(s.tasks.includes('critical floor'))
  assert.ok(s.picks.every((p) => tasks.some((t) => t.id === p.task)))
  assert.deepEqual(Object.keys(s.rules), ['disagreement', 'sentinel', 'control'])
  assert.match(s.scope, /selected tasks only/)
  assert.match(s.scope, /not a claim of non-inferiority or improvement/)
  assert.equal(select({ inputsByTask, a: local, b: null, rows: [], files: [], tasks }).picks.filter((p) => p.part === 'disagreement').length, 0)
})

test('a pr-check experiment names its tasks, fixes repeats and budget, and asks for the status line', () => {
  const e = prCheckExperiment('route-floor', ['a', 'b'])
  assert.deepEqual(experimentProblems(e, Object.keys(ARMS)), [])
  assert.equal(e.id, 'pr-check-route-floor')
  assert.deepEqual(e.tasks, ['a', 'b'])
  assert.ok(e.repeats >= 2)
  assert.equal(e.budget_usd, 10)
  assert.equal(e.prompt_template, 'repo-change-v2')
  assert.throws(() => prCheckExperiment('x', []), /no task/)
})
