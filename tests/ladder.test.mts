// The escalation inputs and the ladder's evidence (lib/failures.ts, lib/shell.ts): check detection on a command corpus,
// weak and strong evidence, and regressions.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_LADDER, onlyMissingTools, classify, failKey, checkKey, checkPassed, masked, escalation, failingTests, failureOf, isCheck, isRevert, notRun, regression, workLost, reviewerBlocked, scopeGrew, writesFiles } from '../hooks/lib/failures.ts'
import { simpleCommands, tools, unwrapped } from '../hooks/lib/shell.ts'

const CHECKS = [
  'go test ./...', 'npm test', 'npm t', 'npm run lint', 'npm run test:unit', 'npm --prefix web test', 'npm -w api run typecheck', 'pnpm test', 'pnpm run e2e', 'yarn test', 'yarn run lint', 'bun test', 'bun run test',
  // wrappers
  'timeout 60 npm test', 'gtimeout -k 5 300s go test ./...', 'FOO=1 npm test', 'CI=true NODE_ENV="test" npx jest', 'env FOO=1 pytest', 'env -u X go vet ./...', 'time cargo test', 'nice -n 5 make test', 'xvfb-run -a npm test', 'sudo make check',
  // python launchers and virtual environments
  'python3 -m pytest', 'python -m pytest tests', 'python3.12 -m pytest -x', 'python -B -m pytest', 'python3 -m unittest discover', 'python3 -m mypy src', '.venv/bin/pytest', './venv/bin/python -m pytest', 'venv/bin/ruff check .', 'uv run pytest', 'poetry run pytest -q', 'pipenv run pytest', 'hatch run test:pytest', 'conda run -n env pytest', 'python manage.py test', 'py.test', 'tox', 'nox -s tests',
  // npx and node_modules
  'npx mocha', 'npx --yes vitest run', 'npx -y tsc --noEmit', 'npx eslint .', 'npx playwright test', 'npx -p typescript tsc', './node_modules/.bin/jest', 'node_modules/.bin/vitest run', 'pnpm exec tsc', 'yarn dlx eslint .', 'bunx vitest', 'npx cypress run',
  // other runners
  'cargo clippy', 'cargo +nightly test', 'cargo nextest run', 'mvn -q test', 'mvn clean verify', './mvnw test', './gradlew test', 'gradle clean build', 'make -j4 test', 'make -C src check', 'rake test', 'bundle exec rspec', 'dotnet test', 'swift test', 'deno test', 'mix test', 'flutter test', 'ctest', 'phpunit', 'node --test', 'node --experimental-strip-types --test tests/', 'prettier --check .', 'black --check src', 'biome check .', 'flake8', 'pylint src', 'pyright', 'shellcheck run.sh', 'golangci-lint run',
  // lines
  'cd api && npm test', 'source .venv/bin/activate && pytest', 'npm ci && npm test', 'pytest | tail -20', 'go test ./... 2>&1 | head', 'set -o pipefail; npm test | tail', '(cd web && npm test)', 'bash -c "npm test"', "sh -lc 'pytest -q'", 'npm test || true',
]
const NOT_CHECKS = [
  'ls -la', 'cat pytest.ini', 'echo "npm test"', 'echo pytest', 'grep -r "go test" .', 'rg pytest', 'git log --grep pytest', 'git commit -m "run npm test"', 'which pytest', 'pip install pytest', 'npm install', 'npm run dev', 'npm start', 'yarn install', 'python3 script.py', 'python -m http.server', 'make install', 'node server.js', 'npx prisma generate', 'pytest --version', 'tsc --help', 'pytest --collect-only', 'go mod tidy', 'cargo run', 'mvn package', 'prettier --write .', 'black src', 'docker build .', 'FOO=1 npm start',
]

test('check detection: every runner, through wrappers, env prefixes, venvs, python -m and npx', () => {
  for (const c of CHECKS) assert.equal(isCheck(c), true, c)
})

test('check detection: a command that only names a check is not one', () => {
  for (const c of NOT_CHECKS) assert.equal(isCheck(c), false, c)
})

test('check detection: a heredoc body is data', () => {
  assert.equal(isCheck('cat > run.sh <<EOF\nnpm test\nEOF'), false)
})

