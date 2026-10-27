// @ts-nocheck TODO(types): 1 errors with strict off. Fix them and delete this line to turn checking on for this file.
// Mutation tests for the auto routing policy. The suite runs the real pure decision functions and a set of
// deliberately bad policies through the same cases. Every case takes its acceptable answer from a source that is
// independent of AutoMode's own rules:
//   upstream  - effortless's labeled cases (bench/external/effortless/judge-cases.json, `ok` = accepted efforts)
//   prices    - list prices checked against the CLI's own cost records (bench/spend-audit.mts, 2026-10-26)
//   measured  - main requests per prompt over 30 days of local transcripts: p25 2, p50 6, p75 16, p90 55 (n 940)
//   brief     - an owner requirement stated in the audit brief (plan mode, stage change, escalation, subagents)
// A mutant must fail at least one case, and the case names why. $0: no model call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { optimizeAuto, escalationTarget, decisionRequired } from '../hooks/lib/auto.ts'
import { switchCheck } from '../hooks/lib/policy.ts'
import { subagentRoute } from '../hooks/lib/subagents.ts'
import { ANTHROPIC } from '../hooks/lib/prices.ts'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const STRENGTH = { haiku: 0, sonnet: 1, opus: 2 }
const UPSTREAM = JSON.parse(fs.readFileSync(new URL('./external/effortless/judge-cases.json', import.meta.url), 'utf8')).cases
const P75_REMAINING = 16 // measured
const MODEL = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' }
const TIER = { haiku: 'T0', sonnet: 'T1', opus: 'T3' }
const route = (family, effort) => ({ tier: TIER[family], family, model: MODEL[family], effort })
// Cache-neutral attempt price: a 100k cached prefix read plus 600 output tokens (prices).
const cost = (family, effort) => { const r = ANTHROPIC.rates[family]; return (100_000 * r.input * r.cacheReadX + 600 * r.output * (1 + EFFORTS.indexOf(effort) * 0.3)) / 1e6 }

// ---------------------------------------------------------------- the real policy, as pure functions
const real = {
  name: 'real',
  pick: (c) => {
    const verdicts = Object.fromEntries(Object.entries(c.verdicts).map(([f, [model, effort]]) => [f, { model, effort, why: 'case' }]))
    const best = optimizeAuto({ allowed: ['haiku', 'sonnet', 'opus'], verdicts, hm: c.hm ?? null, consequence: c.consequence, floors: { because: [] }, current: c.current ?? null, cost }).best
    return { family: best.family, effort: best.effort }
  },
  // After a stage change the route is decided again from the new verdict; otherwise the running route stays.
  next: (c) => decisionRequired({ stageChanged: c.stageChanged, planExited: c.planExited }).required ? real.pick(c) : c.running,
  switch: (c) => switchCheck(c.switchInput).verdict,
  escalate: (c) => { const t = escalationTarget(c.running, c.floorTier, ['sonnet', 'opus']); return { family: t.family, effort: t.effort } },
  subagent: (c) => { const r = subagentRoute({ type: c.type, parentFamily: c.parent, demand: null }); return r ? r.model : c.parent },
}

// ---------------------------------------------------------------- bad policies
const fixed = (family, effort) => () => ({ family, effort })
const MUTANTS = [
  { ...real, name: 'always Sonnet medium', pick: fixed('sonnet', 'medium'), next: fixed('sonnet', 'medium') },
  { ...real, name: 'always Opus high', pick: fixed('opus', 'high'), next: fixed('opus', 'high') },
  { ...real, name: 'always the cheapest model', pick: (c) => ({ family: 'haiku', effort: real.pick(c).effort }), next: (c) => ({ family: 'haiku', effort: real.next(c).effort }) },
  { ...real, name: 'always xhigh for planning', pick: (c) => (c.planning ? { ...real.pick(c), effort: 'xhigh' } : real.pick(c)) },
  { ...real, name: 'always inherit the previous effort', pick: (c) => ({ ...real.pick(c), effort: c.previousEffort ?? real.pick(c).effort }), next: (c) => c.running },
  { ...real, name: 'always keep a warm model', switch: (c) => (c.warm ? 'hold' : real.switch(c)) },
  { ...real, name: 'always switch to the cheaper model', switch: () => 'switch' },
  { ...real, name: 'ignore subagent spending', subagent: (c) => c.parent },
  { ...real, name: 'ignore cache rewrites', switch: (c) => switchCheck({ ...c.switchInput, cache: { ...c.switchInput.cache, prefixTokens: 0 } }).verdict },
  { ...real, name: 'ignore task-stage transitions', next: (c) => c.running },
  { ...real, name: 'disable escalation', escalate: (c) => c.running },
]

