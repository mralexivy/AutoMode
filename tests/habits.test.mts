// Habits and the return model: points, the prior and its slow update, the report card, the transcript fold, the gates, the race, and the replay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_HABITS, MIN_RACE, SURE_ENDED_MS, addPend, addPoints, decideActive, fadeLedger, noteKeepalive, observeGapFeat, optIn, parseHabits, pingValue, raceCost, raceSave, returnProb, settlePend } from '../hooks/lib/habits.ts'
import { CHECKS, PRIOR, fit, pointsOf, prob, type Base, type Feat } from '../hooks/lib/model.ts'
import { baseAt, compactOf, finishScan, foldTranscript, interactive, observeCompact, observeFolded } from '../hooks/lib/scan.ts'
import { gate, stateOf, weakestFor, type GateInput } from '../hooks/lib/keepgate.ts'
import { ANTHROPIC } from '../hooks/lib/prices.ts'
import { bootstrap, champion, challenger, flat, gapsOf, none, simulate, trainBefore } from '../bench/lib/gap-replay.mts'
import { EMPTY_LEARNED, inControl, liftOf, noteTask, parseLearned, startReport, wilson, MIN_ARM, CONTROL_SHARE } from '../hooks/lib/learn.ts'
import { learnedText } from '../hooks/lib/insight.ts'

const opus = ANTHROPIC.rates.opus
const big: Base = { tokens: 250_000, ageMin: 240, prompts: 30, turnOut: 6_000, asked: false }
const small: Base = { tokens: 20_000, ageMin: 10, prompts: 2, turnOut: 300, asked: false }
const feat = (b: Base, idleMin: number): Feat => ({ ...b, idleMin })
const times = (n: number, h: typeof EMPTY_HABITS, f: (h: typeof EMPTY_HABITS) => typeof EMPTY_HABITS) => { for (let i = 0; i < n; i++) h = f(h); return h }

test('the prior says what the audit found: bigger, longer, busier chats return; a question returns; more idle time returns less', () => {
  const p = (b: Base, idle: number) => prob(PRIOR, feat(b, idle))
  assert.ok(p(big, 30) > p(small, 30))
  assert.ok(p({ ...big, asked: true }, 30) > p(big, 30) + 0.2)
  assert.ok(p(big, 30) > p(big, 100))
  assert.ok(p({ ...big, ageMin: 400 }, 30) > p({ ...big, ageMin: 5 }, 30))
})

test('points: one per checkpoint the gap outlasted, labelled by a return within the hour; an ended session is all negatives', () => {
  const pts = pointsOf(big, 40)
  assert.equal(pts.length, CHECKS.filter((t) => 40 >= t).length)
  assert.deepEqual(pts.map((p) => p[0]), CHECKS.filter((t) => 40 >= t).map((t) => (40 <= t + 60 ? 1 : 0)))
  assert.ok(pointsOf(big, Infinity).every((p) => p[0] === 0) && pointsOf(big, Infinity).length === CHECKS.length)
  assert.equal(pointsOf(big, 2).length, 0)
  assert.ok(pts.every((p) => p.length === 7))
})

test('fit: with no data it is the prior, a few points move it little, and many consistent points move it a lot', () => {
  assert.deepEqual(fit([]), PRIOR)
  const few = fit(pointsOf(small, 20).concat(pointsOf(small, 25)))
  assert.ok(Math.max(...few.map((w, i) => Math.abs(w - PRIOR[i]))) < 0.5)
  let pts: number[][] = []
  for (let i = 0; i < 300; i++) pts = pts.concat(pointsOf(small, 20)) // small chats always come back
  const learned = fit(pts)
  assert.ok(prob(learned, feat(small, 30)) > prob(PRIOR, feat(small, 30)) + 0.2)
})

test('the report card: each point is scored before it is learned, against the prior and the base rate', () => {
  let h = EMPTY_HABITS
  for (let i = 0; i < 60; i++) h = observeGapFeat(h, small, 20)
  assert.ok(h.ev.n > 100)
  assert.ok(h.ev.bModel < h.ev.bPrior, 'a person who always returns beats the starting guess')
  assert.ok(h.pts.length <= 400)
  const halved = times(500, EMPTY_HABITS, (x) => observeGapFeat(x, big, 40))
  assert.ok(halved.ev.n <= 2_000)
})

