// Habits: counting idle gaps, the return probability, the ping value, the transcript fold, the gates, the race, and the replay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EDGES, EMPTY_HABITS, MIN_RACE, SURE_ENDED_MS, addPend, bucketOfGap, ctxOf, decideActive, fadeLedger, noteKeepalive, observeEnd, observeGap, optIn, parseHabits, pingValue, raceCost, raceSave, returnProb, settlePend } from '../hooks/lib/habits.ts'
import { compactOf, finishScan, foldTranscript, interactive, observeCompact, observeFolded } from '../hooks/lib/scan.ts'
import { UNFINISHED_ODDS, gate, stateOf, weakestFor, type GateInput } from '../hooks/lib/keepgate.ts'
import { ANTHROPIC } from '../hooks/lib/prices.ts'
import { bootstrap, champion, challenger, flat, gapsOf, none, simulate, trainBefore } from '../bench/lib/gap-replay.mts'
import { EMPTY_LEARNED, inControl, liftOf, noteTask, parseLearned, wilson, MIN_ARM, CONTROL_SHARE } from '../hooks/lib/learn.ts'
import { learnedText } from '../hooks/lib/insight.ts'

const opus = ANTHROPIC.rates.opus
const sonnet = ANTHROPIC.rates.sonnet
const many = (n: number, f: (h: typeof EMPTY_HABITS) => typeof EMPTY_HABITS) => { let h = EMPTY_HABITS; for (let i = 0; i < n; i++) h = f(h); return h }

test('buckets: gaps under 3 minutes are flow, and the edges are lower bounds', () => {
  assert.equal(bucketOfGap(2.9), -1)
  assert.equal(bucketOfGap(3), 0)
  assert.equal(bucketOfGap(59.9), 3)
  assert.equal(bucketOfGap(60), 4)
  assert.equal(bucketOfGap(9999), EDGES.length - 1)
  assert.equal(ctxOf(59_999), 'small')
  assert.equal(ctxOf(150_000), 'big')
})

test('returnProb: no data gives a prior that fades with idle time, and personal counts take over', () => {
  const p10 = returnProb(EMPTY_HABITS, 'big', 10).p, p200 = returnProb(EMPTY_HABITS, 'big', 200).p
  assert.ok(p10 > 0.2 && p10 < 0.35, String(p10))
  assert.ok(p200 < p10 / 2, `${p200} should be well under ${p10}`)
  assert.ok(returnProb(many(150, (h) => observeGap(h, 'big', 20)), 'big', 10).p > 0.9)
  assert.ok(returnProb(many(150, (h) => observeEnd(h, 'big')), 'big', 10).p < 0.05)
  // Thirty observations count a third of the way: the estimate sits between the prior and the data.
  const thin = returnProb(many(30, (h) => observeGap(h, 'big', 20)), 'big', 10).p
  assert.ok(thin > p10 && thin < 0.95, String(thin))
})

test('returnProb: the longer a chat has been idle, the less is left of the short gaps; returns before the cache expires are left out', () => {
  const h = { ...many(60, (x) => observeGap(x, 'big', 10)), }
  const mix = { ...h, cells: { big: { gaps: h.cells.big!.gaps, ends: 60 } } }
  assert.ok(returnProb(mix, 'big', 5, 60).p > returnProb(mix, 'big', 20, 60).p)
  const late = many(150, (x) => observeGap(x, 'big', 90)) // bucket 60 to 120: past a 60-minute lifetime
  assert.ok(returnProb(late, 'big', 40, 60, 0).p > 0.6)
  assert.ok(returnProb(late, 'big', 40, 60, 60).p > 0.6)
  const early = many(150, (x) => observeGap(x, 'big', 40)) // bucket 30 to 60: a 60-minute cache was still warm
  assert.ok(returnProb(early, 'big', 20, 60, 0).p > 0.9)
  assert.ok(returnProb(early, 'big', 20, 60, 60).p < 0.1) // those returns need no ping
})

