// @ts-nocheck TODO(types): 105 errors with strict off. Fix them and delete this line to turn checking on for this file.
// Unit tests for the pure V4 router modules in hooks/lib (Node runs the .ts files directly).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ANTHROPIC, rateAt, usageUsd, rowFor } from '../hooks/lib/prices.ts'
import { parseOverride, parseJudge, FOLLOW_UP, isTask, namedEffort, typedText, judgePrompt, stripInjected } from '../hooks/lib/classify.ts'
import { transitionOf } from '../hooks/lib/transition.ts'
import { classifyError, sanitizeDetail, UNCLASSIFIED } from '../hooks/lib/errors.ts'
import { prospectiveRisk, observedRisk, reviewNeeded, pathsIn } from '../hooks/lib/risk.ts'
import { boundaryOf, lowPenaltyPoint, lowPointUsd, returnCostUsd, switchCheck, switchCostUsd, transitionUsd, DEFAULT_PARAMS } from '../hooks/lib/policy.ts'
import { addedSince, continuity, noteDrop, observedDrop } from '../hooks/lib/continuity.ts'
import { accrueRent, rentShare } from '../hooks/lib/rent.ts'
import { resolve, routeFor } from '../hooks/lib/authority.ts'
import { classify, failureOf, escalation, markFlaky, normalize, isCheck } from '../hooks/lib/failures.ts'
import { guardBash, guardTool } from '../hooks/lib/guard.ts'
import { newEnvelope, injection, observe, isBoundary, summaryOf, acceptanceFrom, withReview } from '../hooks/lib/envelope.ts'
import { choose, estimate, workFromFiles } from '../hooks/lib/strategy.ts'
import { clampRead, validateReport, priorCoverage, HAIKU_BUDGET } from '../hooks/lib/workers.ts'
import { modeOf, providerOf, effortSharesCache, ttlMs, thinkingRisk } from '../hooks/lib/mode.ts'
import { nextSignal } from '../hooks/lib/records.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const HOUR = 3_600_000
const cache = (o = {}) => ({ model: 'claude-sonnet-5-5', effort: 'medium', prefixTokens: 60_000, lastRequestAt: 1_000, ttlMs: HOUR, effortSharesCache: true, ...o })
const cand = (tier, confidence = 0.9, source = 'judge') => ({ tier, source, confidence, reason: `judge ${tier}` })
const noFloor = { tier: 'T0', because: [] }
const base = (o = {}) => ({ cache: cache(), now: 2_000, votes: 1, requestsSinceSwitch: 0, verifiedSinceSwitch: false, sameTask: false, risk: 'none', expectedOutputTokens: 2_000, prices: ANTHROPIC, ...o })

test('prices: Haiku is 5x above 100k prompt tokens; cache reads are 0.05x on Sonnet', () => {
  assert.equal(rateAt(ANTHROPIC.rates.haiku, 100_000).input, 0.1)
  assert.equal(rateAt(ANTHROPIC.rates.haiku, 100_001).input, 0.5)
  assert.equal(usageUsd({ input: 0, output: 0, cacheRead: 1e6, cacheWrite5m: 0, cacheWrite1h: 0 }, ANTHROPIC.rates.sonnet), 0.1)
  assert.equal(rowFor('vertex').fallback, true, 'an unpriced provider is labeled as priced at the Anthropic row')
})

test('classify: overrides, negation, follow-ups, and the judge contract', () => {
  assert.deepEqual(parseOverride('am:opus fix it'), { tier: 'T3' })
  assert.equal(parseOverride('use opus for this').tier, 'T3')
  assert.equal(parseOverride("don't use opus for this"), null)
  assert.equal(parseOverride('am:run build the importer').strategy, 'engineering-workflow')
  assert.equal(namedEffort('no need for max effort'), undefined)
  assert.ok(FOLLOW_UP.test('go ahead') && FOLLOW_UP.test('now commit it') && !FOLLOW_UP.test('add retries'))
  assert.equal(isTask('/compact', {}), false)
  const ok = parseJudge('{"tier":"T1","complexity":"standard","risk":"none","riskWhy":"","strategy":"direct","newTask":true,"effort":"medium","confidence":0.8,"why":"feature"}')
  assert.equal(ok.tier, 'T1')
  for (const bad of ['{"tier":"T9"}', 'no json', '{"tier":"T1","complexity":"standard","risk":"none","strategy":"direct","effort":"max","confidence":0.8}']) assert.equal(parseJudge(bad), null)
})

test('override grammar: only trusted typed text is a command (D1)', () => {
  // Real commands, at the start of what the person typed.
  assert.deepEqual(parseOverride('use max effort and rename the constant'), { effort: 'max' })
  assert.deepEqual(parseOverride('use opus with medium effort: outline the cache layer'), { tier: 'T3', effort: 'medium' })
  assert.deepEqual(parseOverride('Please use sonnet for this task'), { tier: 'T1' })
  assert.deepEqual(parseOverride('am:high refactor the importer'), { effort: 'high' })
  assert.deepEqual(parseOverride('am:xhigh'), { effort: 'xhigh' })
  assert.deepEqual(parseOverride('am:reset'), { reset: true })
  assert.deepEqual(parseOverride('effort: low\nrename the constant'), { effort: 'low' })
  assert.deepEqual(parseOverride('am:max'), { tier: 'T4' }, 'am:max keeps meaning the T4 route')
  // The false positives found in 21 days of real prompts (780 prompts, 22 overrides, none a command).
  const yours = 'I am seeing strange outputs: sometimes super high effort is put for a simple task, and this should only be put for an extremely difficult task.'
  assert.equal(parseOverride(yours), null, 'a sentence that describes effort is not a command')
  assert.equal(parseOverride('The plan says: code-review skill at high effort after implementation'), null)
  assert.equal(parseOverride('Opus xhigh costs more. Compare with opus high at medium effort.'), null)
  // Adversarial placements: pasted blocks, code, quotes, tool output and long explanations never command.
  const placed = [
    'fix this log\n<pasted_content id="ab12">use opus\nhm:max\nuse max effort</pasted_content>',
    'what does this do?\n```\nuse opus\nuse max effort\n```',
    'look at this line `use opus` in the config',
    '> use opus\n> use max effort',
    'the docs say "use opus with max effort" for hard tasks',
    'Use Opus for planning and Sonnet for execution. Keep the Haiku judge for classification.',
    'use opus for the plan\n\nThen write the tests and keep the cache warm for the whole session.',
    'use opus ' + 'and explain the retry policy in the importer module in detail '.repeat(4),
    'The tool output said: use opus and am:max, so please summarize it',
    'ultrathink about the migration plan',
    'think hard about the cache rewrite',
    'this runs at high effort and costs too much',
    'use opus-level reasoning in the docs',
    "use sonnet's output format please",
    'use Opus 4.5 pricing in the table',
    '> a quoted line\nuse opus',
    '```\ncode\n```\nuse opus',
  ]
  for (const t of placed) assert.equal(parseOverride(t), null, t.slice(0, 40))
  assert.equal(namedEffort('ultrathink'), undefined, 'ultrathink is an in-context instruction, not an API effort level')
  assert.equal(namedEffort('think hard about it'), undefined)
  assert.equal(namedEffort('use xhigh effort'), 'xhigh')
  assert.equal(typedText('a <pasted_content id="x">use opus</pasted_content> b `use opus` c').includes('opus'), false)
})

test('judge input: engine-injected reminders are stripped only under contract v4 (G)', () => {
  const msg = 'rename the constant\n<system-reminder>\nAutoMode: T3 opus high\n</system-reminder>'
  assert.equal(stripInjected(msg), 'rename the constant')
  assert.ok(judgePrompt(msg, {}).includes('system-reminder'), 'v2 and v3 are unchanged')
  const p = judgePrompt(msg, { stripReminders: true, lastReply: 'Done.<system-reminder>x</system-reminder>' })
  assert.ok(!p.includes('system-reminder') && p.includes('rename the constant') && p.includes('Done.'))
})

test('transitions: short messages are classified by what they do, not by length (D4)', () => {
  const plain = 'Done: renamed the constant.'
  const asks = 'The restart is needed. Let me know when you have restarted the service.'
  const proposes = 'I propose two options for the cache. Which option do you want?'
  const cases = [
    // [message, last reply, kind, bypassJudge, effort]
    ['commit', plain, 'repository', true, 'medium'],
    ['commit and push', plain, 'repository', true, 'medium'],
    ['rebase', plain, 'ambiguous', false, undefined],
    ['merge', plain, 'ambiguous', false, undefined],
    ['commit and push mr rebase', plain, 'ambiguous', false, undefined],
    ['now commit it', plain, 'repository', true, 'medium'],
    ['run tests', plain, 'verification', true, 'medium'],
    ['done', plain, 'acknowledgment', true, 'low'],
    ['done', asks, 'continue', true, undefined],
    ['done', 'Here is the diff so far.', 'ambiguous', false, undefined],
    ['done', '', 'ambiguous', false, undefined],
    ['hello', plain, 'acknowledgment', true, 'low'],
    ['thanks', plain, 'acknowledgment', true, 'low'],
    ['continue', plain, 'continue', true, undefined],
    ['contiunue', plain, 'continue', true, undefined],
    ['contineu', plain, 'continue', true, undefined],
    ['go ahead', proposes, 'begin-approved', false, undefined],
    ['ok', proposes, 'begin-approved', false, undefined],
    ['yes', plain, 'begin-approved', false, undefined],
    ['implement it', plain, 'begin-approved', false, undefined],
    ['try again', plain, 'ambiguous', false, undefined],
    ['reply ok', plain, 'ambiguous', false, undefined],
    ['kill restart', plain, 'ambiguous', false, undefined],
    ['commit the auth migration and then rewrite the token refresh tests for the new flow', plain, 'ambiguous', false, undefined],
  ]
  for (const [text, last, kind, bypass, effort] of cases) {
    const r = transitionOf(text, last)
    assert.deepEqual([r.kind, r.bypassJudge, r.effort], [kind, bypass, effort], `${text} after "${last.slice(0, 24)}"`)
  }
})

