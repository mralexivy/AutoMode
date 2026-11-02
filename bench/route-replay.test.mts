// Route replay (bench/lib/route-replay.mts, bench/route-replay.mts). The corpus is real: the decision records the
// mocked engine wrote in tests/golden/auto-route-records.ts. Their fingerprint is normalized to "FP" there.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SNAPSHOT } from '../tests/golden/auto-route-records.ts'
import { outcomeOf, routeAuto, type AutoRouteInput } from '../hooks/lib/auto-route.ts'
import { counterfactual, exact, missingField, replayable, routeDistance, type BatchPolicy } from './lib/route-replay.mts'
import { policy as mutant } from './fixtures/mutant-drop-critical-floor.mts'

const here = path.dirname(fileURLToPath(import.meta.url))
const records = Object.values(SNAPSHOT as Record<string, any[]>).flat()
const local = (i: AutoRouteInput) => outcomeOf(routeAuto(i))
const batch = (p: typeof local): BatchPolicy => (inputs) => inputs.map(p)
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x))

test('exact: every policy-auto decision the engine recorded replays to the same outcome', () => {
  const r = exact(records, local, 'FP')
  assert.ok(r.replayed >= 30, `replayed ${r.replayed}`)
  assert.equal(r.agreed, r.replayed, JSON.stringify(r.differed.slice(0, 2)))
  assert.equal(r.otherCode.replayed, 0)
})

test('exact: records from other code count apart, never as agreement', () => {
  const r = exact(records, local, 'another-fingerprint')
  assert.equal(r.replayed, 0)
  assert.ok(r.otherCode.replayed >= 30)
})

test('a record with a missing field is unreplayable, with the reason; nothing is filled in', () => {
  const d = clone(records.find((x) => x.auto?.replay))
  delete d.auto.replay.input.switching.cache
  const { rows, excluded } = replayable([d])
  assert.equal(rows.length, 0)
  assert.deepEqual(excluded.map((e) => e.reason), ['missing switching.cache'])
  for (const key of ['economics', 'floor', 'votes', 'judge']) {
    const e = clone(records.find((x) => x.auto?.replay))
    delete e.auto.replay.input[key]
    assert.equal(missingField(e.auto.replay.input), key)
  }
})

test('unknown schemas, old records and trigger records are excluded by reason', () => {
  const d = clone(records.find((x) => x.auto?.replay))
  const unknown = clone(d); unknown.auto.replay.input.schemaVersion = 99
  const old = clone(d); delete old.auto.replay
  const trigger = { ...clone(old), point: 'trigger' }
  const { excluded } = replayable([unknown, old, trigger])
  assert.deepEqual(excluded.map((e) => e.reason), ['unknown input schema 99', 'no route input: recorded before replay existed', 'trigger: stored verdicts, no route input'])
})

test('counterfactual: the same policy changes nothing', () => {
  const r = counterfactual(records, batch(local), batch(local))
  assert.equal(r.changed, 0)
  assert.ok(r.replayed >= 30)
})

test('counterfactual: Experiment A, a policy that drops the critical floor, moves routes', () => {
  const r = counterfactual(records, batch(local), batch(mutant))
  assert.ok(r.changed > 0, JSON.stringify(r))
})

test('the CLI runs policy B in a child process and reports the same counterfactual', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-replay-test-'))
  const file = path.join(dir, 'records.jsonl')
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const run = spawnSync(process.execPath, [path.join(here, 'route-replay.mts'), '--mode', 'counterfactual', '--records', file, '--policy-module', path.join(here, 'fixtures', 'mutant-drop-critical-floor.mts')], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const report = JSON.parse(run.stdout)
  assert.equal(report.changed, counterfactual(records, batch(local), batch(mutant)).changed)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('classifier mode says why records cannot answer it', () => {
  const run = spawnSync(process.execPath, [path.join(here, 'route-replay.mts'), '--mode', 'classifier'], { encoding: 'utf8' })
  assert.equal(run.status, 2)
  assert.match(run.stdout, /prompt text/)
})

test('route distance: a model change is 1, an effort step 0.25', () => {
  assert.equal(routeDistance('sonnet/high', 'sonnet/high'), 0)
  assert.equal(routeDistance('sonnet/medium', 'sonnet/xhigh'), 0.5)
  assert.equal(routeDistance('sonnet/high', 'opus/high'), 1)
  assert.equal(routeDistance('haiku/low', 'opus/max'), 2)
})