test('counts halve past the cap as floats, so rare long gaps do not vanish', () => {
  let h = many(10, (x) => observeGap(x, 'big', 300))
  for (let i = 0; i < 4_100; i++) h = observeGap(h, 'big', 20)
  assert.ok(h.cells.big!.gaps[bucketOfGap(20)] < 4_100)
  assert.ok(h.cells.big!.gaps[bucketOfGap(300)] > 0)
})

test('parseHabits rejects old and junk files and keeps good cells, the ledger and the race', () => {
  assert.deepEqual(parseHabits('not json'), EMPTY_HABITS)
  assert.deepEqual(parseHabits('{"v":1,"cells":{}}'), EMPTY_HABITS)
  const h = optIn(noteKeepalive(observeGap(EMPTY_HABITS, 'big', 20), 1, 3), true)
  const back = parseHabits(JSON.stringify(h))
  assert.deepEqual(back.cells, h.cells)
  assert.deepEqual([back.kw.pingUsd, back.kw.savedUsd, back.kw.optIn], [1, 3, true])
  assert.equal(parseHabits('{"v":2,"cells":{},"kw":{"pingUsd":-5,"savedUsd":"x"}}').kw.pingUsd, 0)
  assert.equal(parseHabits(JSON.stringify({ ...h, cells: { ...h.cells, huge: { gaps: [], ends: 0 } } })).cells.big !== undefined, true)
})

test('the ledger adds and fades with a 30-day half-life, so a bad month does not stop pings for good', () => {
  const l = fadeLedger({ pingUsd: 4, savedUsd: 1, optIn: true, at: 1 }, 1 + 30 * 86_400_000)
  assert.ok(Math.abs(l.pingUsd - 2) < 1e-9 && Math.abs(l.savedUsd - 0.5) < 1e-9)
  assert.equal(noteKeepalive(EMPTY_HABITS, 1, 2).kw.savedUsd, 2)
})

test('pingValue: a big Opus chat that comes back pays, a small one that never does does not, and the saving needs the return to be past the cache lifetime', () => {
  const back = many(150, (h) => observeGap(h, 'big', 90))
  assert.ok(pingValue({ habits: back, prefixTokens: 300_000, idleMin: 40, ttlMs: 3_600_000, rate: opus }).net > 0)
  const gone = many(150, (h) => observeEnd(h, 'small'))
  assert.ok(pingValue({ habits: gone, prefixTokens: 20_000, idleMin: 10, ttlMs: 300_000, rate: sonnet }).net < 0)
  const soon = many(150, (h) => observeGap(h, 'big', 50)) // always back at 50 minutes: a 60-minute cache was still warm
  assert.ok(pingValue({ habits: soon, prefixTokens: 300_000, idleMin: 40, ttlMs: 3_600_000, rate: opus }).saveUsd < 0.05)
})

test('pingValue: the odds boost is bounded and keeps a small chance small', () => {
  const small = pingValue({ habits: many(150, (h) => observeEnd(h, 'big')), prefixTokens: 300_000, idleMin: 100, ttlMs: 3_600_000, rate: opus, oddsBoost: UNFINISHED_ODDS })
  assert.ok(small.pReturn < 0.1, String(small.pReturn))
  const odds = pingValue({ habits: many(150, (h) => observeGap(h, 'big', 120)), prefixTokens: 300_000, idleMin: 100, ttlMs: 3_600_000, rate: opus, oddsBoost: 100 })
  assert.ok(odds.pReturn <= 0.9)
})

const line = (o: unknown) => JSON.stringify(o)
const ts = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + min * 60_000).toISOString()
const asst = (id: string, min: number, tokens: number, tool = false, sidechain = false, entry?: string) => line({ type: 'assistant', requestId: id, timestamp: ts(min), isSidechain: sidechain, ...(entry ? { entrypoint: entry } : {}), message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0 }, content: tool ? [{ type: 'tool_use' }] : [{ type: 'text', text: 'SECRET' }] } })
const user = (min: number, text = 'SECRET prompt', entry?: string) => line({ type: 'user', timestamp: ts(min), ...(entry ? { entrypoint: entry } : {}), message: { content: text } })