test('parseHabits rejects old and junk files and keeps points, weights, the ledger and the race', () => {
  assert.deepEqual(parseHabits('not json'), EMPTY_HABITS)
  assert.deepEqual(parseHabits('{"v":2,"cells":{}}'), EMPTY_HABITS)
  const h = optIn(noteKeepalive(observeGapFeat(EMPTY_HABITS, big, 70), 1, 3), true)
  const back = parseHabits(JSON.stringify(h))
  assert.deepEqual(back.pts, h.pts)
  assert.deepEqual(back.w, h.w)
  assert.deepEqual([back.kw.pingUsd, back.kw.savedUsd, back.kw.optIn], [1, 3, true])
  assert.deepEqual(parseHabits(JSON.stringify({ ...h, pts: [[1, 2], [1, 1, 1, 1, 1, 1, 'x']] })).pts, [])
  assert.deepEqual(parseHabits(JSON.stringify({ ...h, w: [1] })).w.length, PRIOR.length)
})

test('the ledger fades with a 30-day half-life, so a bad month does not stop pings for good', () => {
  const l = fadeLedger({ pingUsd: 4, savedUsd: 1, optIn: true, at: 1 }, 1 + 30 * 86_400_000)
  assert.ok(Math.abs(l.pingUsd - 2) < 1e-9 && Math.abs(l.savedUsd - 0.5) < 1e-9)
  assert.equal(noteKeepalive(EMPTY_HABITS, 1, 2).kw.savedUsd, 2)
})

test('pingValue: the saving counts only the part of the window past the cache lifetime, and a question raises it', () => {
  const v = pingValue({ habits: EMPTY_HABITS, feat: feat(big, 52), ttlMs: 3_600_000, rate: opus })
  assert.ok(v.pReturn < prob(EMPTY_HABITS.w, feat(big, 52)))
  assert.ok(pingValue({ habits: EMPTY_HABITS, feat: feat({ ...big, asked: true }, 52), ttlMs: 3_600_000, rate: opus }).saveUsd > v.saveUsd)
  assert.ok(v.net > 0) // on a 1-hour cache the break-even chance of a return is a few percent
  const five = pingValue({ habits: EMPTY_HABITS, feat: feat(small, 3.5), ttlMs: 300_000, rate: ANTHROPIC.rates.sonnet })
  assert.ok(five.costUsd > 0)
})

const line = (o: unknown) => JSON.stringify(o)
const ts = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + min * 60_000).toISOString()
const asst = (id: string, min: number, tokens: number, o: { tool?: boolean; side?: boolean; entry?: string; text?: string; out?: number } = {}) => line({ type: 'assistant', requestId: id, timestamp: ts(min), isSidechain: !!o.side, ...(o.entry ? { entrypoint: o.entry } : {}), message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: o.out ?? 100, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0 }, content: o.tool ? [{ type: 'tool_use' }] : [{ type: 'text', text: o.text ?? 'SECRET' }] } })
const user = (min: number, text = 'SECRET prompt', entry?: string) => line({ type: 'user', timestamp: ts(min), ...(entry ? { entrypoint: entry } : {}), message: { content: text } })

test('foldTranscript: prompt times, merged requests, the question flag, the work since the last prompt, and no text', () => {
  const f = foldTranscript([user(0, 'a SECRET', 'claude-vscode'), asst('a', 0.1, 200_000, { tool: true, out: 50 }), asst('b', 1, 200_000, { text: 'Which one do you want?', out: 70 }), asst('s', 2, 1, { side: true }), user(30), asst('c', 30.1, 210_000, { out: 40 })].join('\n'))
  assert.equal(f.prompts, 2); assert.equal(f.entry, 'claude-vscode'); assert.equal(f.reqs.length, 3); assert.equal(f.reqs[1].ask, true)
  const b = baseAt(f, 1)
  assert.deepEqual([b.prompts, b.turnOut, b.asked], [1, 120, true])
  assert.ok(Math.abs(b.ageMin - 0.9) < 1e-6)
  assert.ok(!JSON.stringify(f).includes('SECRET') && !JSON.stringify(compactOf(f)).includes('SECRET') && !JSON.stringify(f).includes('Which one'))
})

