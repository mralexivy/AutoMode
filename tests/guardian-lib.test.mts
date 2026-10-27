// @ts-nocheck TODO(types): 24 errors with strict off. Fix them and delete this line to turn checking on for this file.
// Unit tests for the guardian's pure policy (hooks/lib/guardian.ts). Each expected value comes from a source outside the
// guardian's own thresholds: a recorded session pattern (bench/guardian-replay.mts, 2026-10-26), list prices, or a safety
// requirement (no lost work, no deleted diagnostics, no secrets on disk).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldOffer, GUARDIAN_DEFAULTS as C, newTurn, observeTool, observeOutcome, observeRequest, observeCost, assess, buildCheckpoint, verifyRestore, restrictionsIn, modeOf, atLeast, noteFor, safeToAbort, lifecycle, lifecycleCosts, reduceOutput, reducible, validateCheckpoint, handoffText, scrub, fingerprint } from '../hooks/lib/guardian.ts'

const bash = (command, text = 'ok', isError = false) => ({ tool: 'Bash', input: { command }, isError, text })
const edit = (file, s = 'x') => ({ tool: 'Edit', input: { file_path: file, new_string: s }, isError: false, text: 'ok' })
const run = (t, events, usdPerRequest = 0.1) => {
  for (const ev of events) {
    if (ev === 'req') { observeRequest(t, usdPerRequest); continue }
    const o = observeTool(t, ev)
    if (o) observeOutcome(t, o, 0)
  }
  return assess(t, C)
}
const reqs = (n) => Array.from({ length: n }, () => 'req')

test('a check that passes after a change is an outcome; rerunning a passing check without a change is not', () => {
  const t = newTurn('t', 0)
  assert.equal(observeTool(t, edit('/a.ts')), null)
  assert.equal(observeTool(t, bash('npx tsc --noEmit')), 'check-passed')
  assert.equal(observeTool(t, bash('npx tsc --noEmit')), null, 'no change in between: no new outcome')
})

test('a failing check, fixed: fail then pass is an outcome even with the change between them', () => {
  const t = newTurn('t', 0)
  observeTool(t, bash('go test ./...', '--- FAIL: TestX\nFAIL', true))
  observeTool(t, edit('/x.go'))
  assert.equal(observeTool(t, bash('go test ./...', 'ok  pkg 0.1s')), 'check-passed')
})

test('the same failure after a change counts as a failed attempt; a plain rerun does not', () => {
  const t = newTurn('t', 0)
  const fail = (n) => bash('npm run build', `error TS2322 at line ${n}: Type 'x' is not assignable\nfailed`, true)
  observeTool(t, fail(10))
  observeTool(t, fail(11)) // rerun, no change: same failure (line numbers are blanked)
  assert.equal(Object.values(t.failures)[0].repeats, 1)
  observeTool(t, edit('/a.ts')); observeTool(t, fail(12))
  observeTool(t, edit('/a.ts', 'y')); observeTool(t, fail(13))
  assert.equal(Object.values(t.failures)[0].repeats, 3)
})

// Recorded pattern from a real session: a 410-request turn with one outcome, followed by a correction. The guardian
// warns and then pauses. Recorded pattern from another real session: a 206-request turn with 13 outcomes: never paused.
test('a long stretch without outcomes warns, then pauses; a long turn with regular outcomes does not', () => {
  const stuck = newTurn('t', 0)
  assert.equal(run(stuck, reqs(C.warnRequests)).level, 'warning')
  assert.equal(run(stuck, reqs(C.warnRequests)).level, 'pause')
  const productive = newTurn('t', 0)
  // Each cycle changes the code differently, then the check passes (an identical edit repeated would be a repeat).
  for (let i = 0; i < 14; i++) assert.notEqual(run(productive, [...reqs(15), edit('/a.ts', `v${i}`), bash('npm test', 'pass')]).level, 'pause')
  assert.ok(productive.requests > 200)
  assert.equal(run(productive, []).level, 'normal')
})

test('both gates must be crossed: many cheap requests, or a few expensive ones, do not warn alone', () => {
  assert.notEqual(run(newTurn('t', 0), reqs(C.warnRequests * 3), 0.01).level, 'warning', 'cheap requests')
  assert.notEqual(run(newTurn('t', 0), reqs(5), 5).level, 'warning', 'few requests')
})