// ---------------------------------------------------------------- independent cases
const cases = []
const effortHit = (ok) => (d) => ok.includes(d.effort) || `effort ${d.effort} outside ${ok.join('/')}`

// 1. Upstream effort labels. The judge is an oracle (it answers the lowest accepted effort for the running model),
//    so a miss is the policy layer's own doing.
for (const u of UPSTREAM) {
  cases.push({ id: `upstream:${u.id}`, source: 'upstream', kind: 'pick', input: { verdicts: { [u.current.model]: [u.current.model, u.ok[0]] }, previousEffort: u.current.effort, current: { family: u.current.model, effort: u.current.effort } }, accept: effortHit(u.ok) })
}
// 2. Plan mode gets adequate reasoning, not automatic xhigh: upstream cases labeled low or medium, asked in plan mode.
for (const u of UPSTREAM.filter((x) => !x.ok.includes('xhigh') && !x.ok.includes('high')).slice(0, 8)) {
  cases.push({ id: `plan:${u.id}`, source: 'brief+upstream', kind: 'pick', input: { planning: true, verdicts: { [u.current.model]: [u.current.model, u.ok[0]] }, current: { family: u.current.model, effort: u.current.effort } }, accept: effortHit(u.ok) })
}
// 3. Haiku when both judges name it, for a trivial lookup.
cases.push({ id: 'haiku-lookup', source: 'upstream (t01, trivial: low)', kind: 'pick', input: { hm: { tier: 'T0', complexity: 'trivial' }, verdicts: { sonnet: ['haiku', 'low'], haiku: ['haiku', 'low'] } },
  accept: (d) => (d.family === 'haiku' && d.effort === 'low') || `${d.family}/${d.effort} for a lookup both judges put on Haiku low` })
// 4. A hard task that both judges put on Opus high is not served by a weaker model or a lower effort.
cases.push({ id: 'hard-on-opus', source: 'upstream (big: high/xhigh)', kind: 'pick', input: { hm: { tier: 'T3', complexity: 'complex' }, verdicts: { sonnet: ['opus', 'high'], opus: ['opus', 'high'] } },
  accept: (d) => (d.family === 'opus' && EFFORTS.indexOf(d.effort) >= 2) || `${d.family}/${d.effort} for a task labeled Opus high` })
// 5. A stage change (plan approved, implementation starts) is decided again from the new verdict.
cases.push({ id: 'plan-exit', source: 'brief', kind: 'next', input: { planExited: true, stageChanged: true, running: { family: 'sonnet', effort: 'xhigh' }, previousEffort: 'xhigh', verdicts: { sonnet: ['sonnet', 'medium'] } },
  accept: (d) => d.effort === 'medium' || `implementation kept ${d.effort} from planning` })