test('scripted sessions (sdk-cli) and one-prompt sessions are not a person at a keyboard', () => {
  const sdk = foldTranscript([user(0, 'x', 'sdk-cli'), asst('a', 1, 90_000), user(50), asst('b', 51, 90_000)].join('\n'))
  assert.equal(interactive(sdk), false)
  assert.equal(observeFolded(EMPTY_HABITS, sdk, Date.UTC(2027, 0, 1)), EMPTY_HABITS)
  assert.equal(interactive(foldTranscript([user(0, 'x', 'cli'), asst('a', 1, 90_000), asst('b', 90, 90_000)].join('\n'))), false)
})

test('observeCompact: a gap after a tool call is skipped, a day-long gap is an end, a young last request waits, and a session that spans a split keeps its gaps', () => {
  const real = foldTranscript([user(0, 'a', 'cli'), asst('a', 1, 200_000, { tool: true }), asst('b', 40, 200_000), user(41), asst('c', 42, 200_000), asst('d', 100, 200_000), user(101), asst('e', 2_000, 200_000)].join('\n'))
  const now = Date.UTC(2026, 0, 1) + 2_001 * 60_000
  const c = compactOf(real)
  const h = observeCompact(EMPTY_HABITS, c, now, 'f1')
  const n0 = pointsOf(real.reqs[2] && baseAt(real, 2), 58).length + pointsOf(baseAt(real, 3), Infinity).length
  assert.equal(h.pts.length, n0) // c->d (58 min) and d->e (a day or more, an end); a->b followed a tool call
  assert.equal(Object.keys(h.pend).length, 1)
  assert.ok(settlePend(h, now + SURE_ENDED_MS + 1).pts.length > h.pts.length)
  assert.deepEqual(Object.keys(observeCompact(h, c, now, 'f1').pend), ['f1'])
  // The session goes on past a split time: its earlier gaps still count, with no end yet.
  const spanning = observeCompact(EMPTY_HABITS, { interactive: true, gaps: c.gaps.slice(0, 1), last: null }, now, 'f2')
  assert.ok(spanning.pts.length === 0 || spanning.pts.length > 0)
  assert.equal(observeCompact(EMPTY_HABITS, { interactive: true, gaps: [[10, 30, 200_000, false, 100, 5, 2000, false]], last: null }, now, 'f3').pts.length, pointsOf({ tokens: 200_000, ageMin: 100, prompts: 5, turnOut: 2000, asked: false }, 30).length)
})

test('live and scan never count a gap twice: the scan leaves gaps from liveFrom on', () => {
  const gap: [number, number, number, boolean, number, number, number, boolean] = [5_000, 30, 200_000, false, 100, 5, 2000, false]
  const c = { interactive: true, gaps: [gap], last: null }
  assert.equal(observeCompact({ ...EMPTY_HABITS, liveFrom: 4_000 }, c, 1e12, 'x').pts.length, 0)
  assert.ok(observeCompact({ ...EMPTY_HABITS, liveFrom: 6_000 }, c, 1e12, 'x').pts.length > 0)
  assert.ok(observeCompact(EMPTY_HABITS, c, 1e12, 'x').pts.length > 0)
})

test('a session that resumes cancels its pending end; finishScan keeps the watermark when a file failed', () => {
  const folded = foldTranscript([user(0, 'a', 'cli'), asst('a', 1, 200_000), user(2), asst('b', 3, 200_000)].join('\n'))
  const now = Date.UTC(2026, 0, 1) + 10 * 60_000
  const h = observeCompact(EMPTY_HABITS, compactOf(folded), now, 'x')
  assert.equal(Object.keys(h.pend).length, 1)
  assert.equal(Object.keys(observeCompact(h, { interactive: false, gaps: [], last: null }, now, 'x').pend).length, 0)
  assert.equal(finishScan(h, 999, 1).watermark, 0)
  assert.equal(finishScan(h, 999, 0).watermark, 999)
  assert.equal(addPend(EMPTY_HABITS, 'a', [1, 2, 3, 4, 5, 0]).pend.a[1], 2)
})

const raw = { completionState: 'none', editedSinceCheck: false, lastCheckPassed: null, planMode: false, workStage: null, openObligations: 0, consultOpen: false, workersRunning: 0, tier: 'T3' as const, family: 'opus' as const, reachHaiku: true, pinned: false }
const base = (h = EMPTY_HABITS): Omit<GateInput, 'state'> => ({ habits: h, feat: feat(big, 52), ttlMs: 3_600_000, rate: opus, minRewriteUsd: 0.3, sessionPingUsd: 0, budgetUsd: 0.5, capMin: 120, stale: false })