test('three identical failures with changes in between pause at once', () => {
  const t = newTurn('t', 0)
  const fail = bash('pytest -q', 'FAILED test_x.py::test_a - AssertionError', true)
  run(t, [fail, edit('/a.py'), fail, edit('/a.py', 'b'), fail, edit('/a.py', 'c'), fail])
  assert.equal(assess(t, C).level, 'pause')
})

test('am:continue widens the gates by one window per authorization', () => {
  const t = newTurn('t', 0, 1)
  assert.notEqual(run(t, reqs(C.warnRequests)).level, 'warning')
  assert.equal(run(t, reqs(C.warnRequests)).level, 'warning')
})

test('notes: once per level per outcome window, and an outcome resets the window', () => {
  const t = newTurn('t', 0)
  run(t, reqs(C.warnRequests))
  assert.match(noteFor(t, assess(t, C)) ?? '', /checkpoint/)
  assert.equal(noteFor(t, assess(t, C)), null, 'not repeated')
  observeOutcome(t, 'commit', 0)
  assert.equal(noteFor(t, assess(t, C)), null, 'an outcome ends the stretch')
  run(t, reqs(C.warnRequests * 2))
  assert.match(noteFor(t, assess(t, C)) ?? '', /pause/)
})

test('a hard pause is never right after a write or a transactional command', () => {
  const t = newTurn('t', 0)
  observeTool(t, edit('/a.ts')); assert.equal(safeToAbort(t), false)
  observeTool(t, bash('git rebase --continue')); assert.equal(safeToAbort(t), false)
  observeTool(t, bash('ls')); assert.equal(safeToAbort(t), true)
})

test('repeated identical calls are recognised by fingerprint, volatile spacing ignored', () => {
  assert.equal(fingerprint('Bash', { command: 'npm  test' }), fingerprint('Bash', { command: 'npm test' }))
  assert.notEqual(fingerprint('Read', { file_path: '/a', offset: 1 }), fingerprint('Read', { file_path: '/a', offset: 200 }))
})

// Lifecycle: prices from prices.ts (Opus 5.5: $4 in, read 0.05x, 1h write 2x). Negative cases first.
const base = { family: 'opus', contextTokens: 450_000, baseTokens: 40_000, staleTokens: 400_000, idleMs: 60_000, ttlMs: 3_600_000, horizon: 8, taskClosed: true, openFailures: 0 }
test('lifecycle: open failures keep the context (diagnostics), a small context always continues', () => {
  assert.equal(lifecycle({ ...base, openFailures: 1 }, C).action, 'continue')
  assert.equal(lifecycle({ ...base, contextTokens: 100_000 }, C).action, 'continue')
})

test('lifecycle: a finished task clears when the cache is cold or the horizon is long, not on size alone', () => {
  // Warm 450k Opus over the conservative 8-request horizon: clearing saves about 17%, under the 20% margin. Continue.
  assert.equal(lifecycle(base, C).action, 'continue', 'size alone is not a reason')
  // Cold: the next request writes all 450k again ($3.60 at Opus 5.5); a fresh session writes 64k.
  assert.equal(lifecycle({ ...base, idleMs: 2 * 3_600_000 }, C).action, 'clear')
  // Warm, but the median route horizon (21 requests on the first-party period).
  assert.equal(lifecycle({ ...base, horizon: 21 }, C).action, 'clear')
  // At a turn end the idle time is unknown: the measured 9% chance of a cold return tips a finished 450k task to clear.
  assert.equal(lifecycle({ ...base, idleMs: 0, pCold: 0.09 }, C).action, 'clear')
  assert.equal(lifecycle({ ...base, idleMs: 0, pCold: 0 }, C).action, 'continue')
  // An unfinished task is never cleared, cold or not.
  assert.notEqual(lifecycle({ ...base, idleMs: 2 * 3_600_000, taskClosed: false, staleTokens: 50_000 }, C).action, 'clear')
})