test('check detection: a failed match stays fast, because it runs before the tool call', () => {
  const t0 = performance.now()
  for (const c of [`npm ${'--x '.repeat(40)}!`, `pnpm ${'-x '.repeat(40)}!`, `yarn ${'--x=1 '.repeat(40)}!`, `npm run ${'--x '.repeat(40)}!`, `env ${'-u '.repeat(40)}x`, `timeout ${'-k '.repeat(40)}x`, `timeout ${'--x '.repeat(40)}x`, `sudo ${'-u '.repeat(40)}x`, `make ${'-j '.repeat(40)}!`]) assert.equal(isCheck(c), false, c)
  assert.ok(performance.now() - t0 < 100, 'no exponential backtracking')
})

test('shell: splits outside quotes and keeps a redirect whole', () => {
  assert.deepEqual(simpleCommands('a && b; c | d'), ['a', 'b', 'c', 'd'])
  assert.deepEqual(simpleCommands('echo "a; b" && c'), ['echo "a; b"', 'c'])
  assert.deepEqual(simpleCommands('go test 2>&1 | head'), ['go test 2>&1', 'head'])
  assert.equal(unwrapped('FOO=1 timeout 60 .venv/bin/python -m pytest -x'), 'pytest -x')
  assert.deepEqual(tools('bash -c "cd a && npm test"'), ['cd a', 'npm test'])
})

const base = { ...EMPTY_LADDER, effortCapped: false }
const fail = (at: number, edited: boolean, out = '--- FAIL: TestX (0.00s)\nFAIL', command = 'go test ./...') => failureOf(command, 1, out, at, edited)

test('escalation: a first repeat after an edit is weak; the first failure and an unedited rerun are nothing', () => {
  const a = fail(1, true), b = fail(2, true)
  assert.equal(escalation([a], base).level, 'none')
  assert.equal(escalation([a, fail(2, false)], base).level, 'none', 'a rerun with no edit is no failed repair')
  const e = escalation([a, b], base)
  assert.equal(e.level, 'weak')
  assert.equal(e.check, true)
  assert.equal(e.fingerprint, a.fingerprint)
})

test('escalation: the repeat after an effort raise is strong, and each repeat acts once', () => {
  const a = fail(1, true), b = fail(2, true), c = fail(3, true)
  const raised = { [a.fingerprint]: 2 }
  assert.equal(escalation([a, b], { ...base, raised }).level, 'none', 'no new failure since the raise')
  const e = escalation([a, b, c], { ...base, raised })
  assert.equal(e.level, 'strong')
  assert.equal(escalation([a, b, c], { ...base, raised, fired: [e.key] }).level, 'none')
  assert.equal(escalation([a, b, c, fail(4, true)], { ...base, raised, fired: [e.key] }).level, 'strong')
})

test('escalation: with no effort step left, the first repeat is strong', () => {
  assert.equal(escalation([fail(1, true), fail(2, true)], { ...base, effortCapped: true }).level, 'strong')
})

test('escalation: three tool errors and scope growth are weak, and act once', () => {
  assert.equal(escalation([], { ...base, toolErrors: 2 }).level, 'none')
  assert.equal(escalation([], { ...base, toolErrors: 3 }).level, 'weak')
  assert.equal(escalation([], { ...base, toolErrors: 3, fired: ['tools'] }).level, 'none')
  assert.equal(escalation([], { ...base, scopeGrew: true }).level, 'weak')
  assert.equal(escalation([], { ...base, scopeGrew: true }).check, false)
})

test('escalation: a revert and a reviewer blocker are strong, and each new one acts again', () => {
  assert.equal(escalation([], { ...base, reverts: 1 }).level, 'strong')
  assert.equal(escalation([], { ...base, reviewerBlockers: 1 }).level, 'strong')
  assert.equal(escalation([], { ...base, reviewerBlockers: 1, fired: ['reviewer:1'] }).level, 'none')
  assert.equal(escalation([], { ...base, reviewerBlockers: 2, fired: ['reviewer:1'] }).level, 'strong')
})

test('escalation: an environment failure or a flaky check is no evidence about the model', () => {
  const env = (at: number) => failureOf('go test ./...', 127, 'bash: go: command not found', at, true)
  assert.equal(escalation([env(1), env(2), env(3)], base).level, 'none')
  const a = fail(1, true), b = { ...fail(2, true), class: 'flaky' as const }
  assert.equal(escalation([a, b], base).level, 'none')
})

test('escalation: a fired strong cause does not hide weaker evidence', () => {
  const e = escalation([], { ...base, reverts: 1, fired: ['revert:1'], toolErrors: 3 })
  assert.equal(e.level, 'weak')
})

