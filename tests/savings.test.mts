// The live savings estimate in hooks/lib/savings.ts: a switch pays its cache rewrite first, cheaper requests pay it back,
// the baseline keeps its own warm cache, and AutoMode's own calls count against the saving.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addOverhead, addRequest, baselineUsage, netOf, NO_SAVINGS, phaseOf, shareOf, type Savings } from '../hooks/lib/savings.ts'
import { ANTHROPIC } from '../hooks/lib/prices.ts'

const HOUR = 3_600_000
const OPUS = 'claude-opus-5-5', SONNET = 'claude-sonnet-5-5', HAIKU = 'claude-haiku-5-5'
// One request in a chat of `prompt` tokens: `fresh` of them new to the answering model's cache.
const req = (s: Savings, ran: string, prompt: number, fresh: number, at: number, out = 400, app = OPUS) =>
  addRequest(s, { appModel: app, answeredModel: ran, usage: { input: 2, output: out, cacheRead: prompt - fresh - 2, cacheWrite5m: 0, cacheWrite1h: fresh }, at, ttlMs: HOUR }, ANTHROPIC)

test('requests on the starting model save nothing, and the bar shows nothing', () => {
  let s = NO_SAVINGS
  for (let i = 0; i < 5; i++) s = req(s, OPUS, 20_000 + i * 2_000, 2_000, i * 60_000)
  assert.equal(netOf(s), 0)
  assert.equal(phaseOf(s), 'none')
  assert.equal(shareOf(s), null)
})

test('a switch in a warm chat dips first, then pays back', () => {
  let s = NO_SAVINGS
  // A warm 80k chat on Opus.
  s = req(s, OPUS, 80_000, 80_000, 0)
  for (let i = 1; i <= 3; i++) s = req(s, OPUS, 80_000 + i * 1_000, 1_000, i * 60_000)
  // The switch: Sonnet writes the whole chat into its own cache; the baseline would only have read its warm cache.
  s = req(s, SONNET, 84_000, 84_000, 4 * 60_000)
  assert.equal(phaseOf(s), 'paying-back')
  assert.ok(netOf(s) < 0)
  assert.ok(s.rewriteUsd > 0)
  // Cheaper requests on Sonnet's now warm cache pay it back.
  let t = 5
  while (phaseOf(s) === 'paying-back' && t < 200) { s = req(s, SONNET, 84_000 + t * 500, 500, t * 60_000, 2_000); t++ }
  assert.equal(phaseOf(s), 'saving', 'the rewrite is paid back')
  assert.ok(t < 60, `it took ${t} requests`)
})

test('questions on Haiku in a fresh chat save at once', () => {
  let s = req(NO_SAVINGS, HAIKU, 12_000, 12_000, 0, 150)
  assert.equal(phaseOf(s), 'saving')
  assert.ok((shareOf(s) ?? 0) > 0.9)
})

test('the baseline cache goes cold after its lifetime, so it pays to write again', () => {
  const warm = baselineUsage({ input: 2, output: 100, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 50_000 }, 48_000)
  assert.equal(warm.cacheRead, 48_000)
  assert.equal(warm.cacheWrite1h, 50_000 - 48_000)
  let s = req(NO_SAVINGS, OPUS, 50_000, 50_000, 0)
  const hot = req(s, SONNET, 51_000, 51_000, 10 * 60_000)
  const cold = req(s, SONNET, 51_000, 51_000, 2 * HOUR)
  assert.ok(netOf(cold) > netOf(hot), 'after the lifetime the baseline also rewrites, so the switch costs less extra')
})

test("AutoMode's own calls count against the saving", () => {
  const s = req(NO_SAVINGS, HAIKU, 12_000, 12_000, 0, 150)
  assert.ok(Math.abs(netOf(addOverhead(s, 0.01)) - (netOf(s) - 0.01)) < 1e-9)
})

test('a model it cannot price changes nothing', () => {
  const s = addRequest(NO_SAVINGS, { appModel: 'gpt-x', answeredModel: SONNET, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }, at: 0, ttlMs: HOUR }, ANTHROPIC)
  assert.deepEqual(s, NO_SAVINGS)
})