test('effort guard: a thinking mode that rejects a per-message effort change leaves the effort alone (D)', () => {
  assert.equal(thinkingRisk({}, {}), false)
  assert.equal(thinkingRisk({ MAX_THINKING_TOKENS: '0' }, {}), true)
  assert.equal(thinkingRisk({}, { alwaysThinkingEnabled: false }), true)
  assert.equal(thinkingRisk({}, { thinking: { type: 'disabled' } }), true)
  assert.equal(thinkingRisk({}, { thinking: { mode: 'between_tools' } }), true)
  assert.equal(thinkingRisk({}, { thinking: { type: 'adaptive' } }), false)
  assert.equal(thinkingRisk({ MAX_THINKING_TOKENS: '0', AUTOMODE_THINKING_GUARD: 'off' }, {}), false, 'the override wins')
  assert.equal(thinkingRisk({ AUTOMODE_THINKING_GUARD: 'on' }, {}), true)
  const base = { model: 'claude-opus-5-5', appEffort: 'medium', routeEffort: 'high', owner: 'judge', effortShared: true, cacheEffort: null, resetPending: true, warm: false }
  assert.deepEqual(effortFor(base), { sent: 'high', applied: true, why: 'effort shares the cache' })
  const off = effortFor({ ...base, off: 'effort changes are off: test' })
  assert.deepEqual([off.sent, off.applied, off.why], ['medium', false, 'effort changes are off: test'])
  assert.equal(effortFor({ ...base, owner: 'user-override', off: 'x' }).sent, 'medium', 'even a command cannot send a rejected change')
})

test('provider errors: each class has one bounded action (E)', () => {
  const k = (w, d) => classifyError(w, d)
  assert.equal(k('cancel').kind, 'ignore')
  assert.equal(k('aborted').kind, 'ignore')
  assert.equal(k('max_output_tokens').kind, 'ignore')
  for (const w of ['authentication_failed', 'billing_error', 'account_on_hold', 'cloud_credential_error']) assert.equal(k(w).kind, 'notify', w)
  assert.deepEqual([k('rate_limit').threshold, k('rate_limit').cooldownMs], [3, 120_000])
  assert.deepEqual([k('overloaded').threshold, k('server_error').cooldownMs], [3, 120_000])
  assert.deepEqual([k('model_not_found').threshold, k('model_not_found').cooldownMs], [1, 1_800_000])
  assert.equal(k('invalid_request', 'messages.3.output_config: Extra inputs are not permitted').kind, 'effort-unsupported')
  assert.equal(k('invalid_request', 'prompt is too long: 250000 tokens').kind, 'context')
  assert.deepEqual([UNCLASSIFIED.threshold, UNCLASSIFIED.cooldownMs], [3, 300_000])
  assert.equal(k('something_new').kind, 'breaker')
  assert.equal(sanitizeDetail('x'.repeat(200) + '<script>').length, 80)
  assert.equal(sanitizeDetail('a<b>c; d'), 'a b c d')
})

test('risk: topic words alone do not raise risk; paths, phrases and the judge do', () => {
  assert.equal(prospectiveRisk('add a token counter to the usage report', null).level, 'none')
  assert.equal(prospectiveRisk('pin the OAuth scopes in internal/auth/scopes.go', null).level, 'critical')
  assert.equal(prospectiveRisk('write a data migration for the users table', null).level, 'critical')
  assert.equal(prospectiveRisk('rename a helper', { risk: 'critical', why: 'touches credentials' }).level, 'critical')
  assert.deepEqual(pathsIn('see src/setup/plugins.go and docs/x.md'), ['src/setup/plugins.go', 'docs/x.md'])
  const obs = observedRisk({ editedPaths: ['db/migrations/0004.sql'], changedFiles: 1, changedLines: 20, verification: 'pass' })
  assert.equal(obs.level, 'critical')
  // A passing test does not clear a critical review requirement.
  assert.ok(reviewNeeded({ level: 'none', reasons: [], source: 'rules' }, obs, 'pass', false).length > 0)
  assert.deepEqual(reviewNeeded({ level: 'none', reasons: [], source: 'rules' }, null, 'pass', false), [])
})

test('authority: a hold keeps the model but not the effort (D3)', () => {
  const opusXhigh = { ...routeFor('T3'), effort: 'xhigh' }
  const warm = (o = {}) => ({ cache: cache({ model: opusXhigh.model, effort: 'xhigh', prefixTokens: 500_000, ...o }), now: 2_000, votes: 1, requestsSinceSwitch: 9, verifiedSinceSwitch: true, sameTask: true, risk: 'critical', expectedOutputTokens: 2_000, prices: ANTHROPIC })
  // "commit and push mr rebase" on a warm Opus xhigh session: the cache policy holds the model (critical risk
  // blocks a downgrade), and the effort follows the prompt.
  const held = resolve({ floor: noFloor, candidate: cand('T1'), effortHint: 'medium', heldEffort: 'low', current: opusXhigh, switchInput: warm() })
  assert.equal(held.owner, 'cache-policy')
  assert.equal(held.model, opusXhigh.model)
  assert.equal(held.effort, 'low')
  assert.equal(held.check.gate, 'quality')
  // Without a held effort (an older caller) the whole route is kept, as before.
  assert.equal(resolve({ floor: noFloor, candidate: cand('T1'), effortHint: 'medium', current: opusXhigh, switchInput: warm() }).effort, 'xhigh')
  // Where the provider splits the cache by effort, a warm effort is kept until a low-penalty point.
  const split = resolve({ floor: noFloor, candidate: { ...cand('T3'), tier: 'T3' }, effortHint: 'low', heldEffort: 'low', current: opusXhigh, switchInput: warm({ effortSharesCache: false }) })
  assert.equal(split.effort, 'xhigh')
  assert.equal(split.check.gate, 'provider-effort')
  // A floor lifts the route as before; the held effort never applies to a mandatory switch.
  const lifted = resolve({ floor: { tier: 'T4', because: ['repeated failure'] }, candidate: cand('T1'), effortHint: 'low', heldEffort: 'low', current: routeFor('T3'), switchInput: warm() })
  assert.equal(lifted.effort, 'max')
  // A user override is final and ignores the held effort.
  assert.equal(resolve({ override: { tier: 'T3', effort: 'high', reason: 'am:high' }, floor: noFloor, candidate: cand('T1'), heldEffort: 'low', current: opusXhigh, switchInput: warm() }).effort, 'high')
})

test('switch check: v4.1 prices each configuration as it will run (C)', () => {
  const cur = { ...routeFor('T3') } // Opus high
  const target = routeFor('T1')     // Sonnet medium
  const check = (extra) => switchCheck({ ...base({ cache: cache({ model: cur.model, effort: 'high', prefixTokens: 100_000 }), votes: 2, requestsSinceSwitch: 9, verifiedSinceSwitch: true, sameTask: true, expectedOutputTokens: 900 }), current: cur, candidate: cand('T1', 0.95), target, floor: noFloor, mandatory: false, ...extra })
  const lean = check({ targetOutputTokens: 400, targetStepRatio: 1 }).economics.savingUsd.p25
  const heavy = check({ targetOutputTokens: 1200, targetStepRatio: 1.3 }).economics.savingUsd.p25
  assert.ok(lean > heavy, `a target that thinks less saves more than one that thinks more: ${lean} vs ${heavy}`)
  // The same model price, but a target that needs 30% more steps can turn a saving into a loss.
  assert.ok(check({ targetOutputTokens: 900, targetStepRatio: 3 }).economics.savingUsd.p25 < 0)
  // Without the effort inputs the check is the legacy model-price comparison.
  assert.equal(check({}).economics.savingUsd.p25, check({ targetOutputTokens: undefined }).economics.savingUsd.p25)
})

test('policy: low-switch-penalty points', () => {
  assert.equal(lowPenaltyPoint(cache({ lastRequestAt: null }), 5, false), true)
  assert.equal(lowPenaltyPoint(cache(), 2_000, true), true, 'after compaction or clear')
  assert.equal(lowPenaltyPoint(cache(), 1_000 + HOUR + 1, false), true, 'cold cache')
  assert.equal(lowPenaltyPoint(cache(), 2_000, false), false)
  assert.equal(switchCostUsd(cache(), null, routeFor('T3'), ANTHROPIC, false), 0, 'no warm prefix, no switch cost')
})

