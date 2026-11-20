// The learning pass: local gaps first, one cheap model question second, a whitelist before anything is kept, and a score of how the model's
// proposals fared against the person's own tasks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_LEARNED, noteTask, type Learned, type LearnedTask } from '../hooks/lib/learn.ts'
import { WARMUP, assign, bucketOf } from '../hooks/lib/experiment.ts'
import { EMPTY_RULEBOOK, FOCUS_MS, MIN_GAP_MS, MIN_NEW_TASKS, PASS_CAP_USD, WEEK_CAP_USD, digestOf, due, findings, focusFor, parseReflection, parseRulebook, runPass, scoreOf, vet, weekSpend, type Rulebook } from '../hooks/lib/reflect.ts'
import { learnedText } from '../hooks/lib/insight.ts'
import { EMPTY_HABITS } from '../hooks/lib/habits.ts'

const DAY = 86_400_000
const NOW = 100 * DAY
let seq = 0
const task = (o: Partial<LearnedTask> = {}): LearnedTask => ({ id: `r${++seq}`, bucket: 'T3/sonnet', family: 'sonnet', outcome: 'ok', at: NOW - DAY, usd: 0.5, ...o })
const learned = (n: number, o: Partial<LearnedTask> = {}): Learned => Array.from({ length: n }, () => task(o)).reduce((l, t) => noteTask(l, t), EMPTY_LEARNED)
const GOOD = JSON.stringify({ insight: 'T3 on Sonnet takes most of the money; try a Haiku start there.', proposals: [{ key: 'haiku', tier: 'T3', complexity: 'standard', priority: 1, why: 'costliest kind' }] })

test('findings: where the money went, what is untested, and what is blind, from the tasks alone', () => {
  const l = learned(10)
  const f = findings(l, NOW)
  assert.ok(f.some((x) => /T3 on sonnet: 10 tasks, \$0\.50 each, \$5\.00 in all \(100% of \$5\.00\)/.test(x.text)))
  assert.ok(f.some((x) => x.id === 'untested:T3'))
  const blind = findings(learned(10, { outcome: 'open' }), NOW)
  assert.ok(blind.some((x) => x.id === 'blind:T3'))
  assert.deepEqual(findings(EMPTY_LEARNED, NOW), [])
  assert.ok(findings(l, NOW, { pingUsd: 1, savedUsd: 3, chal: 'challenger' }).some((x) => /pings cost \$1\.00 and avoided \$3\.00 of rewrites; the return model acts/.test(x.text)))
  assert.ok(digestOf(f).length <= 2_400)
})

test('parseReflection: only whitelisted proposals, clamped, deduplicated, at most three, no stray text', () => {
  const noisy = `sure!\n${JSON.stringify({ insight: 'x'.repeat(500), proposals: [
    { key: 'haiku', tier: 'T3', complexity: 'standard', priority: 9, why: 'a'.repeat(300) },
    { key: 'haiku', tier: 'T3', complexity: 'standard', priority: 1, why: 'dup' },
    { key: 'delete', tier: 'T3', complexity: 'standard' }, { key: 'haiku', tier: 'T0', complexity: 'standard' }, { key: 'haiku', tier: 'T4', complexity: 'standard' }, { key: 'effort', tier: 'T2', complexity: 'wild' },
    { key: 'effort', tier: 'T2', complexity: 'complex' }, { key: 'effort', tier: 'T1', complexity: 'standard' }, { key: 'haiku', tier: 'T1', complexity: 'complex' },
  ] })}\nthanks`
  const r = parseReflection(noisy, 5)!
  assert.equal(r.insight.length, 300)
  assert.deepEqual(r.proposals.map((p) => `${p.key}/${p.tier}/${p.complexity}`), ['haiku/T3/standard', 'effort/T2/complex', 'effort/T1/standard'])
  assert.equal(r.proposals[0].priority, 3)
  assert.equal(r.proposals[0].why.length, 140)
  assert.equal(parseReflection('no json here', 1), null)
  assert.equal(parseReflection('{"proposals":[]}', 1), null)
  assert.equal(parseReflection('{"insight":"ok"}', 1)!.proposals.length, 0)
})

test('vet: a proposal for a kind of task with no history, already adopted, or reverted is dropped', () => {
  const l = learned(WARMUP)
  const p = (tier: 'T1' | 'T2' | 'T3') => ({ key: 'haiku' as const, tier, complexity: 'standard' as const, priority: 1, why: '', at: NOW })
  assert.deepEqual(vet(l, [p('T3'), p('T2')], NOW).kept.map((x) => x.tier), ['T3'])
  assert.equal(vet(learned(WARMUP - 1), [p('T3')], NOW).kept.length, 0)
  let adopted = l
  for (let i = 0; i < 12; i++) { adopted = noteTask(adopted, task({ at: NOW - 10 * DAY + i, usd: 0.1, exp: { k: 'haiku', a: 'probe', b: bucketOf('T3', 'standard') } })); adopted = noteTask(adopted, task({ at: NOW - 10 * DAY + i, usd: 0.5, exp: { k: 'haiku', a: 'hold', b: bucketOf('T3', 'standard') } })) }
  assert.equal(vet(adopted, [p('T3')], NOW).kept.length, 0)
})