test('regression: a check that passed and now fails after a code edit, but not after a new test alone', () => {
  const f = fail(10, true)
  assert.equal(regression([f], { passed: {} }), null, 'never passed: ordinary work')
  assert.equal(regression([f], { passed: { 'go test ./...': 5 }, editedSincePass: () => ['src/a.go'] }), 'test')
  assert.equal(regression([f], { passed: { 'go test ./...': 5 }, editedSincePass: () => ['src/a_test.go'.replace('_test', '.test')] }), null)
  assert.equal(regression([f], { passed: { 'go test ./...': 5 }, editedSincePass: () => ['tests/a.py'] }), null, 'a test first, then the fix')
  assert.equal(regression([fail(10, false)], { passed: { 'go test ./...': 5 } }), null, 'no edit: not this repair')
})

test('regression: a failure whose own command passed after it is history', () => {
  const f = fail(10, true)
  assert.equal(regression([f], { passed: { 'go test ./...': 20 }, editedSincePass: () => [] }), null, 'failed, fixed, passed')
  assert.equal(escalation([fail(1, true), f], { ...base, passed: { 'go test ./...': 20 } }).level, 'none', 'a fixed repeat is no evidence now')
  assert.equal(escalation([f], { ...base, passed: { 'go test ./...': 20 }, toolErrors: 3 }).level, 'weak', 'tool errors alone stay weak')
  assert.equal(regression([f], { passed: { 'go test ./...': 10 }, editedSincePass: () => ['src/a.go'] }), null, 'the pass must come before the failure')
})

test('regression: a compile error where tests ran before; tests that newly fail', () => {
  const tests = fail(1, true)
  const broken = fail(2, true, 'src/a.ts(1,1): error TS2304: Cannot find name x')
  assert.equal(regression([tests, broken], { passed: {} }), 'compile')
  assert.equal(regression([broken, fail(3, true, 'src/a.ts(2,1): error TS2322: bad')], { passed: {} }), null, 'still broken: not a regression')
  const more = fail(2, true, '--- FAIL: TestX (0.00s)\n--- FAIL: TestY (0.00s)\nFAIL')
  assert.equal(regression([tests, more], { passed: {} }), 'test')
  assert.equal(regression([more, fail(3, true)], { passed: {} }), null, 'fewer failures is progress')
})

test('escalation: a regression is strong on its first failure', () => {
  const e = escalation([fail(10, true)], { ...base, passed: { 'go test ./...': 5 }, editedSincePass: () => ['src/a.go'] })
  assert.equal(e.level, 'strong')
  assert.equal(e.check, true)
})

test('signals: reverts, reviewer verdicts and scope', () => {
  for (const c of ['git revert HEAD', 'git reset --hard', 'git reset --hard HEAD~1', 'git checkout -- .', 'git checkout .', 'git restore .', 'git restore a.go', 'cd a && git revert abc']) assert.equal(isRevert(c), true, c)
  for (const c of ['git status', 'git reset HEAD a.go', 'git restore --staged .', 'git checkout main', 'git checkout -b x', 'git restore --staged a.go', 'echo git revert']) assert.equal(isRevert(c), false, c)
  assert.equal(reviewerBlocked('Verdict: changes_required\n- blocker a.ts:1'), true)
  assert.equal(reviewerBlocked('Verdict: approve_with_notes'), false)
  assert.equal(scopeGrew(['a', 'b', 'c', 'd'], new Set(['z']), 4, 8), true, 'four outside the discovered set')
  assert.equal(scopeGrew(['a', 'b', 'c', 'z'], new Set(['z']), 4, 8), false)
  assert.equal(scopeGrew(['a', 'b', 'c', 'd'], new Set(), 4, 8), false, 'no discovery data: only a large change counts')
  assert.equal(scopeGrew(Array.from({ length: 9 }, (_, i) => `f${i}`), new Set(), 4, 8), true)
})

