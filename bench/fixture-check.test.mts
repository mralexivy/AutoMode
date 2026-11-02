// Tests for the pure parts of the fixture check. One patch built here also goes through a real `git apply`, so a
// header the tests accept is one git accepts too.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { kindOf, parseDiff, pathOf, pickHunks, renderDiff, score, withoutHunk, type HunkResult } from './lib/fixture-check.mts'

const DIFF = `diff --git a/src/a.py b/src/a.py
index 1111111..2222222 100644
--- a/src/a.py
+++ b/src/a.py
@@ -1,3 +1,4 @@ def top():
 one
+added
 two
 three
@@ -10,3 +11,3 @@ def low():
 ten
-eleven
+ELEVEN
 twelve
diff --git a/src/new file.py b/src/new file.py
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new file.py
@@ -0,0 +1,2 @@
+x = 1
+y = 2
diff --git a/tests/test_a.py b/tests/test_a.py
index 4444444..5555555 100644
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1 +1,2 @@
 import a
+assert a
diff --git a/CHANGELOG.md b/CHANGELOG.md
index 6666666..7777777 100644
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -1 +1,2 @@
 # Changes
+- fix
`

test('parseDiff reads files, flags and hunk headers, and renderDiff writes the same text back', () => {
  const files = parseDiff(DIFF)
  assert.deepEqual(files.map((f) => f.path), ['src/a.py', 'src/new file.py', 'tests/test_a.py', 'CHANGELOG.md'])
  assert.equal(files[0].hunks.length, 2)
  assert.deepEqual([files[0].hunks[1].oldStart, files[0].hunks[1].oldLines, files[0].hunks[1].newStart, files[0].hunks[1].newLines], [10, 3, 11, 3])
  assert.equal(files[1].isNew, true)
  assert.deepEqual([files[2].hunks[0].oldLines, files[2].hunks[0].newLines], [1, 2], 'a missing count means one line')
  assert.equal(renderDiff(files).replace('@@ -1,1 +1,2 @@', '@@ -1 +1,2 @@').replace('@@ -1,1 +1,2 @@', '@@ -1 +1,2 @@'), DIFF)
  assert.equal(pathOf('diff --git a/x y/z b/x y/z'), 'x y/z')
})

test('withoutHunk leaves one hunk out, shifts later hunks, and drops a new file whole', () => {
  const files = parseDiff(DIFF)
  const first = withoutHunk(files, 0, 0)
  assert.ok(!first.includes('+added'))
  assert.ok(first.includes('@@ -10,3 +10,3 @@ def low():'), 'the later hunk moves up by the one added line')
  const second = withoutHunk(files, 0, 1)
  assert.ok(first.includes('+ELEVEN') && !second.includes('+ELEVEN') && second.includes('+added'))
  const noNew = withoutHunk(files, 1, 0)
  assert.ok(!noNew.includes('new file.py'))
  assert.ok(noNew.includes('tests/test_a.py'), 'other files stay whole')
})

test('kindOf keeps hidden tests and docs out of the mutants', () => {
  const hidden = ['tests/test_a.py']
  assert.equal(kindOf('tests/test_a.py', hidden), 'hidden')
  for (const p of ['CHANGELOG.md', 'docs/api.py', 'README.rst', 'CHANGES']) assert.equal(kindOf(p, hidden), 'docs', p)
  assert.equal(kindOf('src/a.py', hidden), 'code')
  assert.equal(kindOf('tests/test_b.py', hidden), 'code', 'a test the task does not hide is part of the change')
})

test('pickHunks takes one hunk per file in turn and stops at the cap', () => {
  const files = parseDiff(DIFF)
  const all = pickHunks(files, ['tests/test_a.py'], 12)
  assert.equal(all.total, 3)
  assert.deepEqual(all.picked.map((h) => `${h.file}:${h.hunk}`), ['0:0', '1:0', '0:1'])
  const capped = pickHunks(files, ['tests/test_a.py'], 2)
  assert.deepEqual(capped.picked.map((h) => h.path), ['src/a.py', 'src/new file.py'], 'the cap still reaches every file first')
})

test('score counts only verdicts, and a task with no killed hunk is weak', () => {
  const r = (p: string, verdict: HunkResult['verdict']): HunkResult => ({ file: 0, hunk: 0, path: p, header: '@@', verdict })
  const s = score([r('a', 'killed'), r('a', 'survived'), r('b', 'survived'), r('b', 'timeout'), r('c', 'apply_failed')], ['a', 'b', 'c', 'd'])
  assert.deepEqual(s, { tested: 3, killed: 1, kill_rate: 0.333, coverage: 0.25, weak: false })
  assert.equal(score([r('a', 'survived')], ['a']).weak, true)
  assert.deepEqual(score([], []), { tested: 0, killed: 0, kill_rate: null, coverage: null, weak: true })
})

test('a patch with one hunk left out applies with git', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-'))
  try {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`)
    fs.writeFileSync(path.join(dir, 'f.txt'), `${before.join('\n')}\n`)
    git('init', '-q')
    git('add', '-A')
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base')
    const after = [...before]
    after.splice(2, 0, 'new A', 'new B')
    after[27] = 'changed'
    fs.writeFileSync(path.join(dir, 'f.txt'), `${after.join('\n')}\n`)
    fs.writeFileSync(path.join(dir, 'g.txt'), 'fresh\n')
    git('add', '-A')
    const files = parseDiff(git('diff', '--cached', '--no-renames', '--full-index'))
    assert.equal(files[0].hunks.length, 2)
    git('reset', '-q', '--hard')
    git('clean', '-q', '-fd')
    const patch = path.join(dir, '..', `${path.basename(dir)}.patch`)
    fs.writeFileSync(patch, withoutHunk(files, 0, 0))
    const applied = spawnSync('git', ['apply', patch], { cwd: dir, encoding: 'utf8' })
    fs.rmSync(patch, { force: true })
    assert.equal(applied.status, 0, applied.stderr)
    const got = fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')
    assert.ok(!got.includes('new A') && got.includes('changed'))
    assert.ok(fs.existsSync(path.join(dir, 'g.txt')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