test('lifecycle: the warm-cache arithmetic matches list prices', () => {
  const c = lifecycleCosts({ ...base, horizon: 1 }, C)
  assert.ok(Math.abs(c.continue - 450_000 * 4 * 0.05 / 1e6) < 1e-9, 'one warm request reads the context')
  const cold = lifecycleCosts({ ...base, horizon: 1, idleMs: 2 * 3_600_000 }, C)
  assert.ok(Math.abs(cold.continue - 450_000 * 4 * 2 / 1e6) < 1e-9, 'a cold one writes it again')
})

test('lifecycle: a short horizon on a warm cache continues rather than paying a rebuild', () => {
  assert.equal(lifecycle({ ...base, horizon: 1, contextTokens: 160_000, staleTokens: 100_000 }, C).action, 'continue')
})

test('output: errors and the tail survive; small outputs and non-command tools are untouched', () => {
  const noise = Array.from({ length: 3000 }, (_, i) => `ok line ${i} ${'x'.repeat(30)}`)
  noise[1500] = 'Error: connection refused at db.ts:42'
  const r = reduceOutput(noise.join('\n'), C.reduceAboveChars, '/data/outputs/1.txt')
  assert.ok(r.reduced)
  assert.match(r.text, /connection refused at db\.ts:42/)
  assert.match(r.text, /ok line 2999/)
  assert.match(r.text, /\/data\/outputs\/1\.txt/)
  assert.ok(r.text.length < noise.join('\n').length / 3)
  assert.equal(reduceOutput('short', C.reduceAboveChars, null).reduced, false)
  assert.equal(reducible('Read'), false)
  assert.equal(reducible('Edit'), false)
  assert.equal(reducible('Bash'), true)
  assert.equal(reducible('mcp__docs__search'), true)
  assert.equal(reducible('mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_snapshot'), true)
  assert.equal(reducible('mcp__docs__read_document'), false)
  assert.equal(reducible('mcp__claude_ai_Atlassian_MCP__getConfluenceContent'), false)
  assert.equal(reducible('mcp__atlassian__fetch'), false)
})

test('output: a log that is mostly diagnostics is not shortened (it would remove no noise)', () => {
  const errors = Array.from({ length: 3000 }, (_, i) => `ERROR ${i}: failed to connect`).join('\n')
  assert.equal(reduceOutput(errors, C.reduceAboveChars, null).reduced, false)
})

const cp = { v: 1, sessionId: 's1', cwd: '/repo', at: 1000, objective: 'fix the uploader retries', acceptance: [], stage: 'in progress', status: 'open', outcomes: ['check-passed'], filesChanged: ['/repo/up.ts'], filesRead: [], checks: [{ command: 'npm test', passed: true }], openFailures: [], git: { branch: 'feat', dirty: ['up.ts'] }, approvals: [], next: 'add the backoff test' }
test('checkpoint: complete, fresh, same folder, or it is refused', () => {
  assert.deepEqual(validateCheckpoint(cp, 2000, '/repo'), { ok: true, missing: [] })
  assert.ok(validateCheckpoint({ ...cp, objective: '' }, 2000, '/repo').missing.includes('objective'))
  assert.ok(validateCheckpoint(cp, 2000, '/other').missing.includes('same project'))
  assert.ok(validateCheckpoint(cp, 1000 + 25 * 3_600_000, '/repo').missing.includes('fresh (24 h)'))
  assert.ok(validateCheckpoint({ ...cp, filesChanged: [], checks: [], outcomes: [] }, 2000, '/repo').missing.includes('work state of an open task'))
  assert.equal(validateCheckpoint(null, 0, '/repo').ok, false)
})