test('policy: switch check gates', () => {
  const sonnet = routeFor('T1'); const opus = routeFor('T3'); const haiku = routeFor('T0')
  const check = (o) => switchCheck({ ...base(), current: sonnet, candidate: cand('T3'), target: opus, floor: noFloor, mandatory: false, ...o })
  assert.equal(check({}).verdict, 'hold', 'non-mandatory upgrade in a warm, big session waits for votes')
  assert.equal(check({}).gate, 'votes')
  assert.equal(check({ votes: 2 }).verdict, 'switch')
  assert.equal(check({ mandatory: true }).verdict, 'switch', 'a mandatory floor is never blocked')
  assert.ok(check({ mandatory: true }).estUsd > 0, 'its cost is recorded')
  const down = (o) => switchCheck({ ...base(), current: opus, candidate: cand('T0', 0.95), target: haiku, floor: noFloor, mandatory: false, ...o })
  assert.equal(down({}).verdict, 'switch', 'Opus to Haiku at 60k pays back: Haiku cache writes cost almost nothing')
  const toSonnet = switchCheck({ ...base(), current: opus, candidate: cand('T1', 0.95), target: sonnet, floor: noFloor, mandatory: false })
  assert.equal(toSonnet.gate, 'payback', 'Opus to Sonnet at 60k: the Sonnet cache write does not pay back in R=10 requests')
  assert.equal(down({ risk: 'elevated' }).gate, 'quality')
  assert.equal(down({ candidate: cand('T0', 0.6) }).gate, 'quality')
  assert.equal(down({ sameTask: true, requestsSinceSwitch: 3 }).gate, 'dwell')
  assert.equal(down({ cache: cache({ prefixTokens: 120_000 }), now: 2_000 + 2 * HOUR }).gate, 'context', 'Haiku above 80k does not fit')
  assert.equal(down({ cache: cache({ prefixTokens: 10_000 }) }).verdict, 'switch', 'small context costs little to move')
  // Retrospective replay (bench/retro-replay.mts, 2026-10-26): in one real session, escalations to Opus after
  // repeated failing checks were held on Sonnet at 810k-949k tokens by the 20% context reserve. Opus has the same 1M
  // window as the Sonnet route that already holds that context, so the reserve must not block the move.
  const big = cache({ prefixTokens: 900_000 })
  assert.equal(check({ mandatory: true, cache: big }).verdict, 'switch', 'a same-window escalation is not blocked by the reserve')
  assert.equal(check({ votes: 2, cache: big }).verdict, 'switch', 'nor is a confirmed upgrade')
  assert.equal(switchCheck({ ...base({ cache: big }), current: null, candidate: cand('T3'), target: opus, floor: noFloor, mandatory: false }).gate, 'context', 'a first route past the reserve still holds')
  assert.equal(down({ mandatory: true, cache: cache({ prefixTokens: 120_000 }) }).gate, 'context', 'Haiku past its own limit never fits')
  // The payback quantile stays p25 by default. The replay (2026-10-26) priced looser quantiles: they gained only with
  // a perfect judge and lost money with a cautious one (more switching back and forth), so the default is unchanged.
  assert.equal(toSonnet.reason, switchCheck({ ...base(), current: opus, candidate: cand('T1', 0.95), target: sonnet, floor: noFloor, mandatory: false, params: { ...DEFAULT_PARAMS, paybackQuantile: 'p25' } }).reason)
  const p75 = switchCheck({ ...base(), current: opus, candidate: cand('T1', 0.95), target: sonnet, floor: noFloor, mandatory: false, params: { ...DEFAULT_PARAMS, paybackQuantile: 'p75' } })
  assert.ok(p75.verdict === 'switch' || /^p75 saving/.test(p75.reason), 'a looser quantile is used, and named when it holds')
  assert.ok(/^p25 saving/.test(toSonnet.reason), 'the default names p25')
  // Effort-only change: free on Anthropic, held on Vertex until a low-penalty point.
  const effort = (shares) => switchCheck({ ...base({ cache: cache({ effortSharesCache: shares }) }), current: sonnet, candidate: cand('T2'), target: { ...sonnet, tier: 'T2', effort: 'high' }, floor: noFloor, mandatory: false })
  assert.equal(effort(true).verdict, 'switch')
  assert.equal(effort(false).gate, 'provider-effort')
})

test('authority: generate then constrain, with owners', () => {
  const sw = base()
  const r1 = resolve({ floor: noFloor, candidate: cand('T1'), current: null, switchInput: sw })
  assert.equal(r1.owner, 'judge'); assert.equal(r1.model, 'claude-sonnet-5-5')
  // The cache policy never blocks the judge at a low-penalty point.
  const r2 = resolve({ floor: noFloor, candidate: cand('T0'), current: routeFor('T3'), switchInput: base({ cache: cache({ lastRequestAt: null }) }) })
  assert.equal(r2.tier, 'T0')
  // A warm downgrade that fails a gate holds, owned by the cache policy, with the judge recorded as overridden.
  const r3 = resolve({ floor: noFloor, candidate: cand('T1', 0.95), current: routeFor('T3'), switchInput: sw })
  assert.equal(r3.owner, 'cache-policy'); assert.equal(r3.tier, 'T3'); assert.ok(r3.overridden.some((o) => o.owner === 'judge'))
  // A quality floor lifts the candidate and switches even when warm.
  const r4 = resolve({ floor: { tier: 'T3', because: ['same failing check twice'] }, candidate: cand('T1'), current: routeFor('T1'), switchInput: sw })
  assert.equal(r4.tier, 'T3'); assert.equal(r4.owner, 'quality-escalation')
  // A user override wins, and a floor above it stays visible as a pending requirement.
  const r5 = resolve({ override: { tier: 'T1', reason: 'am:sonnet' }, floor: { tier: 'T3', because: ['critical'] }, candidate: cand('T3'), current: null, switchInput: sw })
  assert.equal(r5.owner, 'user-override'); assert.equal(r5.tier, 'T1'); assert.ok(r5.overridden[0].reason.includes('pending'))
  // A pinned workflow role is final.
  assert.equal(resolve({ workflowRole: { tier: 'T3', reason: 'architect' }, floor: noFloor, candidate: cand('T0'), current: null, switchInput: sw }).owner, 'workflow-role')
})

test('failures: classes on captured outputs', () => {
  const dir = path.join(here, 'fixtures', 'failures')
  for (const f of fs.readdirSync(dir)) {
    const want = f.split('.')[0]
    assert.equal(classify(normalize(fs.readFileSync(path.join(dir, f), 'utf8'))), want, f)
  }
  assert.equal(normalize('ok (0.31s) at /private/var/folders/x/y:12:3'), 'ok (<t>) at <tmp>:<n>')
  assert.ok(isCheck('go test ./...') && isCheck('npm run lint') && !isCheck('ls -la'))
})

test('failures: escalation paths', () => {
  const out = fs.readFileSync(path.join(here, 'fixtures', 'failures', 'defect.go-test.txt'), 'utf8')
  const f1 = failureOf('go test ./...', 1, out, 1, false)
  const f2 = failureOf('go test ./...', 1, out.replace('1.460s', '0.912s'), 2, true)
  assert.equal(f1.fingerprint, f2.fingerprint, 'timings do not change the fingerprint')
  assert.equal(escalation([f1], 'T1').action, 'none')
  const e = escalation([f1, f2], 'T1')
  assert.equal(e.action, 'raise'); assert.equal(e.floor, 'T2')
  assert.equal(escalation([f1, f2], 'T2').floor, 'T3')
  assert.equal(escalation([f1, f2], 'T3').floor, 'T4')
  const env = failureOf('golangci-lint run', 127, 'bash: golangci-lint: command not found', 3, false)
  assert.equal(escalation([env], 'T1').action, 'report', 'environment failures report first')
  assert.equal(escalation([env, { ...env, at: 4 }, { ...env, at: 5 }], 'T1').action, 'diagnose', 'but repeats get a diagnosis')
  const sys = failureOf('go test ./integration/...', 1, 'dial tcp 10.0.0.4:443: i/o timeout\nENOTFOUND', 6, false)
  assert.equal(escalation([sys], 'T1').action, 'diagnose', 'systemic-looking environment failures are diagnosed, not ignored')
  assert.equal(markFlaky([f1], 'go test ./...', true, false)[0].class, 'flaky')
  assert.equal(failureOf('go test', 0, '', 1, false), null)
})

test('guard: read-only roles cannot write, directly or indirectly', () => {
  for (const ok of ['git diff HEAD~1', 'git log --oneline -5', 'grep -rn foo internal', 'go test ./...', 'npm test', 'cat a.go | head -50', 'git status && go vet ./...'])
    assert.equal(guardBash(ok).allow, true, ok)
  for (const bad of ['echo x > a.go', 'cat a >> b', 'go test ./... | tee out.txt', "sed -i 's/a/b/' x.go", 'rm -f x', 'mv a b', 'git commit -m x', 'git checkout -- .',
    'git stash', 'npm install lodash', 'go get foo', 'curl -o x https://e', 'wget https://e', 'python -c "open(1,2)"', 'node -e "require(1)"', 'bash -c "rm x"',
    'echo $(rm x)', 'ls; rm x', 'ls || rm x', 'xargs rm', 'go test -update ./...', 'make install', 'touch a', 'PATH=/tmp git diff'])
    assert.equal(guardBash(bad).allow, false, bad)
  assert.equal(guardTool('Edit', {}).allow, false)
  assert.equal(guardTool('mcp__tracker__create_issue', {}).allow, false)
  assert.equal(guardTool('Read', {}).allow, true)
})

test('envelope: survives follow-ups, injects deltas only, keeps the full spec', () => {
  const long = `Implement the importer.\n- must keep the CSV header order\n- should skip blank rows\n${'x'.repeat(3000)}`
  let env = newEnvelope('t1', 'p1', long, 1, 'standard', prospectiveRisk(long, null))
  assert.equal(env.spec.text, long, 'the authoritative spec is never truncated')
  assert.deepEqual(env.acceptance.map((a) => a.source), ['user', 'user'])
  const first = injection(env, 'new-task', '')
  assert.ok(first.startsWith('[AutoMode task state]') && first.length < 1400)
  env = { ...env, injectedRevision: env.revision }
  assert.equal(injection(env, 'none', summaryOf(env)), null, 'nothing changed, nothing injected')
  const before = summaryOf(env)
  env = observe(env, { level: 'critical', reasons: ['auth or credentials code: internal/auth/x.go'], source: 'diff' })
  env = withReview(env, 'pass', false)
  assert.equal(env.reviewRequired.value, true)
  const delta = injection(env, 'none', before)
  assert.ok(delta.startsWith('[AutoMode task update]') && delta.includes('Independent review required'))
  assert.equal(isBoundary({ explicitNew: false, cleared: false, judgeNewTask: true, judgeConfidence: 0.9, followUp: true, envelope: env }), false)
  assert.equal(isBoundary({ explicitNew: false, cleared: false, judgeNewTask: true, judgeConfidence: 0.9, followUp: false, envelope: env }), true)
  assert.equal(isBoundary({ explicitNew: false, cleared: false, judgeNewTask: true, judgeConfidence: 0.5, followUp: false, envelope: env }), false)
  assert.deepEqual(acceptanceFrom('hello there'), [])
})

