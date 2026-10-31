// The escalation inputs and the ladder's evidence (lib/failures.ts, lib/shell.ts): check detection on a command corpus,
// weak and strong evidence, and regressions.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_LADDER, escalation, failureOf, isCheck, isRevert, regression, reviewerBlocked, scopeGrew } from '../hooks/lib/failures.ts'
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
  for (const c of ['git revert HEAD', 'git reset --hard', 'git reset --hard HEAD~1', 'git checkout -- .', 'git checkout .', 'git restore .', 'cd a && git revert abc']) assert.equal(isRevert(c), true, c)
  for (const c of ['git status', 'git reset HEAD a.go', 'git restore --staged .', 'git checkout main', 'git checkout -b x', 'git restore a.go', 'echo git revert']) assert.equal(isRevert(c), false, c)
  assert.equal(reviewerBlocked('Verdict: changes_required\n- blocker a.ts:1'), true)
  assert.equal(reviewerBlocked('Verdict: approve_with_notes'), false)
  assert.equal(scopeGrew(['a', 'b', 'c', 'd'], new Set(['z']), 4, 8), true, 'four outside the discovered set')
  assert.equal(scopeGrew(['a', 'b', 'c', 'z'], new Set(['z']), 4, 8), false)
  assert.equal(scopeGrew(['a', 'b', 'c', 'd'], new Set(), 4, 8), false, 'no discovery data: only a large change counts')
  assert.equal(scopeGrew(Array.from({ length: 9 }, (_, i) => `f${i}`), new Set(), 4, 8), true)
})
