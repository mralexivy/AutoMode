import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { codeBlocks, compareArms, runCheck, runJs, scoreCase } from './lib/style-check.mts'

const cases = JSON.parse(fs.readFileSync(new URL('./style-cases.json', import.meta.url), 'utf8')).cases

test('every case has a unique id, a group, a prompt and known checks', () => {
  assert.equal(new Set(cases.map((c) => c.id)).size, cases.length)
  for (const c of cases) {
    assert.ok(c.group && c.prompt && c.checks.length, c.id)
    for (const k of c.checks) assert.doesNotThrow(() => runCheck(k, 'x'), `${c.id} ${k.type}`)
  }
})

test('code blocks are extracted with their language', () => {
  const b = codeBlocks('text\n```js\nconsole.log(5)\n```\nmore\n```\nls\n```')
  assert.deepEqual(b.map((x) => x.lang), ['js', ''])
})

test('runJs runs code in the sandbox and reads stdout', () => {
  assert.equal(runJs('```js\nconsole.log(2 + 3)\n```').stdout, '5')
})

test('runJs refuses file reads and child processes', () => {
  assert.equal(runJs('```js\nrequire("fs").readFileSync("/etc/hosts")\n```').ok, false)
  assert.equal(runJs('```js\nrequire("child_process").execSync("echo hi")\n```').ok, false)
})

test('has and verbatim are exact, and verbatim keeps em dashes', () => {
  assert.equal(runCheck({ type: 'has', all: ['git reset --soft HEAD~1'] }, 'Run `git reset --soft HEAD~1`.').ok, true)
  assert.equal(runCheck({ type: 'has', all: ['git reset --soft HEAD~1'] }, 'Run git reset --soft HEAD~2').ok, false)
  assert.equal(runCheck({ type: 'verbatim', text: 'a — b' }, 'a — b').ok, true)
  assert.equal(runCheck({ type: 'verbatim', text: 'a — b' }, 'a, b').ok, false)
})

test('facts report recall', () => {
  const r = runCheck({ type: 'facts', patterns: ['alpha', 'beta', 'gamma'], min: 0.6 }, 'alpha and beta')
  assert.equal(r.recall, 2 / 3)
  assert.equal(r.ok, true)
})

test('scoreCase passes a good code answer and fails a damaged one', () => {
  const c = cases.find((x) => x.id === 'code-js-sum')
  assert.equal(scoreCase(c, '```js\nconst sum = (a, b) => a + b\nconsole.log(sum(2, 3))\n```').ok, true)
  assert.equal(scoreCase(c, '```js\nconst sum = (a, b) => a - b\nconsole.log(sum(2, 3))\n```').ok, false)
})

test('compareArms flags a hard case that the style broke and ignores one the control also fails', () => {
  const row = (caseId, arm, ok, outTokens, hard = true, recall = null) => ({ caseId, group: 'code', hard, arm, ok, outTokens, recall })
  const v = compareArms([
    row('a', 'control', true, 100), row('a', 'control', true, 100), row('a', 'style', true, 60), row('a', 'style', false, 60),
    row('b', 'control', false, 100), row('b', 'style', false, 50),
  ])
  assert.deepEqual(v.regressions.map((r) => r.caseId), ['a'])
  assert.equal(v.safe, false)
  assert.ok(Math.abs(v.tokens.totalRatio - 0.55) < 1e-9)
})

test('compareArms is safe when nothing regresses and recall drops by 0.1 or less', () => {
  const row = (arm, recall) => ({ caseId: 'f', group: 'facts', hard: false, arm, ok: true, outTokens: arm === 'style' ? 40 : 100, recall })
  const v = compareArms([row('control', 1), row('style', 0.95)])
  assert.equal(v.safe, true)
  assert.ok(Math.abs(v.factRecall.drop - 0.05) < 1e-9)
})
