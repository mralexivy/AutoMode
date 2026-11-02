import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMatrix, clopperPearson, COST_RATIO, falseCompletion, HEALTH_MIN_SHARE, observe, outcomeJson, outcomeReport, renderOutcomes, taskSignals,
} from './lib/outcomes.mts'

// row builds a schema 3 result row with only the fields the matrix reads.
let seq = 0
const row = (task: string, arm: string, repeat: number, accepted: boolean, o: Record<string, any> = {}) => ({
  run_id: `${task}__${arm}__r${repeat}__${seq++}`, task_id: task, cohort: 'feature', arm, repeat, exit_reason: 'done', spec_hash: `spec-${arm}`,
  model: { provider: 'anthropic', requestedModel: arm }, alias_map: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5' }, plugin: null,
  harness: { git_sha: 'aaa', dirty: false, runner: 'claude-code', platform: 'darwin-arm64' },
  accepted, cost_usd_api_equiv: 1, judge: null, memory_refs: 0, leak_refs: 0, at: `2026-11-0${repeat}T00:00:00Z`, ...o,
})
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`)
const report = (rows: any[], o: Record<string, any> = {}) => outcomeReport({ rows, ...o })

test('Clopper-Pearson matches known exact intervals', () => {
  // R binom.test(3, 10)$conf.int.
  const [lo, hi] = clopperPearson(3, 10)
  close(lo, 0.06673951)
  close(hi, 0.65245285)
  // Closed forms at the edges: x = 0 gives 1 - (a/2)^(1/n), and x = n gives (a/2)^(1/n).
  assert.deepEqual(clopperPearson(0, 5).map((x) => +x.toFixed(6)), [0, +(1 - 0.025 ** (1 / 5)).toFixed(6)])
  assert.deepEqual(clopperPearson(3, 3).map((x) => +x.toFixed(6)), [+(0.025 ** (1 / 3)).toFixed(6), 1])
  // One of two: 1 - sqrt(0.975) and its mirror.
  close(clopperPearson(1, 2)[0], 1 - Math.sqrt(0.975))
  close(clopperPearson(1, 2)[1], Math.sqrt(0.975))
  assert.equal(clopperPearson(0, 0), null, 'no trials gives no interval, not [0, 1] or zero')
})

test('repeats share a cell, and a changed identity splits it into a conflict', () => {
  const rows = [row('t', 'a', 1, true), row('t', 'a', 2, false), row('t', 'a', 3, true, { harness: { git_sha: 'bbb', dirty: false, runner: 'claude-code', platform: 'darwin-arm64' } })]
  const m = buildMatrix(rows.map((r) => observe(r)))
  const e = m.entries.find((x) => x.task_id === 't' && x.arm === 'a')
  assert.equal(e.status, 'conflict')
  assert.deepEqual(e.cells.map((c) => [c.n, c.accepted]), [[2, 1], [1, 1]], 'the two harness revisions are never pooled')
  assert.equal(e.primary.n, 2, 'the signals read the larger cell')

  // Every identity part splits: model, policy, spec, environment, grader and a dirty tree.
  const variants = [
    { alias_map: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-6' } },
    { plugin: { kind: 'automode', config: { policy: 'auto' } } },
    { spec_hash: 'other' },
    { harness: { git_sha: 'aaa', dirty: false, runner: 'neutral-agent', platform: 'darwin-arm64' } },
    { evidence: { sandbox_image: 'img@sha256:1' } },
    { harness: { git_sha: 'aaa', dirty: true, runner: 'claude-code', platform: 'darwin-arm64' } },
  ]
  for (const v of variants) assert.notEqual(observe(row('t', 'a', 1, true, v)).key, observe(row('t', 'a', 1, true)).key, JSON.stringify(v))
  assert.notEqual(observe(row('t', 'a', 1, true), { accept: 'pytest', hidden_tests: ['x'] }).key, observe(row('t', 'a', 1, true), { accept: 'pytest', hidden_tests: ['y'] }).key, 'the grader is part of the identity')
  assert.equal(observe(row('t', 'a', 1, true)).key, observe(row('t', 'a', 7, false)).key, 'repeat is not part of the identity')
})

test('a cell that never ran is missing, not zero', () => {
  const m = buildMatrix([row('t1', 'a', 1, true), row('t2', 'b', 1, false)].map((r) => observe(r)))
  const missing = m.entries.filter((e) => e.status === 'missing')
  assert.deepEqual(missing.map((e) => `${e.task_id}/${e.arm}`).sort(), ['t1/b', 't2/a'])
  for (const e of missing) { assert.equal(e.primary, null); assert.deepEqual(e.cells, []) }
  // A missing reference cell leaves difficulty unknown.
  assert.equal(taskSignals(m, 't2', { reference: 'a' }).difficulty, null)
})

test('rows that are no result, contaminated or ungraded are left out', () => {
  const rows = [row('t', 'a', 1, true, { exit_reason: 'quota' }), row('t', 'a', 2, true, { harness_error: 'boom' }), row('t', 'a', 3, true, { memory_refs: 1 }), { ...row('t', 'a', 4, true), accepted: null }]
  const r = report(rows)
  assert.equal(r.matrix.observations.length, 0)
  assert.equal(r.dropped, 4)
})

// A small set: four tasks over three arms.
//   easy:  everyone solves it. Arm c costs 2x arm a, so it discriminates on cost only.
//   hard:  only c solves it by majority. Outcome discrimination.
//   tie:   a passes 1 of 2, which is a tie and not solved. b fails. Same verdict, and no accepted run for b.
//   alone: only a ran it.
function synthetic() {
  return [
    row('easy', 'a', 1, true), row('easy', 'a', 2, true), row('easy', 'b', 1, true, { cost_usd_api_equiv: 1.2 }), row('easy', 'c', 1, true, { cost_usd_api_equiv: 2 }),
    row('hard', 'a', 1, false), row('hard', 'a', 2, true), row('hard', 'a', 3, false), row('hard', 'b', 1, false), row('hard', 'c', 1, true), row('hard', 'c', 2, true),
    row('tie', 'a', 1, true), row('tie', 'a', 2, false), row('tie', 'b', 1, false),
    row('alone', 'a', 1, true),
  ]
}

test('the three signals stay separate per task', () => {
  const r = report(synthetic(), { reference: 'a', focus: 'hard' })
  const by = Object.fromEntries(r.perTask.map((t) => [t.task_id, t]))
  assert.deepEqual([by.easy.difficulty.accepted, by.easy.difficulty.n], [2, 2])
  assert.equal(by.hard.difficulty.rate, 1 / 3)
  assert.equal(by.easy.outcome.discriminates, false)
  assert.equal(by.hard.outcome.discriminates, true)
  assert.deepEqual(by.hard.outcome.solved_by, ['c'])
  assert.equal(by.tie.outcome.discriminates, false, 'a tie is not solved, as in stats.mts discordant')
  assert.equal(by.alone.outcome.discriminates, null, 'one arm cannot discriminate')

  assert.equal(by.easy.economic.discriminates, true)
  const ac = by.easy.economic.pairs.find((p) => p.cheaper === 'a' && p.dearer === 'c')
  assert.equal(ac.ratio, 2)
  assert.ok(by.easy.economic.pairs.find((p) => p.dearer === 'b' && p.cheaper === 'a').ratio < COST_RATIO, '1.2x is under the threshold')
  // hard: a and b both fail. a has one accepted run in three, b has none, so no cost per accepted run to compare.
  assert.equal(by.hard.economic.discriminates, null)
  assert.equal(by.tie.economic.discriminates, null)
  assert.equal(r.focus.task_id, 'hard')
})

test('set-level signals count tasks, not repeats', () => {
  const r = report(synthetic(), { reference: 'a' })
  assert.equal(r.set.outcome.comparable_tasks, 3)
  assert.equal(r.set.outcome.discriminating, 1)
  assert.equal(r.set.outcome.single_arm_tasks, 1)
  assert.equal(r.set.economic.eligible_tasks, 1)
  assert.equal(r.set.economic.discriminating, 1)
  // Reference a per task: easy 1, hard 1/3, tie 1/2, alone 1. Each task weighs once.
  close(r.set.difficulty.mean_rate, (1 + 1 / 3 + 1 / 2 + 1) / 4)
  assert.equal(r.set.difficulty.failed_tasks, 2)
  const ac = r.set.pairs.find((p) => p.a === 'a' && p.b === 'c')
  assert.deepEqual([ac.tasks, ac.only_a, ac.only_b], [2, 0, 1])
})

test('the health warning fires below the threshold, and says it is a heuristic', () => {
  // 1 of 3 comparable tasks discriminates: 33%, above 20%.
  assert.equal(report(synthetic()).set.warning, null)
  // Add tasks where both arms agree until the share drops under 20%.
  const agree = Array.from({ length: 3 }, (_, i) => [row(`same${i}`, 'a', 1, true), row(`same${i}`, 'b', 1, true)]).flat()
  const low = report([...synthetic(), ...agree])
  assert.ok(low.set.outcome.share < HEALTH_MIN_SHARE)
  assert.match(low.set.warning, /^Only 1 of 6 comparable tasks/)
  assert.match(renderOutcomes(low).join('\n'), /Warning \(heuristic, not a release gate\)/)
  // Exactly at the threshold: 1 of 5 is 20%, which does not warn.
  const edge = report([...synthetic(), ...agree.slice(0, 4)])
  assert.equal(edge.set.outcome.share, 0.2)
  assert.equal(edge.set.warning, null)
  // With no comparable task at all, it warns that it cannot measure.
  assert.match(report([row('x', 'a', 1, true)]).set.warning, /cannot be measured/)
})

test('false completion counts only explicit claims with a valid grade', () => {
  const rows = [
    row('t', 'a', 1, true, { completion: { claimed: true } }),
    row('t', 'a', 2, false, { completion: { claimed: true } }),
    row('t', 'a', 3, false, { completion: { claimed: false } }),
    row('t', 'a', 4, false),
    row('t', 'a', 5, false, { completion: { state: 'verified' } }),
    row('t', 'a', 6, false, { completion: { claimed: 'yes' } }),
    row('t', 'a', 7, false, { completion: { claimed: true }, exit_reason: 'quota' }),
    { ...row('t', 'a', 8, false, { completion: { claimed: true } }), accepted: null },
  ]
  const f = falseCompletion(rows)
  assert.deepEqual(f, { rows: 8, claims_graded: 2, false_claims: 1, rate: 0.5, no_claim: 1, na_no_field: 1, na_ambiguous: 2, na_ungraded: 2 })
  const none = falseCompletion([row('t', 'a', 1, false), row('t', 'a', 2, true)])
  assert.equal(none.rate, null, 'no claim field anywhere is N/A, never a rate of zero')
  assert.equal(none.na_no_field, 2)
})

test('the matrix JSON holds no reply text', () => {
  const json = JSON.stringify(outcomeJson(report(synthetic(), { reference: 'a' })))
  assert.doesNotMatch(json, /"text":/)
  const parsed = JSON.parse(json)
  assert.equal(parsed.entries.find((e) => e.task_id === 'alone' && e.arm === 'b').status, 'missing')
})