test('strategy: quality first, isolation only with a clear margin, every value labeled', () => {
  const input = (o = {}) => ({ hint: null, risk: 'none', designDecision: false, main: 'opus', worker: 'haiku', cache: cache({ prefixTokens: 150_000 }), work: workFromFiles(Array(40).fill(12_000), 400), outputTokens: 1_500, prices: ANTHROPIC, ...o })
  const big = choose(input(), 0.8)
  assert.equal(big.chosen, 'isolated-worker', '40 files from a big Opus session go to a Haiku worker')
  assert.equal(big.basis, 'estimate')
  assert.equal(choose(input({ risk: 'critical' }), 0.9).chosen, 'direct')
  assert.equal(choose(input(), 0.4).chosen, 'direct')
  const small = choose(input({ main: 'sonnet', cache: cache({ prefixTokens: 20_000 }), work: workFromFiles([2_000], 100) }), 0.9)
  assert.equal(small.chosen, 'direct', 'a one-file lookup stays direct')
  assert.ok(estimate(input()).every((e) => e.assumptions.some((a) => a.startsWith('work'))))
})

test('workers: bounded reads, validation, edit-aware advisory reuse', () => {
  assert.equal(clampRead({ file_path: 'a' }, HAIKU_BUDGET).limit, 800)
  assert.equal(clampRead({ file_path: 'a', limit: 100 }, HAIKU_BUDGET), null)
  assert.equal(validateReport('{"findings":[],"relevant_files":[],"omitted":[],"complete":true}', 'discovery').status, 'ok')
  assert.equal(validateReport('{"findings":[],"relevant_files":[],"omitted":["x.go: too big"]}', 'discovery').status, 'partial')
  assert.equal(validateReport('nope', 'discovery').status, 'invalid')
  const d = { scope: 'src/setup', paths: ['src/setup/a.go', 'src/setup/b.go'], complete: true, omitted: [], head: null, hashes: {}, at: 10 }
  assert.deepEqual(priorCoverage([d], []).paths, ['src/setup/a.go', 'src/setup/b.go'])
  assert.match(priorCoverage([d], []).note, /already covered/)
  assert.equal(priorCoverage([d], [{ path: 'src/setup/a.go', at: 5 }]).paths.length, 2, 'an edit before the discovery keeps it valid')
  assert.equal(priorCoverage([d], [{ path: 'src/setup/a.go', at: 20 }]).note, null, 'an edit after the discovery invalidates it')
  assert.equal(priorCoverage([{ ...d, complete: false }], []).note, null, 'a partial discovery is not offered')
})

