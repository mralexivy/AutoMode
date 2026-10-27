// Tests for the offline evidence tools: accounting attribution and token counting.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcileRun, TOLERANCE } from './reconcile.mjs'
import { tokensOf } from './lib/transcripts.mjs'

const req = (model, t, incomplete = false) => ({ model, tokens: { input: t[0], output: t[1], cacheRead: t[2], cacheWrite5m: t[3], cacheWrite1h: 0, thinking: null }, incomplete })
const session = (reqs) => ({ prompts: [{ requests: reqs }], sidechain: [], subagents: [] })

test('reconcile: an output gap is attributed only to a model with incomplete streams and matching input and cache', () => {
  const run = { run_id: 'r', cost_usd_api_equiv: 0, model_usage: { 'claude-opus-5-5': { input: 10, output: 3000, cache_read: 1000, cache_write: 100 } } }
  const ok = reconcileRun(run, session([req('claude-opus-5-5', [10, 300, 1000, 100], true)]))
  assert.equal(ok.attributions[0].outputTokens, 2700)
  const cacheDiffers = reconcileRun(run, session([req('claude-opus-5-5', [10, 300, 900, 100], true)]))
  assert.equal(cacheDiffers.attributions.length, 0, 'a cache mismatch is not explained away')
  const noIncomplete = reconcileRun(run, session([req('claude-opus-5-5', [10, 300, 1000, 100], false)]))
  assert.equal(noIncomplete.attributions.length, 0, 'a complete stream cannot absorb a gap')
})

test('reconcile: the picker row name and the API model name are the same model; the tolerance stays 2%', () => {
  const usage = { input: 1, output: 1, cache_read: 1, cache_write: 1, cost_usd: 0 }
  const r = reconcileRun({ run_id: 'r', cost_usd_api_equiv: 1, model_usage: { 'claude-sonnet-5-5[1m]': usage } }, session([req('claude-sonnet-5-5', [1, 1, 1, 1])]))
  assert.equal(r.rows.length, 1)
  assert.equal(TOLERANCE, 0.02)
})

test('transcripts: thinking is reported inside output, never added to it', () => {
  const t = tokensOf({ input_tokens: 2, output_tokens: 1054, output_tokens_details: { thinking_tokens: 258 }, cache_read_input_tokens: 5, cache_creation_input_tokens: 7, cache_creation: { ephemeral_1h_input_tokens: 7, ephemeral_5m_input_tokens: 0 } })
  assert.deepEqual(t, { input: 2, output: 1054, cacheRead: 5, cacheWrite5m: 0, cacheWrite1h: 7, thinking: 258 })
})