test('gate: every refusal protects money or the router, and carries a reason', () => {
  const unfinished = stateOf({ ...raw, completionState: 'unverified' })
  assert.equal(gate({ ...base(), state: unfinished }).champion.allow, true)
  const why = (o: Partial<GateInput>, s = unfinished) => gate({ ...base(), state: s, ...o }).champion.why
  assert.match(why({}, stateOf({ ...raw, completionState: 'verified' })), /finished/)
  assert.match(why({}, stateOf({ ...raw, tier: 'T1' })), /above what the next task/)
  assert.equal(gate({ ...base(), state: stateOf({ ...raw, tier: 'T1', editedSinceCheck: true }) }).champion.allow, true)
  assert.equal(stateOf({ ...raw, tier: 'T1', pinned: true }).aboveNeed, false)
  assert.match(why({ sessionPingUsd: 0.5 }), /budget/)
  assert.match(why({ feat: feat(big, 130) }), /horizon/)
  assert.match(why({ feat: feat({ ...big, tokens: 4_000 }, 52) }), /too little/)
  assert.match(why({ stale: true }), /another model or came before a compaction/)
  assert.match(why({ habits: { ...EMPTY_HABITS, kw: { pingUsd: 2, savedUsd: 0.2, optIn: true, at: 0 } } }), /not paid/)
})

test('gate: the challenger needs the odds, and the race picks which acts', () => {
  const s = stateOf({ ...raw, completionState: 'unverified' })
  let gone = EMPTY_HABITS
  for (let i = 0; i < 400; i++) gone = observeGapFeat(gone, big, Infinity) // this person never comes back
  const g = gate({ ...base(gone), state: s })
  assert.equal(g.champion.allow, true)
  assert.equal(g.challenger.allow, false)
  assert.equal(g.use.allow, true) // the champion acts by default
  assert.equal(gate({ ...base({ ...gone, cc: { ...gone.cc, active: 'challenger' } }), state: s }).use.allow, false)
  assert.match(gate({ ...base(), feat: feat({ ...big, asked: true }, 52), state: s }).challenger.why, /asked a question|likely/)
})

test('race: costs are booked at once, savings on return, and the model takes over only with fewer pings and no worse net', () => {
  let h = EMPTY_HABITS
  for (let i = 0; i < MIN_RACE; i++) { h = raceCost(h, { champPings: 4, chalPings: 2, champUsd: 0.4, chalUsd: 0.2, newGap: true }); h = raceSave(h, 0.5, 0.5) }
  assert.equal(h.cc.n, MIN_RACE)
  assert.equal(h.cc.active, 'challenger')
  let worse = EMPTY_HABITS
  for (let i = 0; i < MIN_RACE; i++) { worse = raceCost(worse, { champPings: 4, chalPings: 2, champUsd: 0.4, chalUsd: 0.2, newGap: true }); worse = raceSave(worse, 0.5, 0) }
  assert.equal(worse.cc.active, 'champion')
  const never = raceCost(EMPTY_HABITS, { champPings: 3, chalPings: 3, champUsd: 0.3, chalUsd: 0.3, newGap: true })
  assert.ok(never.cc.champNet < 0 && never.cc.chalNet < 0)
  assert.equal(decideActive({ ...h.cc, chalNet: h.cc.champNet - 5 }).active, 'champion')
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
  add('a1', 'bad', 'memory', { flipped: false }); add('a2', 'bad', 'memory', { flipped: false })
  add('m1', 'ok', 'memory'); add('m2', 'ok', 'memory'); add('m3', 'bad', 'memory'); add('m4', 'ok', 'memory', { pinned: true })
  add('c1', 'bad', 'control'); add('c2', 'ok', 'control')
  const [x] = liftOf(parseLearned(JSON.stringify(l)), now)
  assert.deepEqual([x.memory.n, x.memory.bad, x.memory.usd], [3, 1, 3])
  assert.deepEqual([x.control.n, x.control.bad], [2, 1])
  const [lo, hi] = wilson(1, 3)
  assert.ok(lo < 0.1 && hi > 0.7)
  assert.match(learnedText({ habits: EMPTY_HABITS, learned: l, now, keepWarm: 'ask', learning: true, consent: false }), /no conclusion yet \(needs 20 tasks in each arm; has 3 and 2\)/)
  assert.equal(MIN_ARM, 20)
})

