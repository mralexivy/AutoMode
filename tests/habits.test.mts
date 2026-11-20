// Habits: counting idle gaps, the return probability, the ping value, the transcript fold, the keepalive gate, and the replay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EDGES, EMPTY_HABITS, bucketOfGap, ctxOf, keyOf, noteKeepalive, observeEnd, observeGap, optIn, parseHabits, pingValue, returnProb } from '../hooks/lib/habits.ts'
import { finishScan, foldTranscript, observeFolded } from '../hooks/lib/scan.ts'
import { gate, stateOf, weakestFor } from '../hooks/lib/keepgate.ts'
import { ANTHROPIC } from '../hooks/lib/prices.ts'
import { flat, gapsOf, gated, none, simulate, train } from '../bench/lib/gap-replay.mts'

const big = keyOf('big', 'sonnet', true)
const opus = ANTHROPIC.rates.opus
const sonnet = ANTHROPIC.rates.sonnet

test('buckets: gaps under 3 minutes are flow, and the edges are lower bounds', () => {
  assert.equal(bucketOfGap(2.9), -1)
  assert.equal(bucketOfGap(3), 0)
  assert.equal(bucketOfGap(59.9), 3)
  assert.equal(bucketOfGap(60), 4)
  assert.equal(bucketOfGap(9999), EDGES.length - 1)
  assert.equal(ctxOf(59_999), 'small')
  assert.equal(ctxOf(150_000), 'big')
})

test('returnProb: no data gives the prior, and data moves it', () => {
  const prior = returnProb(EMPTY_HABITS, 'big', 'sonnet', null, 10).p
  assert.ok(prior > 0.3 && prior < 0.4)
  let h = EMPTY_HABITS
  for (let i = 0; i < 40; i++) h = observeGap(h, big, 20) // back after 20 minutes, every time
  assert.ok(returnProb(h, 'big', 'sonnet', null, 10, 60).p > 0.9)
  let n = EMPTY_HABITS
  for (let i = 0; i < 40; i++) n = observeEnd(n, big) // gone for good, every time
  assert.ok(returnProb(n, 'big', 'sonnet', null, 10, 60).p < 0.1)
})

test('returnProb: the longer the chat has been idle, the less is left of the short gaps', () => {
  let h = EMPTY_HABITS
  for (let i = 0; i < 30; i++) h = observeGap(h, big, 10)
  for (let i = 0; i < 30; i++) h = observeEnd(h, big)
  assert.ok(returnProb(h, 'big', 'sonnet', null, 5, 60).p > returnProb(h, 'big', 'sonnet', null, 20, 60).p)
})

test('counts halve past the cap, so old habits fade', () => {
  let h = EMPTY_HABITS
  for (let i = 0; i < 4_100; i++) h = observeGap(h, big, 20)
  assert.ok(h.cells[big].gaps[bucketOfGap(20)] < 4_100)
})

test('parseHabits rejects junk and keeps good cells', () => {
  assert.deepEqual(parseHabits('not json'), EMPTY_HABITS)
  assert.deepEqual(parseHabits('{"v":2}'), EMPTY_HABITS)
  const h = observeGap(EMPTY_HABITS, big, 20)
  assert.deepEqual(parseHabits(JSON.stringify(h)).cells, h.cells)
  assert.equal(Object.keys(parseHabits(JSON.stringify({ ...h, cells: { ...h.cells, 'bad|key|x': { gaps: [], ends: 0 } } })).cells).length, 1)
  assert.equal(parseHabits('{"v":1,"cells":{},"kw":{"pingUsd":-5,"savedUsd":"x","optIn":true}}').kw.pingUsd, 0)
})

test('the ledger adds, halves when large, and remembers a yes', () => {
  let h = noteKeepalive(EMPTY_HABITS, 1, 3)
  assert.deepEqual([h.kw.pingUsd, h.kw.savedUsd], [1, 3])
  h = noteKeepalive(h, 25, 50)
  assert.ok(h.kw.pingUsd < 20)
  assert.equal(optIn(h, true).kw.optIn, true)
})

test('pingValue: a big Opus chat that comes back pays, a small one that never does does not', () => {
  let h = EMPTY_HABITS
  for (let i = 0; i < 30; i++) h = observeGap(h, keyOf('big', 'opus', true), 40)
  const v = pingValue({ habits: h, prefixTokens: 300_000, family: 'opus', acted: null, idleMin: 10, ttlMs: 3_600_000, rate: opus })
  assert.ok(v.net > 0, JSON.stringify(v))
  let g = EMPTY_HABITS
  for (let i = 0; i < 30; i++) g = observeEnd(g, keyOf('small', 'sonnet', false))
  const w = pingValue({ habits: g, prefixTokens: 20_000, family: 'sonnet', acted: null, idleMin: 10, ttlMs: 300_000, rate: sonnet })
  assert.ok(w.net < 0, JSON.stringify(w))
})