test('due: auto runs only when idle with new tasks and not too soon; manual always; off never', () => {
  const base = { mode: 'auto' as const, now: NOW, idleMs: 30 * 60_000, idleMinMs: 20 * 60_000, busy: false, rb: EMPTY_RULEBOOK, l: learned(MIN_NEW_TASKS), manual: false }
  assert.equal(due(base).run, true)
  assert.match(due({ ...base, busy: true }).why, /turn is running/)
  assert.match(due({ ...base, idleMs: 60_000 }).why, /still here/)
  assert.match(due({ ...base, l: learned(MIN_NEW_TASKS - 1) }).why, /too few new tasks/)
  const recent: Rulebook = { ...EMPTY_RULEBOOK, runs: [{ at: NOW - MIN_GAP_MS + 1_000, usd: 0, proposals: 0, kept: 0, model: false }] }
  assert.match(due({ ...base, rb: recent }).why, /ran recently/)
  assert.equal(due({ ...base, mode: 'manual' }).run, false)
  assert.equal(due({ ...base, mode: 'manual', manual: true }).run, true)
  assert.equal(due({ ...base, mode: 'off' }).run, false)
  assert.equal(due({ ...base, mode: 'off', manual: true }).run, true)
})

test('runPass: a good answer becomes a focus, an insight and a run with its cost; focus boosts the probe share', async () => {
  const l = learned(10)
  const res = await runPass({ l, rb: EMPTY_RULEBOOK, now: NOW, model: true, complete: async () => ({ text: GOOD, usd: 0.004 }) })
  assert.equal(res.used, true)
  assert.equal(res.rb.focus.length, 1)
  assert.equal(res.rb.runs[0].usd, 0.004)
  assert.equal(res.rb.score.proposed, 1)
  assert.match(res.insight, /Next to test: T3\/standard haiku/)
  assert.equal(focusFor(res.rb, 'haiku', 'T3', 'standard', NOW), true)
  assert.equal(focusFor(res.rb, 'haiku', 'T3', 'standard', NOW + FOCUS_MS + 1), false)
  assert.equal(focusFor(res.rb, 'effort', 'T3', 'standard', NOW), false)
  const B = bucketOf('T3', 'standard')
  const n = (focus: boolean) => Array.from({ length: 2_000 }, (_, i) => assign(l, 'haiku', B, `x${i}`, NOW, true, focus)!.arm).filter((a) => a === 'probe').length / 2_000
  assert.ok(n(true) > n(false) + 0.1)
})

test('runPass: without a usable answer it still gives the local account, and never spends more than its caps', async () => {
  const l = learned(10)
  const bad = await runPass({ l, rb: EMPTY_RULEBOOK, now: NOW, model: true, complete: async () => ({ text: 'I cannot', usd: 0.003 }) })
  assert.equal(bad.used, false)
  assert.match(bad.skipped!, /could not be read/)
  assert.match(bad.insight, /T3 on sonnet/)
  const none = await runPass({ l, rb: EMPTY_RULEBOOK, now: NOW, model: true, complete: async () => null })
  assert.match(none.skipped!, /no answer/)
  const off = await runPass({ l, rb: EMPTY_RULEBOOK, now: NOW, model: false, complete: async () => { throw new Error('must not be called') } })
  assert.match(off.skipped!, /model step is off/)
  const thrown = await runPass({ l, rb: EMPTY_RULEBOOK, now: NOW, model: true, complete: async () => { throw new Error('boom') } })
  assert.equal(thrown.used, false)
  const rich = await runPass({ l, rb: EMPTY_RULEBOOK, now: NOW, model: true, complete: async () => ({ text: GOOD, usd: 5 }) })
  assert.equal(rich.usd, PASS_CAP_USD)
  const spent: Rulebook = { ...EMPTY_RULEBOOK, runs: [{ at: NOW - DAY, usd: WEEK_CAP_USD, proposals: 0, kept: 0, model: true }] }
  assert.equal(weekSpend(spent, NOW), WEEK_CAP_USD)
  const broke = await runPass({ l, rb: spent, now: NOW, model: true, complete: async () => { throw new Error('must not be called') } })
  assert.match(broke.skipped!, /weekly learning budget/)
  const empty = await runPass({ l: EMPTY_LEARNED, rb: EMPTY_RULEBOOK, now: NOW, model: true, complete: async () => { throw new Error('must not be called') } })
  assert.match(empty.skipped!, /nothing to ask/)
})