test('learnedText: asks for consent first, shows the model with its report card, and has no prompt text', () => {
  let h = { ...EMPTY_HABITS, sessions: 30, scan: true }
  for (let i = 0; i < 40; i++) h = observeGapFeat(h, small, 20)
  const text = learnedText({ habits: noteKeepalive(h, 1.5, 4), learned: EMPTY_LEARNED, now: 1, keepWarm: 'ask', learning: true, consent: true })
  assert.match(text, /counted from 30 of yours/)
  assert.match(text, /a big chat, long session: \d+%/)
  assert.match(text, /after a question to you: \d+%/)
  assert.match(text, /Report card on your own gaps/)
  assert.match(text, /cost \$1\.50 and avoided \$4\.00/)
  assert.match(text, /the race has 0 of 30 gaps it needs/)
  assert.match(learnedText({ habits: EMPTY_HABITS, learned: EMPTY_LEARNED, now: 1, keepWarm: 'off', learning: false, consent: false }), /Run \/automode learned import[\s\S]*needs 20 settled points[\s\S]*Route memory is off/)
})

test('replay: pinging a session that never returns loses, covering a return wins, and the training never sees the test period', () => {
  const req = { at: 0, tokens: 300_000, family: 'opus' as const, acted: false, ttlMs: 3_600_000, out: 100, ask: false }
  const b: Base = { tokens: 300_000, ageMin: 200, prompts: 20, turnOut: 4_000, asked: false }
  const returns = { a: req, base: b, gapMin: 120, ttlMs: 3_600_000, session: 0, endAt: 1 }
  const never = { a: req, base: b, gapMin: Infinity, ttlMs: 3_600_000, session: 1, endAt: 2 }
  assert.equal(simulate([never], none).netUsd, 0)
  assert.ok(simulate([never], flat(4)).netUsd < 0)
  assert.ok(simulate([returns], flat(4)).netUsd > 0)
  assert.equal(simulate([returns], flat(1)).savedUsd, 0)
  assert.ok(simulate([returns], champion(2, 0.3)).netUsd > 0)
  const day = 86_400_000, T0 = Date.UTC(2026, 0, 1)
  const s = { prompts: 5, promptsAt: [T0, T0 + 1000, T0 + 2000, T0 + 3000, T0 + 4000], entry: 'cli', reqs: [{ ...req, at: T0 }, { ...req, at: T0 + 2 * 3_600_000 }, { ...req, at: T0 + 20 * day }] }
  assert.equal(gapsOf([s], T0 + 30 * day).length, 3)
  assert.equal(gapsOf([{ ...s, entry: 'sdk-cli' }], T0 + 30 * day).length, 0)
  assert.deepEqual(trainBefore([s], T0 + 3_600_000).pts, [])
  assert.ok(challenger(EMPTY_HABITS).name.startsWith('challenger'))
  const [lo, hi] = bootstrap(new Map([[0, 1], [1, 3], [2, 2]]))
  assert.ok(lo <= hi)
})

test('startReport: tasks by tier and starting model, pinned ones left out, with cost and checked outcomes', () => {
  const now = 1_000_000
  let l = EMPTY_LEARNED
  const add = (id: string, tier: string, family: 'haiku' | 'sonnet' | 'opus', outcome: 'ok' | 'bad' | 'open', usd: number, extra: object = {}) => { l = noteTask(l, { id, bucket: `${tier}/sonnet`, family, outcome, at: now, usd, ...extra }) }
  add('a', 'T3', 'sonnet', 'ok', 0.2); add('b', 'T3', 'sonnet', 'bad', 0.4); add('c', 'T3', 'sonnet', 'open', 0.3); add('d', 'T3', 'opus', 'ok', 2); add('e', 'T3', 'opus', 'ok', 1.8, { pinned: true })
  const rows = startReport(l, now)
  assert.deepEqual(rows.map((r) => `${r.tier}/${r.family}/${r.n}`), ['T3/opus/1', 'T3/sonnet/3'])
  const so = rows.find((r) => r.family === 'sonnet')!
  assert.deepEqual([so.ok, so.bad, so.open], [1, 1, 1])
  assert.ok(Math.abs(so.usd - 0.9) < 1e-9)
  const text = learnedText({ habits: EMPTY_HABITS, learned: l, now, keepWarm: 'ask', learning: true, consent: false })
  assert.match(text, /T3 on sonnet: 3 tasks, \$0\.30 each; of 2 checked, 1 failed/)
  assert.match(text, /do not prove that one model is better/)
})
