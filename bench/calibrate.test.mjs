// Tests for the per-stage calibration (calibrate.mjs): the text classifier and the stage tables.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calibrate, MIN_N, stageOfText } from './calibrate.mjs'

test('stageOfText: the stages a prompt\'s text can show', () => {
  const want = {
    commit: 'repo-op', 'run tests': 'verify', thanks: 'complete', 'are you sure this fixes it?': 'reconsider',
    'run the final review please': 'review', 'where is the output folder written?': 'lookup', 'investigate why the setup fails': 'analyze',
    'add retries to the uploader': 'implement',
  }
  for (const [text, stage] of Object.entries(want)) assert.equal(stageOfText(text), stage, text)
})

test('calibrate: a stage with enough prompts gets its own residual table, and the text never reaches the output', () => {
  const req = () => ({ model: 'claude-sonnet-5-5', tokens: { input: 1, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, thinking: null }, sentEffort: 'medium', appEffort: 'medium' })
  const prompts = []
  for (let i = 0; i < MIN_N + 5; i++) prompts.push({ text: 'commit', requests: Array.from({ length: 2 + (i % 3) }, req) })
  for (let i = 0; i < MIN_N + 5; i++) prompts.push({ text: 'add the importer for the new feed', requests: Array.from({ length: 10 + (i % 20) }, req) })
  for (let i = 0; i < 5; i++) prompts.push({ text: 'thanks', requests: [req()] })
  const out = calibrate([{ prompts }])
  const by = out.priors.remainingByStage
  assert.ok(by['repo-op'] && by.implement, 'two stages are above the sample floor')
  assert.equal(by.complete, undefined, 'a stage below the floor keeps the global table')
  assert.ok(by.implement[0].median > by['repo-op'][0].median * 2, 'implementation leaves much more work than a commit')
  assert.ok(!JSON.stringify(out).includes('importer'), 'no prompt text in the output')
})
