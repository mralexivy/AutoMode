// Regressions from real sessions of the 2026-11-02/03 rescue benchmark (bench/fixtures/transcripts, made with
// bench/transcript-fixture.mts). Each fixture is the incident's own tool calls, scrubbed. Each test first shows that
// the fixture holds the shape that fooled the old code, then that the current code reads it right.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { checkKey, classify, escalation, EMPTY_LADDER, failureOf, isCheck, writesFiles } from '../hooks/lib/failures.ts'
import { replay, type ToolEvent } from './lib/replay.mts'

const DIR = path.join('bench', 'fixtures', 'transcripts')
const load = (name: string): ToolEvent[] => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8')).events
const checks = (evs: ToolEvent[]) => evs.filter((e) => e.tool === 'Bash' && isCheck(e.cmd) && e.out)

test('fixtures hold no personal path and no model text', () => {
  for (const f of fs.readdirSync(DIR)) {
    const text = fs.readFileSync(path.join(DIR, f), 'utf8')
    assert.doesNotMatch(text, /\/Users\/(?!u\/)[a-z][a-z0-9_-]*\/|\/home\/(?!u\/)[a-z]/, f)
    const j = JSON.parse(text)
    assert.deepEqual(Object.keys(j).sort(), ['events', 'source_session', 'why'], f)
    for (const e of j.events) assert.deepEqual(Object.keys(e).sort(), ['cmd', 'err', 'out', 'tool'], f)
  }
})

test('eb50028: FAILED (failures=3) beside a stray "No module named" is a defect, not environment', () => {
  const hit = checks(load('sqlglot-failures-with-setuptools-noise')).find((e) => /FAILED \(failures=\d/.test(e.out))!
  assert.ok(hit, 'the fixture holds the incident output')
  assert.match(hit.out, /No module named 'setuptools_scm'/, 'and the line that fooled the old rule')
  assert.equal(classify(hit.out), 'defect')
})

test('7876b25: FAILED (errors=1) with the same line is a defect too, unless the error is a missing program', () => {
  const hit = checks(load('sqlglot-errors-with-setuptools-noise')).find((e) => /FAILED \(errors=\d/.test(e.out) && !/failures=/.test(e.out))!
  assert.ok(hit)
  assert.match(hit.out, /No module named 'setuptools_scm'/)
  // The one error is test_lazy_load running `python` on a machine with only python3. It fails before and after any
  // edit, the grader deselects it, and reading it as a defect sent the 2026-11-03 run up four rungs to Opus.
  assert.match(hit.out, /FileNotFoundError: \[Errno 2\] No such file or directory: 'python'$/m)
  assert.equal(classify(hit.out), 'environment')
  // The same output with an error of the work's own is a defect, setuptools noise or not.
  assert.equal(classify(hit.out.replace(/'python'$/m, "'tests/fixtures/q.sql'")), 'defect')
})

test('eb50028 pymarkdown: without the grader\'s PYTHONPATH every check failed on imports, so no real failure showed', () => {
  const outs = checks(load('pymarkdown-missing-pythonpath'))
  const imports = outs.filter((e) => /No module named 'yaml'/.test(e.out))
  assert.ok(imports.length >= 1, 'the agent hit the missing dependency')
  for (const e of imports) assert.equal(classify(e.out), 'environment', 'read right as environment: the fix is the agent env, which the preflight now checks')
})

test('997ca79: edits through Bash are seen, and one check keeps one key across Bash lines', () => {
  const evs = load('sqlglot-bash-edits-and-narrowing')
  assert.ok(evs.filter((e) => e.tool === 'Bash' && writesFiles(e.cmd)).length >= 3, 'sed -i and heredoc edits count')
  const suite = checks(evs).filter((e) => /unittest discover/.test(e.cmd))
  assert.ok(suite.length >= 1)
  assert.ok(new Set(suite.map((e) => e.cmd)).size >= 1)
  assert.equal(new Set(suite.map((e) => checkKey(e.cmd))).size, 1, 'every full-suite run has one key')
})

test('997ca79: a full suite that failed is still failing at the stop, whatever subsets passed after it', () => {
  const r = replay(load('sqlglot-bash-edits-and-narrowing'), { stop: true })
  assert.ok(r.passes >= 1, 'narrowed subsets passed')
  assert.equal(r.fullSuiteFailedAtEnd, true)
  const stop = r.steps.at(-1)!
  assert.equal(stop.kind, 'stop')
  assert.equal(stop.level, 'strong', 'the stop with the full suite failing is strong evidence')
})

test('997ca79: the full-suite runs that failed only on test_lazy_load are the machine, not new failures', () => {
  // This test once asserted an escalation here. Two of the full suite's failing runs were test_lazy_load alone, a
  // program the machine lacks, so read right the check failed for the work twice, not three times.
  const evs = load('sqlglot-same-check-new-failures')
  const lazy = checks(evs).filter((e) => /FAILED \(errors=1, skipped=2\)/.test(e.out))
  assert.ok(lazy.length >= 2)
  for (const e of lazy) assert.equal(classify(e.out), 'environment')
  assert.ok(!replay(evs).steps.some((s) => /times after edits/.test(s.because)))
})

test('the old reading of the same sessions never escalated: whole Bash lines as keys and no Bash edits', () => {
  for (const name of ['sqlglot-bash-edits-and-narrowing', 'sqlglot-same-check-new-failures']) {
    const hist = []
    let edited = false
    let level = 'none'
    for (const [i, e] of load(name).entries()) {
      if (['Edit', 'Write', 'MultiEdit'].includes(e.tool)) { edited = true; continue }
      if (e.tool !== 'Bash' || !isCheck(e.cmd) || !e.out) continue
      const f = failureOf(e.cmd, 1, e.out, i, edited)
      edited = false
      if (!f) continue
      hist.push({ ...f, command: e.cmd })
      // The old rule: same fingerprint twice after an edit. Each Bash line was its own key, so it never matched.
      const same = hist.filter((x) => x.fingerprint === f.fingerprint)
      if (same.length >= 2 && f.editedSince) level = 'weak'
    }
    assert.equal(level, 'none', `${name}: the old rule saw nothing`)
    assert.notEqual(replay(load(name), { stop: true }).escalations, 0, `${name}: the current code escalates`)
  }
  assert.equal(escalation([], { ...EMPTY_LADDER, effortCapped: false }).level, 'none')
})