test('mode and provider', () => {
  assert.equal(modeOf({}, {}), 'shadow', 'shadow is the default')
  assert.equal(modeOf({ mode: 'auto' }, { AUTOMODE_ROUTER: 'off' }), 'off', 'the kill switch wins')
  assert.equal(modeOf({ mode: 'off' }, { AUTOMODE_ROUTER: 'auto' }), 'off')
  const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'))
  assert.equal(modeOf(shipped, {}), 'auto', 'the plugin ships in auto mode')
  assert.equal(modeOf(shipped, { AUTOMODE_ROUTER: 'off' }), 'off', 'AUTOMODE_ROUTER=off rolls the shipped default back')
  assert.equal(providerOf({ CLAUDE_CODE_USE_VERTEX: '1' }), 'vertex')
  assert.equal(providerOf({ CLAUDE_CODE_USE_VERTEX: '0' }), 'anthropic')
  assert.equal(effortSharesCache({}, 'claude-sonnet-5-5'), true)
  assert.equal(effortSharesCache({ CLAUDE_CODE_USE_VERTEX: '1' }, 'claude-sonnet-5-5'), false)
  assert.equal(effortSharesCache({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1' }, 'claude-sonnet-5-5'), false)
  assert.equal(ttlMs({}, 'anthropic', true), HOUR)
  assert.equal(ttlMs({}, 'vertex', true), 300_000)
})

test('records: the next prompt as a satisfaction signal', () => {
  assert.equal(nextSignal('no, that is wrong'), 'corrected')
  assert.equal(nextSignal('it still fails'), 'corrected')
  assert.equal(nextSignal('try again'), 'retried')
  assert.equal(nextSignal('now add docs'), 'moved-on')
})

// ---------------------------------------------------------------- V4 engine: optimizer, effort, consult

import { optimize, demandOf, tierOf, candidates, adequacy, acceptable, remainingWork, FLOOR_CAPABILITY, attemptCost, CAPABILITY } from '../hooks/lib/optimizer.ts'
import { effortFor, isFollowUp, endsOnQuestion, keepsRoute, looksLikeRedo, helperEffort, thinkingOf } from '../hooks/lib/effort.ts'
import { consultOrSwitch } from '../hooks/lib/strategy.ts'

const coldCache = (prefix) => ({ model: null, effort: null, prefixTokens: prefix, lastRequestAt: null, ttlMs: HOUR, effortSharesCache: true })
const golden = JSON.parse(fs.readFileSync(path.join(here, 'golden', 'decisions.json'), 'utf8'))

test('optimizer: 15 candidates in coarse adequacy bands, conservative on low confidence and critical work', () => {
  assert.equal(candidates().length, 15)
  assert.equal(adequacy({ lo: 3, hi: 3.4 }, 3), 'sufficient')
  assert.equal(adequacy({ lo: 2.8, hi: 3.4 }, 3), 'likely')
  assert.equal(adequacy({ lo: 2.6, hi: 3.2 }, 3), 'uncertain')
  assert.equal(adequacy({ lo: 2, hi: 2.5 }, 3), 'insufficient')
  const d = demandOf({ tier: 'T2', complexity: 'standard', risk: 'none' })
  assert.deepEqual(acceptable(d), ['sufficient', 'likely'])
  assert.deepEqual(acceptable({ ...d, confidence: 0.5 }), ['sufficient'])
  assert.deepEqual(acceptable({ ...d, consequence: 'critical' }), ['sufficient'])
  assert.ok(CAPABILITY.sonnet.max.lo < CAPABILITY.opus.high.lo, 'Sonnet max is not assumed equal to Opus high')
})

test('demand: consequence sets verification, never the implementer by itself', () => {
  assert.equal(demandOf({ tier: 'T1', complexity: 'standard', risk: 'critical' }).verification, 'review')
  assert.equal(demandOf({ tier: 'T1', complexity: 'standard', risk: 'none' }).verification, 'checks')
  assert.equal(demandOf({ tier: 'T0', complexity: 'trivial', risk: 'none' }).verification, 'none')
  const plain = demandOf({ tier: 'T2', complexity: 'standard', risk: 'none' })
  const critical = demandOf({ tier: 'T2', complexity: 'standard', risk: 'critical' })
  assert.equal(critical.difficulty, plain.difficulty)
  assert.equal(demandOf({ tier: 'T3', complexity: 'complex', effort: 'high', risk: 'none' }).difficulty, demandOf({ tier: 'T3', complexity: 'complex', effort: 'low', risk: 'none' }).difficulty, 'the judge effort hint is not a difficulty signal')
})

test('remaining work: heavy-tailed residual quantiles, never one mean', () => {
  assert.deepEqual([remainingWork(0).median, remainingWork(8).median, remainingWork(40).median], [6, 18, 45])
  assert.equal(remainingWork(3).k, 2, 'the nearest lower row')
  assert.ok(remainingWork(0).p25 < remainingWork(0).median)
})

for (const g of golden.optimizer) {
  test(`golden optimizer: ${g.name}`, () => {
    const d = demandOf(g.verdict, false, g.failures ?? 0)
    const x = { cache: coldCache(g.prefix), warm: {}, now: 0, prices: ANTHROPIC }
    const c = optimize(d, x, { minCap: g.floor ? FLOOR_CAPABILITY[g.floor] : 0 })
    if (g.expect) assert.equal(`${c.best.family}/${c.best.effort}`, g.expect)
    if (g.expectFamily) assert.equal(c.best.family, g.expectFamily)
    if (g.verification) assert.equal(d.verification, g.verification)
    assert.ok(c.best.feasible || c.ranked.every((r) => !r.feasible))
    assert.ok(c.best.expectedUsdRange.lo <= c.best.expectedUsd && c.best.expectedUsd <= c.best.expectedUsdRange.hi, 'the expected cost sits inside its range')
    // Determinism: the same input gives the same output.
    assert.deepEqual(optimize(d, x, { minCap: g.floor ? FLOOR_CAPABILITY[g.floor] : 0 }), c)
  })
}

const routeOf = (tier) => routeFor(tier)
for (const g of golden.switch) {
  test(`golden switch: ${g.name}`, () => {
    const cur = routeOf(g.current)
    const tgt = routeOf(g.target)
    const r = switchCheck({
      ...base({ cache: cache({ model: cur.model, effort: cur.effort, prefixTokens: g.prefix, lastRequestAt: g.warm ? 1_000 : -10 * HOUR, effortSharesCache: g.effortShared ?? true }), votes: g.votes, sameTask: !!g.sameTask }),
      ...(g.dwelt ? { requestsSinceSwitch: 20, verifiedSinceSwitch: true } : {}),
      ...(g.provider ? { provider: g.provider } : {}),
      ...(g.targetWarmPrefix ? { targetWarm: true, targetWarmPrefix: g.targetWarmPrefix } : {}),
      ...(g.dropped ? { dropped: g.dropped } : {}),
      ...(g.reset ? { compacted: true, resetPrefixTokens: g.reset } : {}),
      current: cur, candidate: cand(g.target, 0.95), target: tgt, floor: noFloor, mandatory: !!g.mandatory,
    }, !!g.reset)
    assert.equal(r.verdict, g.expect)
    if (g.gate) assert.equal(r.gate, g.gate)
    if (g.continuity) assert.equal(r.continuity, g.continuity)
    if (g.expectUsd !== undefined) assert.ok(Math.abs(r.estUsd - g.expectUsd) < 1e-4, `priced ${r.estUsd}`)
  })
}

test('optimizer: a warm model is cheaper to stay on than a cold one', () => {
  const d = demandOf({ tier: 'T1', complexity: 'standard', effort: 'medium', risk: 'none' })
  const c = { family: 'sonnet', effort: 'medium', cap: 2.9 }
  const x = { cache: { ...coldCache(80_000) }, now: 0, prices: ANTHROPIC }
  const cold = attemptCost(c, d, { ...x, warm: {} })
  const warm = attemptCost(c, d, { ...x, warm: { sonnet: { effort: 'medium', until: 10, prefixTokens: 80_000 } } })
  assert.ok(warm.usd < cold.usd)
  assert.equal(warm.switchUsd, 0)
  assert.ok(cold.switchUsd > 0)
})

test('optimizer: tierOf names Sonnet effort bands and Opus max', () => {
  assert.equal(tierOf('haiku', 'max'), 'T0')
  assert.equal(tierOf('sonnet', 'medium'), 'T1')
  assert.equal(tierOf('sonnet', 'xhigh'), 'T2')
  assert.equal(tierOf('opus', 'xhigh'), 'T3')
  assert.equal(tierOf('opus', 'max'), 'T4')
})

test('effort: sent for every 5.5 model, provider rule on a warm cache', () => {
  const i = { model: 'claude-haiku-5-5', appEffort: undefined, routeEffort: 'low', owner: 'judge', effortShared: true, cacheEffort: null, resetPending: false, warm: false }
  assert.deepEqual(effortFor(i).sent, 'low', 'Haiku 5.5 takes effort even when the app names none')
  assert.equal(effortFor({ ...i, model: 'claude-3-5-haiku' }).applied, false, 'an older model is left alone')
  const vertex = { ...i, model: 'claude-sonnet-5-5', appEffort: 'medium', routeEffort: 'high', effortShared: false, cacheEffort: 'medium', warm: true }
  assert.equal(effortFor(vertex).sent, 'medium', 'Vertex keeps the warm effort')
  assert.equal(effortFor({ ...vertex, owner: 'quality-escalation' }).sent, 'high', 'a quality floor overrides the provider rule')
  assert.equal(effortFor({ ...vertex, resetPending: true }).sent, 'high', 'a low-penalty point allows the change')
})

test('effort: effortless follow-up, question and redo rules', () => {
  assert.equal(isFollowUp('go'), true)
  assert.equal(isFollowUp('go ahead now please'), false)
  assert.equal(endsOnQuestion('Done. Should I also archive it?'), true)
  assert.equal(keepsRoute('yes', 'Should I delete the old files?', FOLLOW_UP), false, 'an answer to a question is judged')
  assert.equal(keepsRoute('continue', 'Step 2 done.', FOLLOW_UP), true)
  assert.equal(looksLikeRedo("that's wrong"), true)
  assert.equal(looksLikeRedo('no problem, thanks'), false)
  assert.equal(looksLikeRedo('it still fails'), false, 'only the effortless phrase set counts')
  assert.equal(looksLikeRedo("it still doesn't work"), true)
  assert.equal(helperEffort(undefined, 'low'), 'medium', 'helpers never run below medium')
  assert.equal(helperEffort('high', 'low'), 'high')
  assert.equal(thinkingOf({ output_tokens_details: { thinking_tokens: 258 } }), 258)
  assert.equal(thinkingOf({ output_tokens: 3 }), null)
})

test('consult or switch: a large warm Sonnet prefix favors an Opus consult; a tiny one favors the switch', () => {
  const at = (prefixTokens) => consultOrSwitch({ prefixTokens, remainingRequests: 10, outPerRequest: 650, packetTokens: 800, planTokens: 2000, main: 'sonnet', ttlMs: HOUR, prices: ANTHROPIC })
  assert.equal(at(150_000).choice, 'consult')
  assert.equal(at(2_000).choice, 'switch')
  assert.ok(at(150_000).consultUsd < at(150_000).switchUsd)
})

// ---------------------------------------------------------------- switch economics and triggers

import { remainingFor } from '../hooks/lib/policy.ts'
import { trigger } from '../hooks/lib/triggers.ts'

const opusHigh = routeFor('T3')
const sonnetMed = routeFor('T1')
const downgrade = (o = {}) => switchCheck({
  ...base({ cache: cache({ model: opusHigh.model, effort: 'high', prefixTokens: 60_000 }), votes: 1, sameTask: false }),
  current: opusHigh, candidate: cand('T1', 0.95), target: sonnetMed, floor: noFloor, mandatory: false, ...o,
})

test('economics: every check records penalty, remaining quantiles, savings and the reason', () => {
  const r = downgrade()
  assert.equal(r.verdict, 'hold')
  assert.equal(r.gate, 'payback')
  const e = r.economics
  assert.equal(e.current, `${opusHigh.model}/high`)
  assert.ok(e.writePenaltyUsd > 0)
  assert.deepEqual(Object.keys(e.remaining), ['k', 'p25', 'median', 'p75', 'n'])
  assert.ok(e.savingUsd.p25 <= e.savingUsd.median && e.savingUsd.median <= e.savingUsd.p75)
  assert.match(r.reason, /p25 saving/)
})

test('economics: a heavy-tailed outlier does not flip a downgrade; the p25 saving decides', () => {
  // A 200-request prompt in history raises the mean, not the p25 the check reads.
  const table = [{ k: 0, n: 100, p25: 2, median: 6, p75: 200 }]
  assert.equal(downgrade({ remainingTable: table }).verdict, 'hold')
})

test('economics: a long new task on a warm cache can pay back; a two-request task cannot', () => {
  const long = downgrade({ newTaskSteps: 400, cache: cache({ model: opusHigh.model, effort: 'high', prefixTokens: 25_000 }) })
  assert.equal(long.verdict, 'switch', JSON.stringify(long.economics))
  assert.equal(downgrade({ newTaskSteps: 2, cache: cache({ model: opusHigh.model, effort: 'high', prefixTokens: 25_000 }) }).verdict, 'hold')
})

test('economics: a 300k warm prefix holds the downgrade, and Haiku cannot take it', () => {
  assert.equal(downgrade({ cache: cache({ model: opusHigh.model, effort: 'high', prefixTokens: 300_000 }) }).verdict, 'hold')
  const toHaiku = switchCheck({ ...base({ cache: cache({ prefixTokens: 300_000 }) }), current: sonnetMed, candidate: cand('T0', 0.95), target: routeFor('T0'), floor: noFloor, mandatory: false })
  assert.equal(toHaiku.gate, 'context')
})

test('economics: a reset with no surviving prefix is a low point, and a task still needs dwell to leave it', () => {
  const at = (o) => switchCheck({ ...base({ cache: cache({ model: opusHigh.model, effort: 'high', prefixTokens: 60_000 }), sameTask: true }), current: opusHigh, candidate: cand('T1', 0.95), target: sonnetMed, floor: noFloor, mandatory: false, compacted: true, ...o }, true)
  assert.equal(at({}).gate, 'dwell')
  assert.equal(at({}).lowPenaltyPoint, true)
  const r = at({ requestsSinceSwitch: 20, verifiedSinceSwitch: true })
  assert.equal(r.verdict, 'switch')
  assert.equal(r.economics.writePenaltyUsd, 0, 'no surviving prefix is known, so no write difference is priced')
})

test('economics: a target whose own cache is still warm costs no rewrite', () => {
  assert.equal(downgrade({ targetWarm: true }).economics.writePenaltyUsd, 0)
})

test('economics: a warm target still writes the turns its cache lacks', () => {
  const r = downgrade({ cache: cache({ model: opusHigh.model, effort: 'high', prefixTokens: 100_000 }), targetWarm: true, targetWarmPrefix: 60_000 })
  // 60k read at $0.10, 40k written at the 1-hour $4, less the 100k Opus read at $0.20 the current route would pay.
  assert.ok(Math.abs(r.economics.writePenaltyUsd - (0.006 + 0.16 - 0.02)) < 1e-6)
  assert.equal(r.verdict, 'hold')
  assert.equal(r.gate, 'payback')
})

test('a hold that changes the effort records the tier of that effort', () => {
  const sonnetT1 = { ...routeFor('T1'), effort: 'medium' as const }
  const held = resolve({ floor: noFloor, candidate: cand('T3'), effortHint: 'high', heldEffort: 'high', current: sonnetT1, switchInput: base({ cache: cache({ model: sonnetT1.model, effort: 'medium', prefixTokens: 500_000 }), votes: 1, sameTask: true }) })
  assert.equal(held.owner, 'cache-policy')
  assert.equal(held.effort, 'high')
  assert.equal(held.tier, 'T2')
})

test('anti-oscillation caps discretionary switches; mandatory escalation and user overrides bypass it', () => {
  const capped = switchCheck({ ...base({ votes: 2 }), current: sonnetMed, candidate: cand('T3'), target: opusHigh, floor: noFloor, mandatory: false, switchesThisTask: 3 })
  assert.equal(capped.gate, 'oscillation')
  const mandatory = switchCheck({ ...base({ votes: 1 }), current: sonnetMed, candidate: cand('T3'), target: opusHigh, floor: { tier: 'T3', because: ['repeat'] }, mandatory: true, switchesThisTask: 9 })
  assert.equal(mandatory.verdict, 'switch')
  const user = resolve({ override: { tier: 'T3', reason: 'user: am:opus' }, floor: noFloor, candidate: cand('T1'), current: sonnetMed, switchInput: { ...base(), switchesThisTask: 9 } })
  assert.equal(user.owner, 'user-override')
  assert.equal(user.family, 'opus')
})

test('remaining work: a task boundary uses the new task length; mid-prompt uses the residual table', () => {
  assert.deepEqual(remainingFor({ newTaskSteps: 6 }), { k: 0, n: 1369, p25: 2, median: 6, p75: 18 })
  assert.equal(remainingFor({ requestsInPrompt: 10 }).k, 8)
})

test('triggers: deterministic, no action on ordinary steps, mandatory only for context fit and repeated defects', () => {
  const s = { haikuMaxContext: 80_000, longContextAt: 100_000, scopeThreshold: 4, judgedThisStage: false, verifiedAfterPlan: false }
  assert.equal(trigger(s, { kind: 'check-pass', implementing: true }).action, 'reoptimize')
  assert.equal(trigger({ ...s, verifiedAfterPlan: true }, { kind: 'check-pass', implementing: true }).action, 'none')
  assert.equal(trigger(s, { kind: 'check-fail', repeated: false, defect: true }).action, 'none')
  assert.deepEqual(trigger(s, { kind: 'check-fail', repeated: true, defect: true }).mandatory, true)
  assert.deepEqual(trigger(s, { kind: 'context', prefixTokens: 90_000, family: 'haiku' }), { action: 'reoptimize', reason: "context 90000 past Haiku's limit", mandatory: true })
  assert.equal(trigger(s, { kind: 'context', prefixTokens: 900_000, family: 'sonnet' }).action, 'none')
  assert.equal(trigger(s, { kind: 'step-start', idleMs: 10, ttlMs: 300_000 }).action, 'none')
  assert.equal(trigger(s, { kind: 'step-start', idleMs: 400_000, ttlMs: 300_000 }).action, 'reoptimize')
  assert.equal(trigger(s, { kind: 'scope', outsidePaths: 4 }).action, 'judge')
  assert.equal(trigger({ ...s, judgedThisStage: true }, { kind: 'scope', outsidePaths: 9 }).action, 'none', 'the judge runs at most once per stage')
  assert.equal(trigger(s, { kind: 'compacted' }).action, 'reoptimize')
})

import { interfaceChanges, PRESERVING } from '../hooks/lib/risk.ts'

test('risk: intent lowers a path-only critical; phrases and the judge keep it; signals never pick the model', () => {
  assert.equal(prospectiveRisk('rename the auth.go helper to authutil.go without changing behavior', null).level, 'elevated')
  assert.equal(prospectiveRisk('fix the token refresh in auth.go', null).level, 'critical')
  assert.equal(prospectiveRisk('rename auth.go without changing behavior', { risk: 'critical', why: 'auth' }).level, 'critical', 'a judge signal keeps it')
  assert.equal(prospectiveRisk('there is a race condition in the cache refresh', null).level, 'critical')
  assert.equal(prospectiveRisk('change the public API of the setup package', null).level, 'critical')
  assert.ok(PRESERVING.test('pure rename of the helper'))
  // Consequence sets verification, not the implementer: a critical bounded task gets review and Sonnet high.
  const d = demandOf({ tier: 'T1', complexity: 'standard', risk: 'critical' })
  assert.equal(d.verification, 'review')
  const c = optimize(d, { cache: coldCache(20_000), warm: {}, now: 0, prices: ANTHROPIC, neutral: true }, { minCap: FLOOR_CAPABILITY.T2 })
  assert.equal(c.best.family, 'sonnet')
})

test('risk: exported interface changes from an edit, and observed risk rises on them', () => {
  assert.equal(interfaceChanges('func SelectPlugins() []Plugin {', 'func SelectPlugins() ([]Plugin, error) {'), 2)
  assert.equal(interfaceChanges('func selectPlugins() {', 'func selectPlugins(x int) {'), 0, 'unexported Go funcs do not count')
  assert.equal(interfaceChanges('export function a(x: number) {', 'export function a(x: number, y?: string) {'), 2)
  assert.equal(interfaceChanges('const x = 1', 'const x = 2'), 0)
  assert.equal(observedRisk({ editedPaths: ['src/setup/plugins.go'], changedFiles: 1, changedLines: 3, verification: 'none', interfacesChanged: 1 }).level, 'elevated')
})

import { stagesFor } from '../hooks/lib/stages.ts'

test('stages: chosen by demand; review by consequence; the person asking gets all', () => {
  const bounded = demandOf({ tier: 'T1', complexity: 'standard', risk: 'none' })
  assert.deepEqual(stagesFor(bounded), ['implement', 'verify'])
  const critical = demandOf({ tier: 'T2', complexity: 'standard', risk: 'critical' })
  assert.deepEqual(stagesFor(critical), ['implement', 'verify', 'review'])
  const design = demandOf({ tier: 'T3', complexity: 'complex', risk: 'none' })
  assert.deepEqual(stagesFor(design), ['discover', 'architect', 'implement', 'verify'])
  assert.equal(stagesFor(bounded, { userAsked: true }).length, 5)
})

import { JUDGE_SYSTEM_V3 } from '../hooks/lib/classify.ts'

test('judge v3: optional consequence and verification parse; v2 answers and recorded verdicts still parse', () => {
  const v2 = '{"tier":"T2","complexity":"standard","risk":"none","riskWhy":"","strategy":"direct","newTask":true,"effort":"high","confidence":0.8,"why":"x"}'
  assert.equal(parseJudge(v2).consequence, undefined)
  const v3 = parseJudge(v2.replace('"why":"x"', '"why":"x","consequence":"critical","verification":"review"'))
  assert.equal(v3.consequence, 'critical')
  assert.equal(v3.verification, 'review')
  assert.equal(parseJudge(v2.replace('"why":"x"', '"why":"x","consequence":"huge"')).consequence, undefined, 'a bad v3 value is dropped, not trusted')
  assert.match(JUDGE_SYSTEM_V3, /consequence adds review, the tier is how hard the work is/)
})

test('reuse: revision-aware: a covered file whose content hash changed drops the record, edits or not', () => {
  const d = { scope: 's', paths: ['a.go', 'b.go'], complete: true, omitted: [], head: null, hashes: { 'a.go': 'h1', 'b.go': 'h2' }, at: 10 }
  assert.equal(priorCoverage([d], [], { 'a.go': 'h1', 'b.go': 'h2' }).paths.length, 2)
  assert.equal(priorCoverage([d], [], { 'a.go': 'CHANGED', 'b.go': 'h2' }).note, null, 'changed outside the session (checkout, another tool)')
  assert.equal(priorCoverage([d], [], {}).paths.length, 2, 'unreadable now: the edit log decides')
})

import { textConsequence, assess, intentOf } from '../hooks/lib/consequence.ts'

test('consequence: a domain needs a change to it; questions, messages and surface edits do not become critical', () => {
  assert.equal(textConsequence('Let support staff read customer invoices from the admin API.').level, 'critical')
  assert.equal(textConsequence('What does the mutex protect here?').level, 'none')
  assert.equal(textConsequence('Write a Slack message about the new login flow.').level, 'elevated')
  assert.equal(textConsequence('Fix the typo in the login page heading.').level, 'none')
  assert.equal(textConsequence('Move the auth helpers into a new file without changing behavior.').level, 'elevated')
  assert.equal(textConsequence('Production login loops after the deploy; find the cause.').level, 'critical')
  assert.equal(textConsequence('Log the full request, including phone numbers, for debugging.').level, 'critical')
  assert.equal(textConsequence('Rerun the analysis in parallel.').level, 'none', 'running work in parallel is not a concurrency change')
  assert.equal(textConsequence('Can we store the role in the cookie instead?').level, 'elevated', 'a proposal is a design decision, not yet a change')
  assert.equal(intentOf('Commit, push to origin and deploy to staging.'), 'operate')
  assert.equal(intentOf('Rotate the key and update every deployment that uses it.'), 'change')
})

test('consequence: the judge can raise but never lower; a failed judge floors at elevated and marks uncertain', () => {
  assert.equal(assess({ text: 'Fix the typo in the README.', judge: { risk: 'critical', confidence: 0.9 } }).level, 'critical')
  assert.equal(assess({ text: 'Let admins grant the editor role.', judge: { risk: 'none', confidence: 0.9 } }).level, 'critical')
  const failed = assess({ text: 'Fix the typo in the README.', judgeFailed: true })
  assert.equal(failed.level, 'elevated')
  assert.equal(failed.uncertain, true)
  assert.equal(assess({ text: 'Fix the typo in the README.', judge: { risk: 'none', confidence: 0.4 } }).uncertain, true, 'low confidence is uncertain')
  assert.equal(assess({ text: 'Rename a helper.', judge: { risk: 'none', confidence: 0.9 }, observedLevel: 'critical' }).level, 'critical', 'the diff layer raises')
})

import { subagentRoute } from '../hooks/lib/subagents.ts'

test('subagents: built-in general-purpose of an Opus session goes to Sonnet at the task effort; everything else keeps its model', () => {
  const hard = demandOf({ tier: 'T3', complexity: 'complex', risk: 'none' })
  assert.deepEqual(subagentRoute({ type: 'general-purpose', parentFamily: 'opus', demand: hard })?.model, 'sonnet')
  assert.equal(subagentRoute({ type: 'general-purpose', parentFamily: 'opus', demand: hard })?.effort, 'xhigh')
  assert.equal(subagentRoute({ type: 'general-purpose', parentFamily: 'opus', demand: demandOf({ tier: 'T1', complexity: 'standard', risk: 'none' }) })?.effort, 'medium')
  assert.equal(subagentRoute({ type: 'general-purpose', parentFamily: 'sonnet', demand: hard }), null)
  assert.equal(subagentRoute({ type: 'automode:reviewer', parentFamily: 'opus', demand: hard }), null)
  assert.equal(subagentRoute({ type: 'Plan', parentFamily: 'opus', demand: hard }), null)
  assert.equal(subagentRoute({ type: 'general-purpose', explicitModel: 'opus', parentFamily: 'opus', demand: hard }), null)
  assert.equal(subagentRoute({ type: 'Explore', parentFamily: 'opus', demand: null })?.model, 'haiku')
})

test('economics: compaction within the cache lifetime is a partial reset priced on the surviving prefix', () => {
  const warm = cache({ model: opusHigh.model, effort: 'high', prefixTokens: 75_000, lastRequestAt: 1_900 })
  const full = switchCheck({ ...base({ cache: warm, sameTask: false }), current: opusHigh, candidate: cand('T1', 0.95), target: sonnetMed, floor: noFloor, mandatory: false }, true)
  assert.equal(full.lowPenaltyPoint, true, 'without a measured surviving prefix the old rule applies')
  const partial = switchCheck({ ...base({ cache: warm, sameTask: false }), current: opusHigh, candidate: cand('T1', 0.95), target: sonnetMed, floor: noFloor, mandatory: false, resetPrefixTokens: 48_836 }, true)
  assert.equal(partial.lowPenaltyPoint, false)
  assert.equal(partial.economics.prefixTokens, 48_836)
  assert.ok(partial.economics.writePenaltyUsd > 0)
  const cold = switchCheck({ ...base({ cache: { ...warm, lastRequestAt: -10 * HOUR }, sameTask: false }), current: opusHigh, candidate: cand('T1', 0.95), target: sonnetMed, floor: noFloor, mandatory: false, resetPrefixTokens: 48_836 }, true)
  assert.equal(cold.lowPenaltyPoint, true, 'an expired cache is free whatever survived compaction')
})

import { failingTests } from '../hooks/lib/failures.ts'

test('failures: the same failing test is one fingerprint whatever values the assertion prints', () => {
  const a = failureOf('go test ./x', 1, '--- FAIL: TestPlanted (0.00s)\n    t.go:15: got 43, want 41\nFAIL', 1, true)
  const b = failureOf('go test ./x', 1, '--- FAIL: TestPlanted (0.01s)\n    t.go:15: got 44, want 41\nFAIL', 2, true)
  assert.equal(a.fingerprint, b.fingerprint)
  const c = failureOf('go test ./x', 1, '--- FAIL: TestOther (0.00s)\nFAIL', 3, true)
  assert.notEqual(a.fingerprint, c.fingerprint)
  assert.deepEqual(failingTests('FAILED tests/test_a.py::test_x - assert 1\nnot ok 2 - parses input\nerror TS2322: x'), ['TS2322', 'parses input', 'tests/test_a.py::test_x'])
})

import { withPipefail, checkPassed, exitReliable } from '../hooks/lib/failures.ts'

test('checks: piped checks get pipefail; exit codes decide when reliable; markers only when masked', () => {
  assert.equal(withPipefail('go test ./... 2>&1 | head -30'), 'set -o pipefail; go test ./... 2>&1 | head -30')
  assert.equal(withPipefail('go test ./...'), null, 'no pipe, nothing to fix')
  assert.equal(withPipefail('set -o pipefail; go test | tail'), null)
  assert.equal(withPipefail('go test ./... || true'), null, 'a masked command is left alone')
  assert.equal(withPipefail('make test || exit 1'), null, '|| is not a pipe')
  assert.equal(exitReliable('go test ./... | head'), false)
  // Reliable exit 0: a harmless FAIL in the output does not make it a failure.
  assert.equal(checkPassed('go test ./...', 0, false, 'TestFAILover ok\nlog: FAIL count 0\nok  \tpkg\t0.1s'), true)
  // Unreliable exit 0 with the runner's own failure lines: a failure.
  assert.equal(checkPassed('go test ./... | head', 0, false, '--- FAIL: TestX (0.00s)\nFAIL\tpkg\t0.1s'), false)
  assert.equal(checkPassed('npm test || true', 0, false, 'Tests:       2 failed, 5 passed'), false)
  assert.equal(checkPassed('go test ./... | head', 0, false, 'ok  \tpkg\t0.1s'), true)
  assert.equal(checkPassed('go test ./...', 0, true, ''), false, 'an error result is never a pass')
})

// ---------------------------------------------------------------- continuity, return pricing and the rent rule
const FAMILIES = ['haiku', 'sonnet', 'opus']
const PROVIDERS = ['anthropic', 'vertex', 'bedrock', 'foundry', 'gateway']
const modelOf = (f) => `claude-${f}-5-5`
const at = (family, effort) => ({ ...routeFor(family === 'haiku' ? 'T0' : family === 'sonnet' ? 'T1' : 'T3'), effort })
const moveCheck = (from, to, o = {}, reset = false) => switchCheck({
  ...base({ cache: cache({ model: from.model, effort: from.effort, prefixTokens: 60_000 }), votes: 2, requestsSinceSwitch: 20, verifiedSinceSwitch: true, sameTask: true }),
  current: from, candidate: cand(to.tier, 0.95), target: to, floor: noFloor, mandatory: false, ...o,
}, reset)

test('continuity: the whole matrix, from the preserved-thinking page', () => {
  const up = new Set(['haiku>sonnet', 'haiku>opus', 'sonnet>opus'])
  for (const p of PROVIDERS) for (const f of FAMILIES) for (const t of FAMILIES) {
    const reads = f === t || (up.has(`${f}>${t}`) && (p === 'anthropic' || p === 'vertex'))
    assert.equal(continuity(modelOf(f), modelOf(t), p), reads ? 'kept' : 'lost', `${f} to ${t} on ${p}`)
  }
})

test('continuity: a model outside the table is assumed lost, and provider spellings of a 5.5 id are read', () => {
  assert.equal(continuity('claude-sonnet-5', 'claude-opus-5-5', 'anthropic'), 'lost')
  assert.equal(continuity('claude-fable-5-1', 'claude-opus-5-5', 'anthropic'), 'lost')
  assert.equal(continuity('claude-sonnet-5-5[1m]', 'claude-opus-5-5', 'anthropic'), 'kept')
  assert.equal(continuity('us.anthropic.claude-haiku-5-5-v1:0', 'us.anthropic.claude-sonnet-5-5-v1:0', 'vertex'), 'kept')
})

test('dropped tokens: observed on arrival, summed across hops, and cleared for the family that ran', () => {
  assert.equal(observedDrop(107_535, 1_000, 87_729), 20_806)
  assert.equal(observedDrop(50_000, 500, 90_000), 0, 'growth alone is no drop')
  const once = noteDrop({}, 'sonnet', 19_806)
  assert.deepEqual(once, { haiku: 19_806, opus: 19_806 })
  assert.deepEqual(noteDrop(once, 'haiku', 1_000), { sonnet: 1_000, opus: 20_806 })
  assert.deepEqual(noteDrop({ opus: 5 }, 'opus', 0), {})
  assert.equal(addedSince(97_729, 107_535, 19_806), 10_000)
  assert.equal(addedSince(87_729, 107_535), 0)
})

test('return pricing: turns added after a thinking drop are written, not lost in the gap (audit: 107k held, 88k running)', () => {
  const k = cache({ prefixTokens: 97_729, ttlMs: HOUR })
  const priced = returnCostUsd(k, 107_535, 10_000, sonnetMed, opusHigh, ANTHROPIC, true)
  assert.ok(Math.abs(priced - (107_535 * 0.2 + 10_000 * 8 - 97_729 * 0.1) / 1e6) < 1e-9)
  const check = moveCheck(sonnetMed, opusHigh, { sameTask: false, cache: k, targetWarm: true, targetWarmPrefix: 107_535, dropped: { opus: 19_806 } })
  assert.ok(Math.abs(check.estUsd - priced) < 1e-9, 'the check derives the added turns from the recorded drop')
})

test('low points are priced as the signed write difference', () => {
  const cold = { now: 1_000 + 2 * HOUR }
  const down = moveCheck(opusHigh, sonnetMed, { ...cold, sameTask: false })
  assert.ok(Math.abs(down.estUsd - -0.24) < 1e-9, 'a cold downgrade writes for less than staying would')
  assert.ok(Math.abs(moveCheck(sonnetMed, opusHigh, { ...cold, sameTask: false }).estUsd - 0.24) < 1e-9, 'a cold upgrade writes for more')
  assert.equal(down.economics.writePenaltyUsd, -0.24)
  assert.ok(lowPointUsd(60_000, 50_000, 10_000, opusHigh, sonnetMed, ANTHROPIC, HOUR) < lowPointUsd(60_000, 0, 60_000, opusHigh, sonnetMed, ANTHROPIC, HOUR), 'a target with a warm cache reads what it holds')
  assert.equal(lowPointUsd(60_000, 0, 60_000, null, opusHigh, ANTHROPIC, HOUR), 0, 'a first route has nothing to compare')
})

test('a cold cache inside a task keeps the risk and confidence gates', () => {
  // Sonnet high to Opus low keeps thinking and adds no capability: only the quality gates can hold it.
  const from = routeFor('T2')
  const to = at('opus', 'low')
  const cold = { now: 1_000 + 2 * HOUR }
  assert.equal(moveCheck(from, to, { ...cold, risk: 'critical' }).gate, 'quality')
  assert.equal(moveCheck(from, to, { ...cold, candidate: cand('T3', 0.5) }).gate, 'quality')
  assert.equal(moveCheck(from, to, { ...cold, requestsSinceSwitch: 1 }).gate, 'dwell')
  assert.equal(moveCheck(from, to, cold).verdict, 'switch')
  assert.equal(moveCheck(from, to, { ...cold, risk: 'critical', sameTask: false }).verdict, 'switch', 'a new task has no task to protect')
})

test('up compares capability: Sonnet max to Opus low is no upgrade, and two votes do not move it', () => {
  const r = moveCheck(at('sonnet', 'max'), at('opus', 'low'), { sameTask: false, cache: cache({ model: routeFor('T1').model, prefixTokens: 300_000 }) })
  assert.equal(r.verdict, 'hold')
  assert.equal(r.gate, 'payback')
  assert.equal(moveCheck(at('sonnet', 'low'), at('opus', 'low'), { sameTask: false }).verdict, 'switch', 'Opus low is above Sonnet low')
})

test('property: a mandatory switch always goes, on every pair, provider and cache state, and logs the flag', () => {
  for (const p of PROVIDERS) for (const f of FAMILIES) for (const t of FAMILIES) {
    if (f === t) continue
    for (const now of [2_000, 1_000 + 2 * HOUR]) for (const sameTask of [true, false]) for (const risk of ['none', 'critical']) {
      const r = moveCheck(at(f, 'medium'), at(t, 'medium'), { provider: p, now, sameTask, risk, mandatory: true, switchesThisTask: 9, requestsSinceSwitch: 0 })
      assert.equal(r.verdict, 'switch')
      assert.equal(r.continuity, continuity(modelOf(f), modelOf(t), p))
    }
  }
})

test('property: a lost pair inside a task never switches at will, in any cache state, until a compaction', () => {
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max']
  let seen = 0
  for (const p of PROVIDERS) for (const f of FAMILIES) for (const t of FAMILIES) for (const a of efforts) for (const b of efforts) {
    if (f === t || continuity(modelOf(f), modelOf(t), p) === 'kept') continue
    for (const prefixTokens of [5_000, 60_000, 300_000]) for (const now of [2_000, 1_000 + 2 * HOUR]) for (const targetWarm of [false, true]) {
      seen += 1
      const o = { provider: p, now, targetWarm, cache: cache({ model: modelOf(f), prefixTokens }) }
      assert.equal(moveCheck(at(f, a), at(t, b), o).verdict, 'hold', `${f}/${a} to ${t}/${b}`)
    }
  }
  assert.ok(seen > 1_000)
  const lost = { cache: cache({ model: opusHigh.model, prefixTokens: 15_000 }) }
  assert.equal(moveCheck(opusHigh, sonnetMed, lost).gate, 'continuity')
  assert.equal(moveCheck(opusHigh, sonnetMed, { ...lost, compacted: true }).continuity, 'cleared')
  assert.equal(moveCheck(opusHigh, sonnetMed, { ...lost, compacted: true }).verdict, 'switch')
})

test('a lost pair at a new task only records the flag', () => {
  const r = moveCheck(opusHigh, routeFor('T0'), { sameTask: false, cache: cache({ model: opusHigh.model, prefixTokens: 15_000 }) })
  assert.equal(r.verdict, 'switch')
  assert.equal(r.continuity, 'lost')
})

test('property: the return price never falls as turns are added, and an expired return costs at least a warm one', () => {
  const ttls = [HOUR, 300_000]
  for (const f of FAMILIES) for (const t of FAMILIES) {
    if (f === t) continue
    for (const ttlMs of ttls) for (const prefixTokens of [25_000, 80_000, 150_000, 300_000]) for (const share of [0, 0.15]) {
      let last = -1
      for (let g = 0; g <= 40_000; g += 2_000) {
        const c = transitionUsd({ cache: cache({ prefixTokens, ttlMs }), from: at(f, 'medium'), to: at(t, 'medium'), prices: ANTHROPIC, hiUsd: 0, addedTokens: g, droppedTokens: prefixTokens * share, sameTask: true })
        assert.ok(c.retWarmUsd >= last - 1e-12, `${f} to ${t}: ${c.retWarmUsd} fell below ${last} at G=${g}`)
        assert.ok(c.retExpiredUsd >= c.retWarmUsd - 1e-12, `${f} to ${t}: expired below warm`)
        last = c.retWarmUsd
      }
    }
  }
})

test('property: the outbound price is never below the true move with a drop and a warm part applied', () => {
  for (const f of FAMILIES) for (const t of FAMILIES) {
    if (f === t) continue
    for (const K of [25_000, 80_000, 150_000, 300_000]) for (const D of [0, 0.15 * K]) for (const q of [0, 23_750]) {
      const from = at(f, 'medium')
      const to = at(t, 'medium')
      const k = cache({ model: from.model, prefixTokens: K, ttlMs: HOUR })
      const n = rateAt(ANTHROPIC.rates[to.family], K)
      const m = rateAt(ANTHROPIC.rates[from.family], K)
      const truth = ((K - D - q) * n.input * 2 + q * n.input * n.cacheReadX - K * m.input * m.cacheReadX) / 1e6
      const hi = moveCheck(from, to, { sameTask: false, cache: k }).rent.transition.hiUsd
      assert.ok(hi >= truth - 1e-12, `${f} to ${t} at ${K}`)
    }
  }
})

test('rent: the share comes from prices, a target that takes more steps saves less, and a dearer target saves nothing', () => {
  const r = ANTHROPIC.rates
  assert.equal(rentShare('opus', 'sonnet', r), 0.5)
  assert.equal(rentShare('opus', 'haiku', r), 0.975)
  assert.equal(rentShare('sonnet', 'haiku', r), 0.95)
  assert.equal(rentShare('sonnet', 'opus', r), 0)
  assert.equal(rentShare('opus', 'sonnet', r, 1.5), 0.25)
})

test('rent: it rises only while the same target stays eligible, and starts over on a switch or a new target', () => {
  const r = ANTHROPIC.rates
  const toS = { to: 'sonnet', stepRatio: 1 }
  let a = accrueRent(null, 'opus', toS, 0.12, r)
  a = accrueRent(a, 'opus', toS, 0.12, r)
  assert.ok(Math.abs(a.usd - 0.12) < 1e-9)
  assert.equal(accrueRent(a, 'opus', undefined, 0.12, r), null, 'the target is no longer eligible')
  assert.equal(accrueRent(a, 'sonnet', toS, 0.12, r), null, 'the switch happened')
  assert.ok(Math.abs(accrueRent(a, 'opus', { to: 'haiku', stepRatio: 1 }, 0.1, r).usd - 0.0975) < 1e-9, 'a new target starts at zero')
  assert.ok(Math.abs(accrueRent({ from: 'sonnet', to: 'haiku', usd: 1 }, 'opus', toS, 0.1, r).usd - 0.05) < 1e-9, 'a new running model starts at zero')
})

test('rent rule, shadow: the audit worked case, and the live verdict never moves', () => {
  const k = cache({ model: opusHigh.model, effort: 'high', prefixTokens: 100_000 })
  const target = sonnetMed
  const step = (rent, o = {}) => moveCheck(opusHigh, target, { sameTask: false, cache: k, rent, ...o })
  const none = step(null)
  assert.equal(none.rent.verdict, 'hold', 'no rent yet')
  assert.equal(none.rent.boundary, 'new-task')
  assert.equal(none.rent.transition.pi, 0.5)
  const paid = step({ from: 'opus', to: 'sonnet', usd: 0.72 })
  assert.equal(paid.rent.verdict, 'switch', 'twelve eligible $0.12 requests pay for the move')
  assert.equal(paid.verdict, none.verdict, 'the live verdict ignores rent')
  assert.equal(paid.gate, none.gate)
  assert.equal(step({ from: 'opus', to: 'haiku', usd: 9 }).rent.rentUsd, 0, 'rent toward another target does not count')
  assert.equal(moveCheck(opusHigh, target, { cache: k, rent: { from: 'opus', to: 'sonnet', usd: 9 } }).rent.heldBy, 'continuity', 'the rule keeps the gates it does not replace')
  assert.equal(moveCheck(opusHigh, target, { cache: k, rent: { from: 'opus', to: 'sonnet', usd: 9 } }).rent.verdict, 'hold')
  assert.equal(moveCheck(opusHigh, target, { cache: k, mandatory: true }).rent, undefined, 'a mandatory switch is outside the rule')
  assert.equal(moveCheck(opusHigh, opusHigh, { cache: k }).rent, undefined, 'so is staying')
  assert.equal(boundaryOf({ sameTask: true, verifiedSinceSwitch: false }, false), 'none')
  assert.equal(boundaryOf({ sameTask: true, verifiedSinceSwitch: true }, false), 'checkpoint')
  assert.equal(boundaryOf({ sameTask: true, verifiedSinceSwitch: false }, true), 'cold')
  assert.equal(boundaryOf({ sameTask: true, verifiedSinceSwitch: false, compacted: true }, false), 'compaction')
})

test('property: the rent rule does not flip-flop while the same target stays eligible', () => {
  for (const [f, t] of [['opus', 'sonnet'], ['opus', 'haiku'], ['sonnet', 'haiku']]) {
    let running = at(f, 'medium')
    const cheap = at(t, 'medium')
    let rent = null
    let moves = 0
    for (let i = 0; i < 200; i++) {
      const c = moveCheck(running, cheap, { sameTask: false, cache: cache({ model: running.model, prefixTokens: 60_000 }), rent })
      if (c.rent?.verdict === 'switch') { running = cheap; moves += 1 }
      rent = accrueRent(rent, running.family, running.family === t ? undefined : c.rent, 0.12, ANTHROPIC.rates)
    }
    assert.equal(moves, 1, `${f} to ${t} moved ${moves} times`)
  }
})

test('attemptCost: new input is priced at the cache lifetime in use', () => {
  const d = { steps: 1 }
  const c = { family: 'sonnet', effort: 'medium', cap: { lo: 0, hi: 0 } }
  const x = (ttlMs) => ({ cache: { ...coldCache(0), ttlMs }, warm: {}, now: 0, prices: ANTHROPIC, neutral: true })
  const gap = attemptCost(c, d, x(HOUR)).usd - attemptCost(c, d, x(300_000)).usd
  assert.ok(Math.abs(gap - (983 * 2 * 0.75) / 1e6) < 1e-9)
})