test('the score: a proposal the person\'s tasks confirm or refute is counted, and a proposal the data already reverted is not kept again', async () => {
  const B = bucketOf('T3', 'standard')
  let l = learned(10)
  const rb: Rulebook = { ...EMPTY_RULEBOOK, focus: [{ key: 'haiku', tier: 'T3', complexity: 'standard', priority: 1, why: '', at: NOW }], score: { proposed: 1, confirmed: 0, refuted: 0 } }
  assert.deepEqual(scoreOf(rb, l, NOW), { proposed: 1, confirmed: 0, refuted: 0 })
  for (let i = 0; i < 12; i++) { l = noteTask(l, task({ at: NOW - 5 * DAY + i, usd: 0.1, exp: { k: 'haiku', a: 'probe', b: B } })); l = noteTask(l, task({ at: NOW - 5 * DAY + i, usd: 0.5, exp: { k: 'haiku', a: 'hold', b: B } })) }
  assert.equal(scoreOf(rb, l, NOW).confirmed, 1)
  let bad = learned(10)
  for (let i = 0; i < 8; i++) { bad = noteTask(bad, task({ at: NOW - 5 * DAY + i, usd: 0.3, outcome: 'bad', exp: { k: 'haiku', a: 'probe', b: B } })); bad = noteTask(bad, task({ at: NOW - 5 * DAY + i, usd: 0.5, exp: { k: 'haiku', a: 'hold', b: B } })) }
  assert.equal(scoreOf(rb, bad, NOW).refuted, 1)
  const again = await runPass({ l: bad, rb: EMPTY_RULEBOOK, now: NOW, model: true, complete: async () => ({ text: GOOD, usd: 0.004 }) })
  assert.equal(again.rb.focus.length, 0)
})

test('parseRulebook keeps good fields and drops junk; the report shows the last pass, the focus and the score', () => {
  assert.deepEqual(parseRulebook('nope'), EMPTY_RULEBOOK)
  const rb: Rulebook = { ...EMPTY_RULEBOOK, focus: [{ key: 'haiku', tier: 'T3', complexity: 'standard', priority: 2, why: 'w', at: 5 }], insights: [{ at: 5, text: 'T3 takes the money.' }], runs: [{ at: 5, usd: 0.003, proposals: 1, kept: 1, model: true }], score: { proposed: 1, confirmed: 0, refuted: 0 } }
  assert.deepEqual(parseRulebook(JSON.stringify(rb)), rb)
  const junk = parseRulebook(JSON.stringify({ ...rb, focus: [{ key: 'rm', tier: 'T3', complexity: 'standard', at: 1 }, ...rb.focus] }))
  assert.equal(junk.focus.length, 1)
  const text = learnedText({ habits: EMPTY_HABITS, learned: EMPTY_LEARNED, now: NOW, keepWarm: 'ask', learning: true, consent: false, rulebook: rb })
  assert.match(text, /Learning passes \(when you are away\): 1 so far/)
  assert.match(text, /Last: T3 takes the money/)
  assert.match(text, /In focus to test next: T3\/standard Haiku start/)
  assert.match(text, /1 kept, 0 confirmed/)
})

test('causeOf and kindOf: a defect outranks flaky and environment; a kind needs every edited path to agree', async () => {
  const { causeOf, kindOf } = await import('../hooks/lib/learn.ts')
  assert.equal(causeOf([]), undefined)
  assert.equal(causeOf([{ class: 'environment' }, { class: 'defect' }]), 'defect')
  assert.equal(causeOf([{ class: 'environment' }, { class: 'flaky' }]), 'flaky')
  assert.equal(causeOf([{ class: 'environment' }]), 'environment')
  assert.equal(causeOf([{ class: 'other' }]), 'unknown')
  assert.equal(kindOf([]), 'none')
  assert.equal(kindOf(['README.md', 'docs/a.mdx']), 'docs')
  assert.equal(kindOf(['tests/a.test.ts']), 'tests')
  assert.equal(kindOf(['package.json']), 'config')
  assert.equal(kindOf(['README.md', 'src/a.ts']), 'code')
})

test('failed: a bad or escalated task counts against the cheaper start unless the environment or a flake caused it', async () => {
  const { failed } = await import('../hooks/lib/experiment.ts')
  const t = (x: Partial<LearnedTask>) => ({ id: 'a', bucket: 'T2/sonnet', family: 'haiku', outcome: 'bad', at: 1, ...x }) as LearnedTask
  assert.equal(failed(t({})), true)
  assert.equal(failed(t({ outcome: 'ok', esc: true })), true)
  assert.equal(failed(t({ cause: 'defect' })), true)
  assert.equal(failed(t({ cause: 'environment' })), false)
  assert.equal(failed(t({ cause: 'flaky', esc: true })), false)
})