const line = (o: unknown) => JSON.stringify(o)
const ts = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + min * 60_000).toISOString()
const asst = (id: string, min: number, tokens: number, tool = false, sidechain = false) => line({ type: 'assistant', requestId: id, timestamp: ts(min), isSidechain: sidechain, message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0 }, content: tool ? [{ type: 'tool_use' }] : [{ type: 'text', text: 'SECRET' }] } })
const user = (min: number, text = 'SECRET prompt') => line({ type: 'user', timestamp: ts(min), message: { content: text } })

test('foldTranscript: counts typed prompts, merges a streamed request, skips sidechains, and keeps no text', () => {
  const text = [user(0), asst('a', 0.1, 200_000), asst('a', 0.1, 200_000, true), asst('s', 1, 1, false, true), user(30), asst('b', 30.1, 210_000)].join('\n')
  const f = foldTranscript(text)
  assert.equal(f.prompts, 2)
  assert.equal(f.reqs.length, 2)
  assert.equal(f.reqs[0].acted, true)
  assert.equal(f.reqs[0].tokens, 200_010)
  assert.ok(!JSON.stringify(f).includes('SECRET'))
})

test('observeFolded: a one-prompt session is a script and counts for nothing; a real one counts its gaps and its end', () => {
  const script = foldTranscript([user(0), asst('a', 0.1, 200_000), asst('b', 40, 200_000)].join('\n'))
  assert.equal(observeFolded(EMPTY_HABITS, script, Date.now()), EMPTY_HABITS)
  const real = foldTranscript([user(0), asst('a', 0.1, 200_000), user(40), asst('b', 40.1, 200_000), user(100), asst('c', 100.1, 200_000)].join('\n'))
  const h = observeFolded(EMPTY_HABITS, real, Date.UTC(2026, 0, 10))
  const cell = Object.values(h.cells).reduce((a, c) => ({ g: a.g + c.gaps.reduce((x, y) => x + y, 0), e: a.e + c.ends }), { g: 0, e: 0 })
  assert.deepEqual(cell, { g: 2, e: 1 })
  // Reading the same file again after finishScan counts nothing twice.
  const done = finishScan(h, real.reqs[2].at, Date.UTC(2026, 0, 10))
  assert.deepEqual(observeFolded(done, real, Date.UTC(2026, 0, 10)).cells, h.cells)
})

test('keepgate: finished work, a model above need and a spent budget stay cold; unfinished big work is kept warm', () => {
  let h = EMPTY_HABITS
  for (let i = 0; i < 20; i++) h = observeGap(h, keyOf('big', 'opus', true), 30)
  const raw = { completionState: 'none', editedSinceCheck: false, lastCheckPassed: null, planMode: false, workStage: null, openObligations: 0, consultOpen: false, workersRunning: 0, tier: 'T3' as const, family: 'opus' as const, reachHaiku: true, pinned: false }
  const base = { habits: h, prefixTokens: 300_000, family: 'opus' as const, ttlMs: 3_600_000, idleMin: 52, rate: opus, minRewriteUsd: 0.3, sessionPingUsd: 0, budgetUsd: 0.5, capMin: 240 }
  assert.equal(gate({ ...base, state: stateOf({ ...raw, completionState: 'unverified' }) }).allow, true)
  assert.match(gate({ ...base, state: stateOf({ ...raw, completionState: 'verified' }) }).why, /finished/)
  assert.match(gate({ ...base, state: stateOf({ ...raw, tier: 'T1' }) }).why, /above what the next task/)
  assert.equal(gate({ ...base, state: stateOf({ ...raw, tier: 'T1', editedSinceCheck: true }) }).allow, true) // unfinished beats a model above need
  assert.equal(stateOf({ ...raw, tier: 'T1', pinned: true }).aboveNeed, false) // a model the person pinned is what they want
  assert.match(gate({ ...base, state: stateOf({ ...raw, completionState: 'unverified' }), sessionPingUsd: 0.5 }).why, /budget/)
  assert.match(gate({ ...base, state: stateOf({ ...raw, completionState: 'unverified' }), idleMin: 300 }).why, /horizon/)
  assert.match(gate({ ...base, state: stateOf({ ...raw, completionState: 'unverified' }), prefixTokens: 4_000 }).why, /too little/)
  assert.match(gate({ ...base, habits: { ...h, kw: { pingUsd: 2, savedUsd: 0.2, optIn: true } }, state: stateOf({ ...raw, completionState: 'unverified' }) }).why, /not paid/)
})

