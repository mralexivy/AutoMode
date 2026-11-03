import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { assessCompletion, blockReason, extractObligations, observeRun, publicObligations, reopen, type Obligation } from '../hooks/lib/completion.ts'

const example = (input: string, expected: string, status: Obligation['status'] = 'open'): Obligation => ({ id: `${input}|${expected}`, kind: 'example', input, expected, status })
const semantic: Obligation = { id: 's', kind: 'semantic', status: 'open' }
const sqlglot = JSON.parse(fs.readFileSync(new URL('../bench/tasks/longctx-sqlglot-intersect-precedence-across-dialects.json', import.meta.url), 'utf8')).task
const ctx = { gate: 'block' as const, stopHookActive: false, blocks: 0, backgroundWork: 0 }
const evidence = { edited: true, editedSinceCheck: false, lastCheckPassed: true, obligations: [] as Obligation[] }

test('the real sqlglot prompt yields the result its hidden test failed on', () => {
  const examples = extractObligations(sqlglot).filter((o) => o.kind === 'example')
  assert.ok(examples.length >= 10)
  assert.ok(examples.some((o) => o.input === 'SELECT (SELECT 1 UNION SELECT 2 INTERSECT SELECT 3 ORDER BY 1)' && o.expected === 'SELECT (SELECT 1 UNION (SELECT 2 INTERSECT SELECT 3) ORDER BY 1 NULLS LAST)'))
  assert.ok(examples.some((o) => o.input === 'SELECT 1 UNION SELECT 2 INTERSECT SELECT 3' && o.expected === 'SELECT 1 UNION (SELECT 2 INTERSECT SELECT 3)'))
  assert.ok(examples.some((o) => o.input === 'SELECT * FROM x LIMIT 1 UNION ALL SELECT * FROM y' && o.expected === o.input))
})

test('the wordings of a stated result all read the same way', () => {
  for (const line of ['foo(1) returns 2.', 'foo(1) must return 2.', 'foo(1) -> 2', 'foo(1) => 2', 'foo(1) should be 2.', 'foo(1) gives 2.', 'If x is set, foo(1) becomes 2.', 'Note the rule: foo(1) generates 2.']) {
    const [o] = extractObligations(line)
    assert.equal(o?.input, 'foo(1)', line)
    assert.equal(o?.expected, '2', line)
  }
})

test('plain words before an example are left out', () => {
  assert.equal(extractObligations('Fix parse so parse(1) must return 2.')[0].input, 'parse(1)')
  assert.equal(extractObligations('The result of SELECT 1 UNION SELECT 2 becomes (SELECT 1).')[0].input, 'SELECT 1 UNION SELECT 2')
})

test('prose is not an example', () => {
  assert.deepEqual(extractObligations('Add a dark mode toggle.'), [])
  assert.deepEqual(extractObligations('The API returns a 400 error.'), [])
  const [o, ...rest] = extractObligations('The title should be short.')
  assert.equal(o.kind, 'semantic')
  assert.deepEqual(rest, [])
})

test('an example run with no stated requirement left is the only obligation', () => {
  assert.deepEqual(extractObligations('foo(1) must return 2.').map((o) => o.kind), ['example'])
})

test('examples are capped, deduplicated and bounded', () => {
  const many = Array.from({ length: 40 }, (_, i) => `foo(${i}) returns ${i}.`).join(' ')
  assert.equal(extractObligations(many).length, 16)
  assert.equal(extractObligations('foo(1) returns 2. foo(1) returns 2.').length, 1)
})

test('a wrong result with exit 0 is a contradiction, not a pass', () => {
  const [o] = observeRun([example('SELECT 1 UNION SELECT 2', 'SELECT 1 UNION (SELECT 2)')], { command: "python -c \"print(t('SELECT 1 UNION SELECT 2'))\"", output: 'SELECT 1 UNION SELECT 2\n', exit: 0 })
  assert.equal(o.status, 'contradicted')
})

test('the expected text in real output satisfies an example', () => {
  const [o] = observeRun([example('foo(1)', '2')], { command: 'python -c "print(foo(1))"', output: '2\n', exit: 0 })
  assert.equal(o.status, 'satisfied')
})

test('whitespace differences do not hide a match', () => {
  const [o] = observeRun([example('a  (b)', 'x   y')], { command: 'run "a (b)"', output: 'x\n  y', exit: 0 })
  assert.equal(o.status, 'satisfied')
})

test('an assertion that names both sides and exits 0 satisfies an example', () => {
  const [o] = observeRun([example("foo('a')", "'b'")], { command: `python -c "assert foo('a') == 'b'"`, output: '', exit: 0 })
  assert.equal(o.status, 'satisfied')
})

test('a nonzero exit on a named example contradicts it', () => {
  const [o] = observeRun([example('foo(1)', '2')], { command: 'python -c "print(foo(1))"', output: 'Traceback\nValueError: bad', exit: 1 })
  assert.equal(o.status, 'contradicted')
})