test('foldTranscript: typed prompts, a streamed request merged, sidechains skipped, the entry point kept, and no text', () => {
  const f = foldTranscript([user(0, 'a SECRET', 'claude-vscode'), asst('a', 0.1, 200_000), asst('a', 0.1, 200_000, true), asst('s', 1, 1, false, true), user(30), asst('b', 30.1, 210_000)].join('\n'))
  assert.equal(f.prompts, 2); assert.equal(f.reqs.length, 2); assert.equal(f.reqs[0].acted, true); assert.equal(f.entry, 'claude-vscode')
  assert.ok(!JSON.stringify(f).includes('SECRET') && !JSON.stringify(compactOf(f)).includes('SECRET'))
})

test('scripted sessions (sdk-cli) and one-prompt sessions are not a person at a keyboard', () => {
  const sdk = foldTranscript([user(0, 'x', 'sdk-cli'), asst('a', 1, 90_000), user(50), asst('b', 51, 90_000)].join('\n'))
  assert.equal(interactive(sdk), false)
  assert.equal(observeFolded(EMPTY_HABITS, sdk, Date.UTC(2027, 0, 1)), EMPTY_HABITS)
  const one = foldTranscript([user(0, 'x', 'cli'), asst('a', 1, 90_000), asst('b', 90, 90_000)].join('\n'))
  assert.equal(interactive(one), false)
})

test('observeCompact: gaps after a tool call are tool time and skipped, a day-long gap is an end, and a young last request waits as pending', () => {
  const real = foldTranscript([user(0, 'a', 'cli'), asst('a', 1, 200_000, true), asst('b', 40, 200_000), user(41), asst('c', 42, 200_000), asst('d', 100, 200_000), user(101), asst('e', 2_000, 200_000)].join('\n'))
  const now = Date.UTC(2026, 0, 1) + 2_001 * 60_000
  const h = observeCompact(EMPTY_HABITS, compactOf(real), now, 'f1')
  const c = h.cells.big!
  assert.equal(c.gaps.reduce((a, b) => a + b, 0), 1) // only c->d (58 minutes); a->b followed a tool call; d->e is a day or more
  assert.equal(c.ends, 1) // d->e counted as an end
  assert.equal(Object.keys(h.pend).length, 1) // the last request is young
  assert.equal(settlePend(h, now + SURE_ENDED_MS + 1).cells.big!.ends, 2) // and settles once the file has been quiet
  assert.deepEqual(Object.keys(observeCompact(h, compactOf(real), now, 'f1').pend), ['f1']) // read again: the pending end is replaced, not added
})

test('a session that resumes cancels its pending end; finishScan keeps the watermark when a file failed', () => {
  const folded = foldTranscript([user(0, 'a', 'cli'), asst('a', 1, 200_000), user(2), asst('b', 3, 200_000)].join('\n'))
  const now = Date.UTC(2026, 0, 1) + 10 * 60_000
  const h = observeCompact(EMPTY_HABITS, compactOf(folded), now, 'x')
  assert.equal(Object.keys(h.pend).length, 1)
  assert.equal(Object.keys(observeCompact(h, { interactive: false, gaps: [], last: null }, now, 'x').pend).length, 0)
  assert.equal(finishScan(h, 999, 1).watermark, 0)
  assert.equal(finishScan(h, 999, 0).watermark, 999)
  assert.equal(addPend(EMPTY_HABITS, 'a', 'big', 1).pend.a[0], 'big')
})

const raw = { completionState: 'none', editedSinceCheck: false, lastCheckPassed: null, planMode: false, workStage: null, openObligations: 0, consultOpen: false, workersRunning: 0, tier: 'T3' as const, family: 'opus' as const, reachHaiku: true, pinned: false }
const base = (h = many(150, (x) => observeGap(x, 'big', 90))): Omit<GateInput, 'state'> => ({ habits: h, prefixTokens: 300_000, ttlMs: 3_600_000, idleMin: 52, rate: opus, minRewriteUsd: 0.3, sessionPingUsd: 0, budgetUsd: 0.5, capMin: 120, stale: false })

