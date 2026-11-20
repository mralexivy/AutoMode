// Adaptive routing: the experiment engine learns, per person, whether a cheaper start does as well; it adopts what is cheaper and no worse,
// reverts what is worse, never probes without checks or history, and corrects itself as tasks arrive.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_LEARNED, noteTask, parseLearned, type Learned, type LearnedTask } from '../hooks/lib/learn.ts'
import { HOLD_SHARE, MIN_ARM_N, PROBE_SHARE, REVERT_MS, WARMUP, assign, bucketOf, pCheaper, pFailMore, pickKey, readiness, reportOf, share, statusOf } from '../hooks/lib/experiment.ts'
import { learnedText } from '../hooks/lib/insight.ts'
import { EMPTY_HABITS } from '../hooks/lib/habits.ts'

const DAY = 86_400_000
const B = bucketOf('T3', 'standard')
let seq = 0
const task = (o: Partial<LearnedTask> & { at: number }): LearnedTask => ({ id: `t${++seq}`, bucket: 'T3/sonnet', family: 'sonnet', outcome: 'ok', ...o })
const withTasks = (ts: LearnedTask[]): Learned => ts.reduce((l, t) => noteTask(l, t), EMPTY_LEARNED)
// n checked history tasks, so the kind of task is ready for a probe
const history = (n: number, at = 0): LearnedTask[] => Array.from({ length: n }, () => task({ at, outcome: 'ok', usd: 0.4 }))
const exp = (a: 'hold' | 'probe', at: number, o: Partial<LearnedTask> = {}) => task({ at, exp: { k: 'haiku', a, b: B }, ...o })

test('share: a fixed, even spread by task id', () => {
  const xs = Array.from({ length: 4_000 }, (_, i) => share(`haiku|task-${i}`))
  assert.ok(xs.every((x) => x >= 0 && x < 1))
  assert.ok(Math.abs(xs.filter((x) => x < 0.15).length / xs.length - 0.15) < 0.03)
  assert.equal(share('a'), share('a'))
})

test('readiness: no probe before the kind of task has history, or where nobody would see a failure', () => {
  assert.equal(readiness(EMPTY_LEARNED, B, 1).why, 'warming')
  assert.equal(readiness(withTasks(history(WARMUP - 1)), B, 1).ok, false)
  assert.equal(readiness(withTasks(history(WARMUP)), B, 1).ok, true)
  const open = withTasks(Array.from({ length: 12 }, () => task({ at: 0, outcome: 'open' })))
  assert.deepEqual([readiness(open, B, 1).ok, readiness(open, B, 1).why], [false, 'blind'])
  assert.equal(readiness(withTasks(history(12).map((t) => ({ ...t, pinned: true }))), B, 1).ok, false) // a model the person chose says nothing
})

test('assign: outside the experiment unless eligible and ready, a probe share while collecting, and deterministic', () => {
  const ready = withTasks(history(WARMUP))
  assert.equal(assign(ready, 'haiku', B, 'x1', 1, false), null)
  assert.equal(assign(EMPTY_LEARNED, 'haiku', B, 'x1', 1, true), null)
  const arms = Array.from({ length: 2_000 }, (_, i) => assign(ready, 'haiku', B, `id${i}`, 1, true)!.arm)
  assert.ok(Math.abs(arms.filter((a) => a === 'probe').length / arms.length - PROBE_SHARE) < 0.03)
  assert.deepEqual(assign(ready, 'haiku', B, 'same', 1, true), assign(ready, 'haiku', B, 'same', 1, true))
})

test('the comparison: a clearly cheaper probe with the same failures is cheaper with confidence, and a worse one fails more', () => {
  const stats = (n: number, failed: number, usd: number, sd = 0.05) => ({ n, checked: n, failed, usd: usd * n, usd2: n * (usd * usd + sd * sd) })
  assert.ok(pCheaper(stats(10, 0, 0.1), stats(10, 0, 0.5)) > 0.99)
  assert.ok(pCheaper(stats(10, 0, 0.5), stats(10, 0, 0.1)) < 0.01)
  assert.ok(pCheaper(stats(1, 0, 0.1), stats(1, 0, 0.5)) === 0.5)
  assert.ok(pFailMore(stats(10, 5, 0.1), stats(10, 0, 0.5), 0.15) > 0.8)
  assert.ok(pFailMore(stats(10, 0, 0.1), stats(10, 0, 0.5), 0.1) < 0.2)
})

test('adopts a cheaper start that does as well, and keeps a tenth on the shipped rules to go on measuring', () => {
  let l = withTasks(history(WARMUP))
  for (let i = 0; i < MIN_ARM_N; i++) { l = noteTask(l, exp('probe', 10 + i, { usd: 0.1 + (i % 3) * 0.02 })); l = noteTask(l, exp('hold', 10 + i, { usd: 0.5 + (i % 3) * 0.04 })) }
  const st = statusOf(l, 'haiku', B, 100)
  assert.equal(st.state, 'adopted')
  const arms = Array.from({ length: 1_000 }, (_, i) => assign(l, 'haiku', B, `n${i}`, 100, true)!)
  assert.ok(arms.every((a) => a.adopted))
  assert.ok(Math.abs(arms.filter((a) => a.arm === 'hold').length / arms.length - HOLD_SHARE) < 0.03)
  assert.match(learnedText({ habits: EMPTY_HABITS, learned: l, now: 100, keepWarm: 'ask', learning: true, consent: false }), /T3\/standard, a Haiku start: adopted/)
})