test('python unittest: failed tests are a defect even with an environment-looking line after them', () => {
  // rescue-delivery, sqlglot: the runner printed FAILED (failures=3), then a version helper printed "No module named".
  const out = "FAIL: test_x (tests.test_parser.TestParser.test_x)\nAssertionError: 1 != 2\n----\nRan 1542 tests in 76.997s\n\nFAILED (failures=3, errors=1, skipped=2)\nsqlglotc: failed to determine the sqlglot version to pin: No module named 'setuptools_scm'"
  const f = failureOf('python3 -m unittest discover -s tests -t .', 1, out, 1, true)!
  assert.equal(f.class, 'defect')
  assert.deepEqual(f.tests, ['tests.test_parser.TestParser.test_x'])
  assert.deepEqual(failingTests('ERROR: test_y (tests.test_a.T)\n'), ['tests.test_a.T.test_y'])
  // A test that raised, with the same stray line, is a defect too (rescue-delivery, sqlglot, second run).
  assert.equal(failureOf('python3 -m unittest discover', 1, "Ran 1542 tests in 77.6s\n\nFAILED (errors=1, skipped=2)\nsqlglotc: failed to determine the sqlglot version to pin: No module named 'setuptools_scm'", 1, true)!.class, 'defect')
  // Errors alone from a missing module are still the environment.
  assert.equal(failureOf('python3 -m unittest', 1, "ERROR: test_a (tests.test_x.T.test_a)\nModuleNotFoundError: No module named 'yaml'\nFAILED (errors=4)", 1, true)!.class, 'environment')
  // A masked unittest run is read from its own summary line.
  assert.equal(checkPassed('python3 -m unittest 2>&1 | tail -5', 0, false, 'Ran 3 tests\n\nFAILED (failures=1)'), false)
})

test('checkKey: the check commands alone, so edits and wrappers beside them do not make a new failure', () => {
  assert.equal(checkKey('PYTHONPATH=.:.bench-deps timeout 900 python3 -m unittest discover -s tests -t . 2>&1 | tail -80'), 'unittest discover -s tests -t .')
  assert.equal(checkKey("export PYTHONPATH=.; sed -i '' 's/a/b/' p.py; python3 -m unittest discover -s tests -t . 2>&1 | tail -5"), 'unittest discover -s tests -t .')
  assert.equal(checkKey('go test ./...'), 'go test ./...')
})

test('writesFiles: edits through Bash count, reads and scratch writes do not', () => {
  for (const c of ["sed -i '' 's/a/b/' x.py", "python3 - <<'EOF'\nopen('a.py', 'w').write(s)\nEOF", "cat >> tests/t.py <<'E'\nx\nE", 'git apply fix.diff', 'echo x > src/a.ts'])
    assert.equal(writesFiles(c), true, c)
  for (const c of ['git diff > /tmp/x.diff', 'python3 -m unittest 2>&1 | tail -3', 'grep -n foo a.py', 'echo hi > /dev/null', "python3 - <<'EOF'\nprint(1)\nEOF"])
    assert.equal(writesFiles(c), false, c)
})

test('escalation: the same check failing 3 times after edits, each time in a new way, is a repeat of the check', () => {
  const f = (at: number, fp: string) => ({ fingerprint: fp, class: 'defect' as const, command: 'unittest discover', exitCode: 1, at, editedSince: true, evidence: fp })
  const s = { ...EMPTY_LADDER, effortCapped: false }
  assert.equal(escalation([f(1, 'a'), f(2, 'b')], s).level, 'none')
  const third = escalation([f(1, 'a'), f(2, 'b'), f(3, 'c')], s)
  assert.equal(third.level, 'weak')
  assert.match(third.fingerprint!, /^cmd:/)
  assert.equal(third.count, 3)
  // After that raise, a fourth failure of the check is strong.
  const raised = { ...s, fired: [third.key], raised: { [third.fingerprint!]: 3 } }
  assert.equal(escalation([f(1, 'a'), f(2, 'b'), f(3, 'c'), f(4, 'd')], raised).level, 'strong')
  // A pass of the check in between starts the count again: the failure after it is a regression, not a third try.
  assert.doesNotMatch(escalation([f(1, 'a'), f(2, 'b'), f(4, 'c')], { ...s, passed: { 'unittest discover': 3 } }).because, /times after edits/)
})

test('escalation: a stop the gate sent back on a failing check is strong evidence, once per stop', () => {
  const s = { ...EMPTY_LADDER, effortCapped: false, stops: 1 }
  const e = escalation([], s)
  assert.equal(e.level, 'strong')
  assert.equal(e.cause, 'stop')
  assert.equal(escalation([], { ...s, fired: [e.key] }).level, 'none')
  assert.equal(escalation([], { ...s, fired: [e.key], stops: 2 }).level, 'strong')
})