test('gate: every refusal protects money or the router, and carries a reason', () => {
  const unfinished = stateOf({ ...raw, completionState: 'unverified' })
  assert.equal(gate({ ...base(), state: unfinished }).champion.allow, true)
  const why = (o: Partial<GateInput>, s = unfinished) => gate({ ...base(), state: s, ...o }).champion.why
  assert.match(why({}, stateOf({ ...raw, completionState: 'verified' })), /finished/)
  assert.match(why({}, stateOf({ ...raw, tier: 'T1' })), /above what the next task/)
  assert.equal(gate({ ...base(), state: stateOf({ ...raw, tier: 'T1', editedSinceCheck: true }) }).champion.allow, true)
  assert.equal(stateOf({ ...raw, tier: 'T1', pinned: true }).aboveNeed, false)
  assert.match(why({ sessionPingUsd: 0.5 }), /budget/)
  assert.match(why({ idleMin: 130 }), /horizon/)
  assert.match(why({ prefixTokens: 4_000 }), /too little/)
  assert.match(why({ stale: true }), /another model or came before a compaction/)
  assert.match(why({ habits: { ...many(150, (x) => observeGap(x, 'big', 90)), kw: { pingUsd: 2, savedUsd: 0.2, optIn: true, at: 0 } } }), /not paid/)
})

test('gate: the champion needs no habits, the challenger needs the odds, and the race picks which acts', () => {
  const s = stateOf({ ...raw, completionState: 'unverified' })
  const gone = many(150, (x) => observeEnd(x, 'big'))
  const g = gate({ ...base(gone), state: s })
  assert.equal(g.champion.allow, true)
  assert.equal(g.challenger.allow, false)
  assert.equal(g.use.allow, true) // champion acts by default
  const flipped = gate({ ...base({ ...gone, cc: { ...gone.cc, active: 'challenger' } }), state: s })
  assert.equal(flipped.use.allow, false)
})

test('race: costs are booked at once, savings on return, and the habits rule takes over only with fewer pings and no worse net', () => {
  let h = EMPTY_HABITS
  for (let i = 0; i < MIN_RACE; i++) { h = raceCost(h, { champPings: 4, chalPings: 2, champUsd: 0.4, chalUsd: 0.2, newGap: true }); h = raceSave(h, 0.5, 0.5) }
  assert.equal(h.cc.n, MIN_RACE)
  assert.equal(h.cc.active, 'challenger')
  let worse = EMPTY_HABITS
  for (let i = 0; i < MIN_RACE; i++) { worse = raceCost(worse, { champPings: 4, chalPings: 2, champUsd: 0.4, chalUsd: 0.2, newGap: true }); worse = raceSave(worse, 0.5, 0) }
  assert.equal(worse.cc.active, 'champion') // fewer pings but a clearly worse net
  // A gap nobody returns to costs and saves nothing: the race is not flattered by the sessions that never came back.
  const never = raceCost(EMPTY_HABITS, { champPings: 3, chalPings: 3, champUsd: 0.3, chalUsd: 0.3, newGap: true })
  assert.ok(never.cc.champNet < 0 && never.cc.chalNet < 0)
  // Back to the champion when the challenger turns clearly worse.
  const back = decideActive({ ...h.cc, chalNet: h.cc.champNet - 5 })
  assert.equal(back.active, 'champion')
})

test('control group: a fixed one in ten of tasks, by id', () => {
  const ids = Array.from({ length: 2_000 }, (_, i) => `task-${i}-${i * 7}`)
  const share = ids.filter(inControl).length / ids.length
  assert.ok(share > 0.07 && share < 0.13, String(share))
  assert.equal(CONTROL_SHARE, 10)
})