test('a broken environment is an attempt, and says nothing about the code', () => {
  const [o] = observeRun([example('foo(1)', '2')], { command: 'python -c "print(foo(1))"', output: 'bash: python: command not found', exit: 127 })
  assert.equal(o.status, 'attempted')
})

test('running with no output is an attempt, never a pass', () => {
  const [o] = observeRun([example('foo(1)', '2')], { command: 'python -c "foo(1)"', output: '', exit: 0 })
  assert.equal(o.status, 'attempted')
})

test('a command that does not name the example leaves it open', () => {
  const [o] = observeRun([example('foo(1)', '2')], { command: 'npm test', output: 'all passed', exit: 0 })
  assert.equal(o.status, 'open')
})

test('reading a file is no evidence', () => {
  for (const command of ['cat task.md', 'grep -n foo task.md', 'git diff', 'echo 2']) {
    const [o] = observeRun([example('foo(1)', '2')], { command: `${command} foo(1)`, output: 'foo(1) returns 2', exit: 0 })
    assert.equal(o.status, 'open', command)
  }
})

test('two dialects of one input: printing one does not contradict the other', () => {
  const both = [example('q', 'pg(q)'), example('q', 'oracle(q)')]
  const [a, b] = observeRun(both, { command: 'run q', output: 'pg(q)', exit: 0 })
  assert.equal(a.status, 'satisfied')
  assert.equal(b.status, 'attempted')
})

test('an edit reopens earlier evidence', () => {
  const [a, b] = reopen([example('a(', 'b', 'satisfied'), example('c(', 'd', 'contradicted')])
  assert.equal(a.status, 'open')
  assert.equal(b.status, 'open')
})

test('each completion state', () => {
  assert.equal(assessCompletion({ ...evidence, edited: false }), 'none')
  assert.equal(assessCompletion({ ...evidence, lastCheckPassed: null }), 'unverified')
  assert.equal(assessCompletion({ ...evidence, editedSinceCheck: true }), 'unverified')
  assert.equal(assessCompletion({ ...evidence, lastCheckPassed: false }), 'failed')
  assert.equal(assessCompletion({ ...evidence, obligations: [example('a(', 'b', 'contradicted')] }), 'failed')
  assert.equal(assessCompletion({ ...evidence, obligations: [example('a(', 'b', 'attempted')] }), 'partially_verified')
  assert.equal(assessCompletion({ ...evidence, obligations: [example('a(', 'b', 'satisfied'), semantic] }), 'partially_verified')
  assert.equal(assessCompletion({ ...evidence, obligations: [example('a(', 'b', 'satisfied')] }), 'verified')
  assert.equal(assessCompletion(evidence), 'verified')
})

test('a contradiction outranks a later edit gap', () => {
  assert.equal(assessCompletion({ ...evidence, editedSinceCheck: true, obligations: [example('a(', 'b', 'contradicted')] }), 'failed')
})

test('the gate blocks on missing evidence and names what is open', () => {
  const reason = blockReason('partially_verified', [example('foo(1)', '2')], ctx)!
  assert.match(reason, /foo\(1\) -> 2/)
  assert.ok(blockReason('unverified', [], ctx))
  assert.ok(blockReason('failed', [], ctx))
})

test('the gate lets finished work stop', () => {
  assert.equal(blockReason('verified', [example('a(', 'b', 'satisfied')], ctx), null)
  assert.equal(blockReason('none', [], ctx), null)
})

test('a semantic obligation alone never blocks', () => {
  assert.equal(blockReason('partially_verified', [semantic], ctx), null)
})

test('the gate holds at most once, never in report mode, and never over background work', () => {
  assert.equal(blockReason('unverified', [], { ...ctx, blocks: 1 }), null)
  assert.equal(blockReason('unverified', [], { ...ctx, stopHookActive: true }), null)
  assert.equal(blockReason('unverified', [], { ...ctx, gate: 'report' }), null)
  assert.equal(blockReason('unverified', [], { ...ctx, gate: 'off' }), null)
  assert.equal(blockReason('unverified', [], { ...ctx, backgroundWork: 1 }), null)
})

test('a long list is cut, and says how much is left', () => {
  const many = Array.from({ length: 12 }, (_, i) => example(`foo(${i})`, `${i}`))
  assert.match(blockReason('partially_verified', many, ctx)!, /and 4 more/)
})

test('a record holds no text from the request', () => {
  const [pub] = publicObligations([{ ...example('secret(1)', 'secret-out'), id: 'abc' }])
  assert.equal(JSON.stringify(pub).includes('secret'), false)
  assert.deepEqual(Object.keys(pub).sort(), ['id', 'kind', 'status'])
})

test('a described result is a requirement, not a printable example', () => {
  // Found live: every check that named _undefined_obj read as a contradiction, and the gate blocked a finished task.
  const os = extractObligations("copy.deepcopy(undef)._undefined_obj must be a separate list equal to ['foo'].")
  assert.deepEqual(os.map((o) => o.kind), ['semantic'])
  // A stated value still makes an example.
  assert.deepEqual(extractObligations("parse('a') must return ['a'].").map((o) => [o.kind, o.expected]), [['example', "['a']"]])
})