// 6. Cache economics on a warm 400k Opus context: moving to Sonnet costs a full 1h write; the per-request saving
//    over the measured p75 of remaining requests does not pay it back, so the route holds.
const now = 10_000_000
const warmCache = { model: MODEL.opus, effort: 'medium', prefixTokens: 400_000, lastRequestAt: now - 60_000, ttlMs: 3_600_000, effortSharesCache: true }
const downgrade = (cache) => ({ current: route('opus', 'medium'), target: route('sonnet', 'medium'), candidate: { tier: 'T1', source: 'judge', confidence: 0.95, reason: 'case' }, floor: { tier: 'T1', because: [] },
  mandatory: false, cache, now, votes: 2, requestsSinceSwitch: 20, verifiedSinceSwitch: true, sameTask: true, risk: 'none', expectedOutputTokens: 600, prices: ANTHROPIC, requestsInPrompt: 2 })
{
  const r = (f) => ANTHROPIC.rates[f]
  const write = 400_000 * r('sonnet').input * 2 / 1e6 - 400_000 * r('opus').input * r('opus').cacheReadX / 1e6
  const perRequest = (400_000 * (r('opus').input * r('opus').cacheReadX - r('sonnet').input * r('sonnet').cacheReadX) + 600 * (r('opus').output - r('sonnet').output)) / 1e6
  const pays = perRequest * P75_REMAINING > write
  cases.push({ id: 'warm-400k-downgrade', source: `prices+measured (write $${write.toFixed(2)} vs $${(perRequest * P75_REMAINING).toFixed(2)} over p75)`, kind: 'switch', input: { warm: true, switchInput: downgrade(warmCache) },
    accept: (v) => v === (pays ? 'switch' : 'hold') || `${v}: the rewrite ${pays ? 'pays' : 'does not pay'} back over the measured p75` })
}
// 7. The same downgrade on a cold cache (idle past its lifetime) costs nothing to move, so it switches.
cases.push({ id: 'cold-downgrade', source: 'prices', kind: 'switch', input: { warm: false, switchInput: downgrade({ ...warmCache, lastRequestAt: now - 2 * 3_600_000 }) },
  accept: (v) => v === 'switch' || 'held a cold cache: nothing to lose, the cheaper model was adequate' })
// 8. A mandatory quality floor switches up even on a warm cache.
cases.push({ id: 'mandatory-up', source: 'brief', kind: 'switch', input: { warm: true, switchInput: { ...downgrade({ ...warmCache, model: MODEL.sonnet }), current: route('sonnet', 'medium'), target: route('opus', 'high'), mandatory: true } },
  accept: (v) => v === 'switch' || 'a mandatory escalation was held for the cache' })
// 9. Repeated failures raise the route.
cases.push({ id: 'escalate-after-failures', source: 'brief', kind: 'escalate', input: { running: { family: 'sonnet', effort: 'medium' }, floorTier: 'T2' },
  accept: (d) => STRENGTH[d.family] > STRENGTH.sonnet || EFFORTS.indexOf(d.effort) > EFFORTS.indexOf('medium') || `stayed on ${d.family}/${d.effort} after repeated failures` })
// 10. Built-in subagents of an Opus session do not inherit Opus (measured on real transcripts with bench/subagents.mts).
for (const type of ['Explore', 'general-purpose']) {
  cases.push({ id: `subagent-${type}`, source: 'measured', kind: 'subagent', input: { type, parent: 'opus' }, accept: (m) => m !== 'opus' || `${type} inherited Opus` })
}

const run = (p, c) => c.accept(c.kind === 'pick' ? p.pick(c.input) : c.kind === 'next' ? p.next(c.input) : c.kind === 'switch' ? p.switch(c.input) : c.kind === 'escalate' ? p.escalate(c.input) : p.subagent(c.input))
const failures = (p) => cases.map((c) => ({ id: c.id, source: c.source, why: run(p, c) })).filter((r) => r.why !== true)

test('the real policy passes every independent case', () => {
  assert.deepEqual(failures(real), [])
})

for (const m of MUTANTS) {
  test(`mutant "${m.name}" is caught`, () => {
    const f = failures(m)
    assert.ok(f.length > 0, `no case detects "${m.name}"`)
  })
}

test('each mutant is caught by the case that targets it, for the stated reason', () => {
  const by = Object.fromEntries(MUTANTS.map((m) => [m.name, failures(m).map((f) => f.id)]))
  const expectHit = {
    'always Sonnet medium': 'haiku-lookup', 'always Opus high': 'upstream:t01', 'always the cheapest model': 'hard-on-opus',
    'always xhigh for planning': `plan:${UPSTREAM.find((x) => !x.ok.includes('xhigh') && !x.ok.includes('high')).id}`,
    'always inherit the previous effort': 'plan-exit', 'always keep a warm model': 'mandatory-up', 'always switch to the cheaper model': 'warm-400k-downgrade',
    'ignore subagent spending': 'subagent-Explore', 'ignore cache rewrites': 'warm-400k-downgrade', 'ignore task-stage transitions': 'plan-exit', 'disable escalation': 'escalate-after-failures',
  }
  for (const [name, id] of Object.entries(expectHit)) assert.ok(by[name].includes(id), `"${name}" should fail ${id}; failed ${by[name].join(', ') || 'nothing'}`)
})