test('keepgate: what counts as unfinished, and the weakest model for a tier', () => {
  const raw = { completionState: 'none', editedSinceCheck: false, lastCheckPassed: null, planMode: false, workStage: null, openObligations: 0, consultOpen: false, workersRunning: 0, tier: null, family: null, reachHaiku: false, pinned: false }
  assert.equal(stateOf(raw).unfinished, false)
  for (const o of [{ lastCheckPassed: false }, { planMode: true }, { workStage: 'plan' }, { openObligations: 1 }, { consultOpen: true }, { workersRunning: 1 }, { completionState: 'failed' }]) assert.equal(stateOf({ ...raw, ...o }).unfinished, true, JSON.stringify(o))
  assert.equal(weakestFor('T0', true), 'haiku')
  assert.equal(weakestFor('T0', false), 'sonnet')
  assert.equal(weakestFor('T3', true), 'sonnet')
  assert.equal(weakestFor('T4', true), 'opus')
})

test('replay: a policy that pings a session that never returns loses, one that covers a return wins', () => {
  const req = { at: 0, tokens: 300_000, family: 'opus' as const, acted: true, ttlMs: 3_600_000 }
  const returns = { a: req, gapMin: 120, ttlMs: 3_600_000 }
  const never = { a: req, gapMin: Infinity, ttlMs: 3_600_000 }
  assert.equal(simulate([never], none).netUsd, 0)
  assert.ok(simulate([never], flat(4)).netUsd < 0)
  assert.ok(simulate([returns], flat(4)).netUsd > 0)
  assert.equal(simulate([returns], flat(1)).savedUsd, 0) // stopped before the return: expired anyway
  const s = { prompts: 5, reqs: [req, { ...req, at: 120 * 60_000 }] }
  assert.equal(gapsOf([s], 1e15).length, 2)
  const h = train([s], 1e15)
  assert.ok(gated(h, { minUsd: 0.3, capHours: 4, windowMin: 60, pool: false }).name.startsWith('gated'))
})

import { CONTROL_SHARE, EMPTY_LEARNED, inControl, liftOf, noteTask, parseLearned } from '../hooks/lib/learn.ts'
import { learnedText } from '../hooks/lib/insight.ts'

test('control group: a fixed one in ten of tasks, by id', () => {
  const ids = Array.from({ length: 2_000 }, (_, i) => `task-${i}-${i * 7}`)
  const share = ids.filter(inControl).length / ids.length
  assert.ok(share > 0.07 && share < 0.13, String(share))
  assert.equal(inControl('task-1-1'), inControl('task-1-1'))
  assert.equal(CONTROL_SHARE, 10)
})

test('lift: Opus-first tasks are compared with control tasks of the same bucket, and control survives a parse', () => {
  const now = 1_000_000
  let l = EMPTY_LEARNED
  const t = (id: string, family: 'sonnet' | 'opus', outcome: 'ok' | 'bad', control?: boolean) => noteTask(l, { id, bucket: 'T2/sonnet', family, outcome, at: now, ...(control ? { control } : {}) })
  l = t('a', 'sonnet', 'bad'); l = t('b', 'sonnet', 'bad')
  l = t('c', 'opus', 'ok'); l = t('d', 'opus', 'ok'); l = t('e', 'opus', 'bad')
  l = t('f', 'sonnet', 'bad', true); l = t('g', 'sonnet', 'ok', true)
  const [x] = liftOf(parseLearned(JSON.stringify(l)), now)
  assert.equal(x.bucket, 'T2/sonnet')
  assert.deepEqual(x.applied, { n: 3, bad: 1 })
  assert.deepEqual(x.control, { n: 2, bad: 1 })
})

test('learnedText: says what it read, what pings did, and the control group, with no prompt text', () => {
  let h = EMPTY_HABITS
  for (let i = 0; i < 30; i++) h = observeGap(h, keyOf('big', 'opus', true), 30)
  h = { ...noteKeepalive(h, 1.5, 4), sessions: 30 }
  const text = learnedText({ habits: h, learned: EMPTY_LEARNED, now: 1, keepWarm: 'ask', learning: true, learnFromHistory: true })
  assert.match(text, /read 30 of your sessions/)
  assert.match(text, /chats over 150k tokens: \d+%/)
  assert.match(text, /cost \$1\.50 and avoided \$4\.00/)
  assert.match(text, /No kind of task needs a stronger start yet/)
  assert.match(learnedText({ habits: h, learned: EMPTY_LEARNED, now: 1, keepWarm: 'off', learning: false, learnFromHistory: false }), /Reading your history is off.*\n[\s\S]*Route memory is off/)
})