test('escalation when patient (Haiku first): repeats alone never escalate; a regression still does', () => {
  const f = (at: number, fp: string, o: Record<string, unknown> = {}) => ({ fingerprint: fp, class: 'defect' as const, command: 'vitest run', exitCode: 1, at, editedSince: true, evidence: fp, ...o })
  const capped = { ...EMPTY_LADDER, effortCapped: true }
  assert.equal(escalation([f(1, 'a'), f(2, 'a')], capped).level, 'strong', 'impatient: the first repeat at the top effort moves the model')
  assert.notEqual(escalation([f(1, 'a'), f(2, 'a')], { ...capped, patient: true }).level, 'strong', 'patient: the write-test, fail, fix loop is not evidence')
  assert.notEqual(escalation([f(1, 'a'), f(2, 'b'), f(3, 'c')], { ...capped, patient: true }).level, 'strong')
  assert.equal(escalation([f(5, 'a', { tests: ['parses a'] })], { ...capped, patient: true, passed: { 'vitest run': 3 } }).level, 'strong', 'a regression still escalates')
  // Found live: `npm run build; node probe.mjs` exited 1 on the probe's TypeError, and read as a test regression.
  assert.notEqual(escalation([f(5, 'TypeError: x is undefined')], { ...capped, patient: true, passed: { 'vitest run': 3 } }).level, 'strong', 'an exit code with no failing test is not a regression')
  assert.equal(escalation([], { ...capped, patient: true, stops: 1 }).level, 'strong', 'a failed stop still escalates')
})

test('workLost reads the tree after a revert command', () => {
  assert.equal(workLost(['## main\n M a.ts\n', '## main\n?? new.ts\n']), false)
  assert.equal(workLost(['## main\n M a.ts\n', '## main\n']), true) // one edited file lost its change
  assert.equal(workLost(['']), true) // a failed git call keeps the old behavior
})

test('a check that never ran is not a pass', () => {
  // Found live: zsh printed `command not found: python`, and the trailing echo made the command exit 0.
  const cmd = '(python -m pytest tests -q 2>&1 | tail -25); echo "exit=$?"'
  assert.equal(masked(cmd), true)
  assert.equal(checkPassed(cmd, 0, false, '(eval):1: command not found: python\nexit=127'), false)
  assert.equal(notRun('sh: 1: pytest: not found'), true)
  assert.equal(notRun('12 passed in 0.4s'), false)
  assert.equal(checkPassed('(pytest | tail); echo "exit=$?"', 0, false, '12 passed in 0.4s\nexit=0'), true)
})

test('a clean suite beside a failing command is not the suite failing', () => {
  // Found live: pytest printed 100 passed, and the old doctests run after it set the exit code.
  const cmd = 'python3 -m pytest -q tests 2>&1 | tail -30; echo ---; python3 -m doctest -v xmltodict.py 2>&1 | tail -3'
  assert.equal(checkKey(cmd), 'pytest -q tests')
  assert.notEqual(failKey(cmd, '....\n100 passed in 0.24s\n---\n5 passed and 5 failed.\n***Test Failed*** 5 failures.'), checkKey(cmd))
  assert.equal(failKey(cmd, '2 failed, 98 passed in 0.3s\nFAILED tests/t.py::test_a'), checkKey(cmd))
  assert.equal(failKey('pytest -q', '100 passed in 0.2s'), 'pytest -q')
})

test('a test that errors on a program the machine lacks is the environment', () => {
  // Found live: sqlglot's test_lazy_load runs `python`, the machine has only python3, and the gate climbed to Opus on it.
  const lazy = "ERROR: test_lazy_load (tests.dialects.test_dialect.TestDialect)\nTraceback (most recent call last):\nFileNotFoundError: [Errno 2] No such file or directory: 'python'\n\nRan 1548 tests in 75s\n\nFAILED (errors=1, skipped=2)"
  assert.equal(onlyMissingTools(lazy), true)
  assert.equal(classify(lazy), 'environment')
  // A real assertion failure beside it is still a defect.
  assert.equal(classify(lazy.replace('FAILED (errors=1, skipped=2)', 'FAIL: test_x (t.T)\nFAILED (failures=1, errors=1)')), 'defect')
  // A missing data file, with a path, is the work's own error.
  assert.equal(onlyMissingTools(lazy.replace("'python'", "'tests/fixtures/a.sql'")), false)
})