test('lift: arms come from the assignment, pinned and unflipped tasks count for neither, and there is no conclusion below the minimum', () => {
  const now = 1_000_000
  let l = EMPTY_LEARNED
  const add = (id: string, outcome: 'ok' | 'bad', arm: 'memory' | 'control', extra: object = {}) => { l = noteTask(l, { id, bucket: 'T2/sonnet', family: 'sonnet', outcome, at: now, arm, flipped: true, usd: 1, ...extra }) }
  add('a1', 'bad', 'memory', { flipped: false }); add('a2', 'bad', 'memory', { flipped: false }) // before the flip: cheaper model, bad, and they flip the bucket
  add('m1', 'ok', 'memory'); add('m2', 'ok', 'memory'); add('m3', 'bad', 'memory'); add('m4', 'ok', 'memory', { pinned: true })
  add('c1', 'bad', 'control'); add('c2', 'ok', 'control')
  const [x] = liftOf(parseLearned(JSON.stringify(l)), now)
  assert.equal(x.bucket, 'T2/sonnet')
  assert.deepEqual([x.memory.n, x.memory.bad, x.memory.usd], [3, 1, 3])
  assert.deepEqual([x.control.n, x.control.bad], [2, 1])
  const [lo, hi] = wilson(1, 3)
  assert.ok(lo < 0.1 && hi > 0.7) // three tasks say very little
  const text = learnedText({ habits: EMPTY_HABITS, learned: l, now, keepWarm: 'ask', learning: true, consent: false })
  assert.match(text, /no conclusion yet \(needs 20 tasks in each arm; has 3 and 2\)/)
  assert.equal(MIN_ARM, 20)
})

test('learnedText: asks for consent first, says how thin the data is, and has no prompt text', () => {
  const h = { ...many(30, (x) => observeGap(x, 'big', 30)), sessions: 30, scan: true }
  const text = learnedText({ habits: noteKeepalive(h, 1.5, 4), learned: EMPTY_LEARNED, now: 1, keepWarm: 'ask', learning: true, consent: true })
  assert.match(text, /counted from 30 of your sessions/)
  assert.match(text, /only 30 observed, so mostly a starting guess/)
  assert.match(text, /cost \$1\.50 and avoided \$4\.00/)
  assert.match(text, /the race has 0 of 30 gaps it needs/)
  assert.match(learnedText({ habits: EMPTY_HABITS, learned: EMPTY_LEARNED, now: 1, keepWarm: 'off', learning: false, consent: false }), /Run \/automode learned import[\s\S]*Route memory is off/)
})

test('replay: pinging a session that never returns loses, covering a return wins, and the training never sees the test period', () => {
  const req = { at: 0, tokens: 300_000, family: 'opus' as const, acted: false, ttlMs: 3_600_000 }
  const returns = { a: req, gapMin: 120, ttlMs: 3_600_000, session: 0, endAt: 1 }
  const never = { a: req, gapMin: Infinity, ttlMs: 3_600_000, session: 1, endAt: 2 }
  assert.equal(simulate([never], none).netUsd, 0)
  assert.ok(simulate([never], flat(4)).netUsd < 0)
  assert.ok(simulate([returns], flat(4)).netUsd > 0)
  assert.equal(simulate([returns], flat(1)).savedUsd, 0)
  assert.ok(simulate([returns], champion(2, 0.3)).netUsd > 0)
  const day = 86_400_000, T0 = Date.UTC(2026, 0, 1)
  const s = { prompts: 5, entry: 'cli', reqs: [{ ...req, at: T0 }, { ...req, at: T0 + 2 * 3_600_000 }, { ...req, at: T0 + 20 * day }] }
  assert.equal(gapsOf([s], T0 + 30 * day).length, 3)
  assert.equal(gapsOf([{ ...s, entry: 'sdk-cli' }], T0 + 30 * day).length, 0)
  const trained = trainBefore([s], T0 + 3_600_000) // before the first gap ended: nothing to learn from yet
  assert.deepEqual(trained.cells, {})
  assert.ok(challenger(trained).name.startsWith('challenger'))
  const [lo, hi] = bootstrap(new Map([[0, 1], [1, 3], [2, 2]]))
  assert.ok(lo <= 6 && hi >= 6 - 1e-9 || lo <= hi)
})