test('does not adopt a cheaper start that is not clearly cheaper, and reverts one that fails more, then tries again after a while', () => {
  let same = withTasks(history(WARMUP))
  for (let i = 0; i < 10; i++) { same = noteTask(same, exp('probe', 10 + i, { usd: 0.5 + (i % 2) * 0.1 })); same = noteTask(same, exp('hold', 10 + i, { usd: 0.5 + (i % 2) * 0.1 })) }
  assert.equal(statusOf(same, 'haiku', B, 100).state, 'collecting')
  let bad = withTasks(history(WARMUP))
  for (let i = 0; i < 8; i++) { bad = noteTask(bad, exp('probe', 10 + i, { usd: 0.3, outcome: i < 5 ? 'bad' : 'ok' })); bad = noteTask(bad, exp('hold', 10 + i, { usd: 0.5 })) }
  const s = statusOf(bad, 'haiku', B, 100)
  assert.equal(s.state, 'reverted')
  assert.match(s.why, /failed clearly more often/)
  assert.equal(assign(bad, 'haiku', B, 'z', 100, true), null) // the shipped start holds
  assert.equal(statusOf(bad, 'haiku', B, 100 + REVERT_MS + 20 * DAY).state, 'collecting') // and the experiment starts over
})

test('an adopted start that later turns bad is reverted, because the state follows the tasks', () => {
  let l = withTasks(history(WARMUP))
  for (let i = 0; i < MIN_ARM_N; i++) { l = noteTask(l, exp('probe', 10 + i, { usd: 0.1 })); l = noteTask(l, exp('hold', 10 + i, { usd: 0.5 })) }
  assert.equal(statusOf(l, 'haiku', B, 100).state, 'adopted')
  for (let i = 0; i < 6; i++) l = noteTask(l, exp('probe', 30 + i, { usd: 0.4, outcome: 'bad' }))
  assert.equal(statusOf(l, 'haiku', B, 100).state, 'reverted')
})

test('a rescued task counts as a failure and its whole cost counts against the probe', () => {
  let l = withTasks(history(WARMUP))
  for (let i = 0; i < 10; i++) { l = noteTask(l, exp('probe', 10 + i, { usd: 0.1, esc: i < 4 })); l = noteTask(l, exp('hold', 10 + i, { usd: 0.5 })) }
  assert.equal(statusOf(l, 'haiku', B, 100).probe.failed, 4)
})

test('parseLearned keeps the experiment fields and drops junk ones', () => {
  const l = withTasks([exp('probe', 5, { usd: 0.2, esc: true })])
  const back = parseLearned(JSON.stringify(l))
  assert.deepEqual(back.tasks[0].exp, { k: 'haiku', a: 'probe', b: B })
  assert.equal(back.tasks[0].esc, true)
  const junk = parseLearned(JSON.stringify({ ...l, tasks: [{ ...l.tasks[0], exp: { k: 'nope', a: 'probe', b: 'x' } }] }))
  assert.equal(junk.tasks[0].exp, undefined)
  assert.equal(reportOf(EMPTY_LEARNED, 1).length, 0)
})

// A simulated person: the cheaper start fails `pFail` of the time and costs `cheap` against `dear`. The learner plays every task, and learns.
function play(pFail: number, cheap: number, dear: number, tasks: number, seed = 3) {
  let s = seed
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
  let l = withTasks(history(WARMUP))
  let total = 0, onlyHold = 0, probes = 0
  for (let i = 0; i < tasks; i++) {
    const at = 100 + i * 3_600_000
    const a = assign(l, 'haiku', B, `sim${seed}-${i}`, at, true)
    const probe = a?.arm === 'probe'
    const fail = probe && rnd() < pFail
    const usd = probe ? (fail ? cheap + dear : cheap) : dear
    total += usd; onlyHold += dear; probes += probe ? 1 : 0
    if (a) l = noteTask(l, task({ at, exp: { k: 'haiku', a: a.arm, b: B }, usd, outcome: fail ? 'bad' : 'ok', esc: fail }))
    else l = noteTask(l, task({ at, usd: dear }))
  }
  return { l, total, onlyHold, probes, state: statusOf(l, 'haiku', B, 100 + tasks * 3_600_000).state }
}

test('simulated people: it learns who the cheaper start suits, saves money for them, and loses little where it does not suit', () => {
  const suits = play(0.04, 0.1, 0.5, 150)
  assert.equal(suits.state, 'adopted')
  assert.ok(suits.total < suits.onlyHold * 0.6, `${suits.total} vs ${suits.onlyHold}`)
  const doesnt = play(0.6, 0.1, 0.5, 150)
  assert.notEqual(doesnt.state, 'adopted')
  assert.ok(doesnt.total < doesnt.onlyHold * 1.15, `${doesnt.total} vs ${doesnt.onlyHold}`) // the price of finding out stays small
  for (const seed of [1, 2, 3, 4, 5]) assert.equal(play(0.04, 0.1, 0.5, 150, seed).state, 'adopted')
})

test('pickKey: an adopted experiment takes every task it fits, otherwise the id splits them evenly, and none fits none', () => {
  let l = withTasks(history(WARMUP))
  assert.equal(pickKey(l, B, [], 'a', 1), null)
  assert.equal(pickKey(l, B, ['haiku'], 'a', 1), 'haiku')
  const split = Array.from({ length: 1_000 }, (_, i) => pickKey(l, B, ['haiku', 'effort'], `k${i}`, 1))
  assert.ok(Math.abs(split.filter((k) => k === 'haiku').length / 1_000 - 0.5) < 0.06)
  for (let i = 0; i < MIN_ARM_N; i++) { l = noteTask(l, exp('probe', 10 + i, { usd: 0.1 })); l = noteTask(l, exp('hold', 10 + i, { usd: 0.5 })) }
  assert.ok(Array.from({ length: 100 }, (_, i) => pickKey(l, B, ['haiku', 'effort'], `k${i}`, 100)).every((k) => k === 'haiku'))
})