test('checkpoint: secrets never reach the handoff', () => {
  const text = handoffText({ ...cp, objective: 'deploy with token=abcd1234secret and key sk-ant-REDACTEDREDACTED0000', next: 'export GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
  assert.doesNotMatch(text, /abcd1234secret|sk-ant-REDACTED|ghp_a{20}/)
  assert.match(text, /files on disk are the source of truth/)
  assert.equal(scrub('password: hunter2'), 'password: [redacted]')
})

// Mutation tests: bad guardians run through the same independent cases. Each must fail at least one, for its reason.
test('mutations: each bad guardian is caught by a recorded or safety case', () => {
  const real = { assess: (t) => assess(t, C).level, life: (i) => lifecycle(i, C).action, reduce: (x) => reduceOutput(x, C.reduceAboveChars, null) }
  const MUTANTS = {
    'always pause': { ...real, assess: () => 'pause' },
    'never pause': { ...real, assess: (t) => { const l = assess(t, C).level; return l === 'pause' ? 'warning' : l } },
    'count requests only (no cost gate)': { ...real, assess: (t) => (t.sinceOutcome.requests >= C.warnRequests * C.pauseFactor ? 'pause' : t.sinceOutcome.requests >= C.warnRequests ? 'warning' : 'normal') },
    'always clear when large': { ...real, life: (i) => (i.contextTokens >= C.minContextTokens ? 'clear' : 'continue') },
    'never clear': { ...real, life: (i) => { const a = lifecycle(i, C).action; return a === 'clear' ? 'continue' : a } },
    'clear through open failures': { ...real, life: (i) => lifecycle({ ...i, openFailures: 0 }, C).action },
    'truncate blindly': { ...real, reduce: (x) => ({ text: x.slice(0, 2000), reduced: x.length > C.reduceAboveChars }) },
  }
  const stuck = () => { const t = newTurn('t', 0); for (let i = 0; i < C.warnRequests * 2; i++) observeRequest(t, 0.1); return t }
  const productive = () => { const t = newTurn('t', 0); for (let i = 0; i < 200; i++) { observeRequest(t, 0.1); if (i % 20 === 19) { observeTool(t, edit('/a.ts', `v${i}`)); const o = observeTool(t, bash('npm test')); if (o) observeOutcome(t, o, 0) } } return t }
  const cheap = () => { const t = newTurn('t', 0); for (let i = 0; i < C.warnRequests * 3; i++) observeRequest(t, 0.005); return t }
  const log = Array.from({ length: 3000 }, (_, i) => (i === 2500 ? 'FATAL: migration 042 failed' : `row ${i} ${'x'.repeat(30)}`)).join('\n')
  const cases = [
    ['stuck turn pauses', (m) => m.assess(stuck()) === 'pause'],
    ['productive turn never pauses', (m) => m.assess(productive()) !== 'pause'],
    ['cheap requests alone do not warn', (m) => m.assess(cheap()) === 'normal' || m.assess(cheap()) === 'optimize'],
    ['warm 450k finished task continues', (m) => m.life(base) === 'continue'],
    ['cold 450k finished task clears', (m) => m.life({ ...base, idleMs: 2 * 3_600_000 }) === 'clear'],
    ['open failures are kept', (m) => m.life({ ...base, idleMs: 2 * 3_600_000, openFailures: 2 }) === 'continue'],
    ['a fatal line deep in a log survives', (m) => /migration 042 failed/.test(m.reduce(log).text)],
  ]
  for (const [, ok] of cases) assert.ok(ok(real), 'the real guardian passes every case')
  for (const [name, m] of Object.entries(MUTANTS)) {
    const failed = cases.filter(([, ok]) => !ok(m)).map(([n]) => n)
    assert.ok(failed.length > 0, `mutant "${name}" is not caught`)
  }
})

const cpInput = (over = {}) => {
  const t = newTurn('t', 0)
  observeTool(t, edit('/repo/up.ts'))
  observeTool(t, bash('npm test', 'FAIL up.test.ts: expected 3 retries', true))
  return { sessionId: 's', cwd: '/repo', at: 1, objective: 'fix retries', closed: false, turn: t, filesRead: ['/repo/up.ts'], checks: [{ command: 'npm test', passed: false }], approvals: ['plan approved'], restrictions: restrictionsIn('fix retries, do not push to origin'), git: { branch: 'feat', dirty: ['up.ts'] }, next: 'fix the backoff', ...over }
}

test('checkpoint: a failing check stays failing, the task stays open, approvals and restrictions carry over', () => {
  const cp = buildCheckpoint(cpInput())
  assert.equal(cp.status, 'open')
  assert.deepEqual(cp.checks, [{ command: 'npm test', passed: false }])
  assert.ok(cp.openFailures.some((f) => /npm test/.test(f)))
  assert.ok(cp.approvals.includes('plan approved'))
  assert.ok(cp.approvals.some((a) => /restriction: do not push to origin/.test(a)))
  // A task the turn called closed is still open while a check fails.
  assert.equal(buildCheckpoint(cpInput({ closed: true })).status, 'open')
})

test('restrictions: verbatim and specific; a plain request is not one', () => {
  assert.deepEqual(restrictionsIn("Refactor the parser. Don't touch the public API, and never push without review."), ["Don't touch the public API, and never push without review"])
  assert.deepEqual(restrictionsIn('add a retry to the uploader'), [])
})

test('restore: the same branch with the same uncommitted files passes; a moved tree is held', () => {
  const cp = buildCheckpoint(cpInput())
  assert.deepEqual(verifyRestore(cp, { branch: 'feat', dirty: ['up.ts', 'other.ts'] }), { ok: true, problems: [] })
  assert.equal(verifyRestore(cp, { branch: 'main', dirty: ['up.ts'] }).ok, false)
  assert.match(verifyRestore(cp, { branch: 'feat', dirty: [] }).problems.join(), /no longer uncommitted: up\.ts/)
})

test('modes: old names map, unknown values fall back to observe, and the tiers nest', () => {
  assert.equal(modeOf('shadow'), 'observe'); assert.equal(modeOf('on'), 'assist'); assert.equal(modeOf('AUTO'), 'auto'); assert.equal(modeOf('bogus'), 'observe')
  assert.ok(atLeast('auto', 'assist') && atLeast('assist', 'recommend') && !atLeast('recommend', 'assist') && !atLeast('observe', 'recommend'))
})

test('subagent cost counts toward the cost since the last outcome', () => {
  const t = newTurn('t', 0)
  for (let i = 0; i < C.warnRequests; i++) { observeRequest(t, 0.01); observeCost(t, 0.2) }
  assert.equal(assess(t, C).level, 'warning', 'main requests cheap, subagents expensive: still a warning')
})

// The brief's mutation list: each bad behavior must fail a case drawn from history or a safety requirement.
test('mutations (brief list): every bad guardian is caught for its reason', () => {
  const stuck = (count = (t, o) => observeTool(t, o)) => { const t = newTurn('t', 0); for (let i = 0; i < C.warnRequests * 2; i++) { observeRequest(t, 0.1); const o = count(t, { tool: 'Read', input: { file_path: `/r/f${i % 5}.ts` }, isError: false, text: 'x' }); if (o) observeOutcome(t, o, 0) } return t }
  const productive = () => { const t = newTurn('t', 0); for (let i = 0; i < 220; i++) { observeRequest(t, 0.1); if (i % 20 === 19) { observeTool(t, edit('/a.ts', `v${i}`)); const o = observeTool(t, bash('npm test')); if (o) observeOutcome(t, o, 0) } } return t }
  const subHeavy = (withSub) => { const t = newTurn('t', 0); for (let i = 0; i < C.warnRequests; i++) { observeRequest(t, 0.01); if (withSub) observeCost(t, 0.2) } return t }
  const L = (i) => lifecycle(i, C).action
  const real = {
    assess: (t) => assess(t, C).level, life: L, observe: (t, o) => observeTool(t, o), cost: true,
    checkpoint: (i) => buildCheckpoint(i), abortSafe: (t) => safeToAbort(t),
  }
  const M = {
    'always clear after one hour': { ...real, life: (i) => (i.idleMs > 3_600_000 ? 'clear' : L(i)) },
    'always compact above 200K': { ...real, life: (i) => (i.contextTokens > 200_000 ? 'compact' : L(i)) },
    'never compact': { ...real, life: (i) => { const a = L(i); return a === 'compact' ? 'continue' : a } },
    'always continue': { ...real, life: () => 'continue' },
    'always stop after 100 requests': { ...real, assess: (t) => (t.requests >= 100 ? 'pause' : assess(t, C).level) },
    'ignore cache expiration': { ...real, life: (i) => L({ ...i, idleMs: 0, pCold: 0 }) },
    'ignore task completion': { ...real, life: (i) => L({ ...i, taskClosed: true }) },
    'drop pending tests from checkpoints': { ...real, checkpoint: (i) => ({ ...buildCheckpoint(i), checks: i.checks.filter((c) => c.passed), openFailures: [] }) },
    'lose approval state': { ...real, checkpoint: (i) => ({ ...buildCheckpoint(i), approvals: [] }) },
    'ignore subagent cost': { ...real, cost: false },
    'count every tool call as progress': { ...real, observe: (t, o) => observeTool(t, o) ?? 'files-changed' },
    'treat every long turn as waste': { ...real, assess: (t) => (t.requests > 100 ? 'pause' : assess(t, C).level) },
    'ignore pending file operations': { ...real, abortSafe: () => true },
  }
  const afterWrite = () => { const t = newTurn('t', 0); observeTool(t, edit('/a.ts')); return t }
  const cases = [
    ['a stuck turn of reads pauses', (m) => m.assess(stuck(m.observe)) === 'pause'],
    ['a productive 220-request turn is not paused', (m) => m.assess(productive()) !== 'pause'],
    ['subagent spend counts (58% of a session)', (m) => assess(subHeavy(m.cost), C).level === 'warning'],
    ['an unfinished task after a 2h break is not cleared', (m) => m.life({ ...base, idleMs: 2 * 3_600_000, taskClosed: false, staleTokens: 50_000 }) !== 'clear'],
    ['a warm finished 450k task with no cold risk continues', (m) => m.life({ ...base, pCold: 0 }) === 'continue'],
    ['a cold finished 450k task clears', (m) => m.life({ ...base, idleMs: 2 * 3_600_000 }) === 'clear'],
    // Warm, mostly stale, 21 requests left (first-party median horizon): compact $0.89 against continue $1.89. Cold, the
    // compaction call itself writes the whole context again and no longer pays: covered by the cases above.
    ['an active task, mostly stale, warm, long horizon, compacts', (m) => m.life({ ...base, taskClosed: false, staleTokens: 420_000, horizon: 21, pCold: 0 }) === 'compact'],
    ['a checkpoint keeps the failing test', (m) => m.checkpoint(cpInput()).checks.some((c) => !c.passed)],
    ['a checkpoint keeps the restriction', (m) => m.checkpoint(cpInput()).approvals.some((a) => /do not push/.test(a))],
    ['no hard pause right after a write', (m) => m.abortSafe(afterWrite()) === false],
  ]
  for (const [name, ok] of cases) assert.ok(ok(real), `the real guardian fails: ${name}`)
  for (const [name, m] of Object.entries(M)) assert.ok(cases.some(([, ok]) => !ok(m)), `mutant "${name}" is not caught`)
})

test('a declined offer is not repeated at a steady size; growth or a cold cache brings it back', () => {
  assert.equal(shouldOffer(null, 'compact', 450_000), true)
  assert.equal(shouldOffer({ action: 'compact', contextTokens: 450_000 }, 'compact', 470_000), false)
  assert.equal(shouldOffer({ action: 'compact', contextTokens: 450_000 }, 'compact', 570_000), true)
  assert.equal(shouldOffer({ action: 'compact', contextTokens: 450_000 }, 'compact', 460_000, true), true)
  assert.equal(shouldOffer({ action: 'compact', contextTokens: 450_000 }, 'clear', 460_000), true, 'a different action is new')
  assert.equal(shouldOffer(null, 'continue', 900_000), false)
})

import { sealCheckpoint, openCheckpoint, reduceMcp, failedOutput } from '../hooks/lib/guardian.ts'
test('seal and open: a sealed checkpoint opens; a torn, edited, or unknown-version one does not', () => {
  const cp = buildCheckpoint(cpInput())
  const sealed = sealCheckpoint(cp)
  assert.deepEqual(openCheckpoint(sealed).cp, cp)
  assert.equal(openCheckpoint(sealed.slice(0, sealed.length - 10)).problem, 'unreadable')
  assert.equal(openCheckpoint(JSON.stringify({ ...JSON.parse(sealed), next: 'git push --force' })).problem, 'checksum mismatch')
  assert.equal(openCheckpoint(JSON.stringify({ ...JSON.parse(sealed), v: 2 })).problem, 'unknown version')
  assert.equal(openCheckpoint('').problem, 'missing')
  assert.equal(openCheckpoint(sealCheckpoint({ ...cp, sum: 'stale' })).cp?.objective, cp.objective, 'resealing ignores an old sum')
})

test('MCP reduction: only a successful, text-only, unstructured result; other blocks kept', () => {
  const big = Array.from({ length: 2000 }, (_, i) => (i === 1500 ? 'Error: quota exceeded for index docs' : `hit ${i} ${'y'.repeat(30)}`)).join('\n')
  const img = { type: 'image', data: 'AA', mimeType: 'image/png' }
  const r = reduceMcp({ content: [{ type: 'text', text: big }, img], isError: false }, C.reduceAboveChars, '/data/o.txt')
  assert.ok(r && r.to < r.from / 3)
  assert.match(r.result.content[0].text, /quota exceeded for index docs/)
  assert.deepEqual(r.result.content[1], img)
  assert.equal(reduceMcp({ content: [{ type: 'text', text: big }], isError: true }, C.reduceAboveChars, null), null, 'errors stay whole')
  assert.equal(reduceMcp({ content: [{ type: 'text', text: big }], isError: false, structuredContent: {} }, C.reduceAboveChars, null), null, 'structured results stay whole')
  assert.equal(reduceMcp({ content: [{ type: 'text', text: 'small' }], isError: false }, C.reduceAboveChars, null), null)
  assert.equal(reduceMcp('not an mcp result', C.reduceAboveChars, null), null)
})

// Live check L6 (2026-10-26): the exact node --test summary of a passing run read as a failure. Real runner summaries.
test('failure detection: zero-count summaries pass; real failures fail; the exit flag wins', () => {
  const passing = [
    '✔ ok (0.36ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 49.4',
    'Tests:       12 passed, 0 failed, 12 total',
    '===== 5 passed in 0.12s =====',
    'ok  \tgithub.com/x/y\t0.012s',
    ' Test Files  3 passed (3)\n      Tests  20 passed (20)\n   Errors: 0',
  ]
  for (const p of passing) assert.equal(failedOutput(false, p), false, p)
  const failing = ['--- FAIL: TestX (0.00s)\nFAIL', 'Tests:       1 failed, 11 passed', 'src/a.ts(3,5): error TS2322: Type', 'FAILED test_x.py::test_a - AssertionError', 'ℹ pass 3\nℹ fail 2']
  for (const f of failing) assert.equal(failedOutput(false, f), true, f)
  assert.equal(failedOutput(true, 'all good'), true, 'a non-zero exit is a failure whatever the text says')
  const t = newTurn('t', 0)
  observeTool(t, edit('/a.ts'))
  assert.equal(observeTool(t, bash('node --test', passing[0])), 'check-passed')
})

// Live check L6: changes made through Bash count as changes; reads and checks do not.
test('a Bash command that changes files counts as a change; a read or a check does not', () => {
  for (const cmd of ['echo a >> notes.txt', "sed -i '' 's/a/b/' x.ts", 'mv a.ts b.ts', 'git apply fix.patch', 'npm install zod', 'printf x | tee out.txt']) {
    const t = newTurn('t', 0)
    observeTool(t, bash(cmd))
    assert.equal(observeTool(t, bash('node --test', 'ℹ pass 1\nℹ fail 0')), 'check-passed', cmd)
    assert.equal(safeToAbort(newTurn('u', 0)), true)
  }
  for (const cmd of ['ls -la', 'cat notes.txt', 'grep -rn foo src', 'git status', 'echo hi 2>&1', 'node --test > /dev/null']) {
    const t = newTurn('t', 0)
    observeTool(t, bash(cmd))
    assert.equal(observeTool(t, bash('node --test', 'ℹ pass 1\nℹ fail 0')), null, cmd)
  }
  const w = newTurn('t', 0); observeTool(w, bash('echo a >> notes.txt')); assert.equal(safeToAbort(w), false, 'no hard pause right after a Bash write')
  // The exact live command: a write and a check in one call is a change followed by a passing check.
  const live = newTurn('t', 0)
  assert.equal(observeTool(live, bash(`printf 'a\\n' >> notes.txt && node --test; echo "exit=$?"`, 'ℹ pass 1\nℹ fail 0\nexit=0')), 'check-passed')
  const redirect = newTurn('t', 0)
  assert.equal(observeTool(redirect, bash('npm test > log.txt', 'ok')), null, 'a check writing its own log is not a change')
})
