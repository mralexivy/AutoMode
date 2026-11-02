// Tests for the held-out split. The committed split file must match its own rule, so nobody can move a task by hand.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { rankBySha, splitHeldout } from './lib/split.mts'
import { sha256 } from './lib/prompt.mts'
import { loadTasks } from './lib/task-repo.mts'
import { HELDOUT, namedTasks } from './split.mts'

test('rankBySha sorts by the hash of the id, not the id', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']
  const ranked = rankBySha(ids)
  assert.deepEqual(ranked.map(sha256), [...ids.map(sha256)].sort())
  assert.deepEqual(rankBySha([...ids].reverse()), ranked, 'input order plays no part')
})

test('splitHeldout alternates by rank and caps each repository per set', () => {
  const one = Array.from({ length: 4 }, (_, i) => ({ id: `t${i}`, repo: `r${i}` }))
  const s = splitHeldout(one)
  const ranked = rankBySha(one.map((c) => c.id))
  assert.deepEqual(s.screen, [ranked[0], ranked[2]])
  assert.deepEqual(s.confirm, [ranked[1], ranked[3]])
  const same = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, repo: 'r' }))
  const capped = splitHeldout(same)
  assert.equal(capped.screen.length, 3)
  assert.equal(capped.confirm.length, 3)
  assert.equal(capped.excluded.length, 2)
  assert.deepEqual(splitHeldout([...same].reverse()), capped, 'the split is deterministic')
})

test('the committed split matches its rule, names real tasks, and joins no experiment', () => {
  if (!fs.existsSync(HELDOUT)) return
  const doc = JSON.parse(fs.readFileSync(HELDOUT, 'utf8'))
  const tasks = new Map(loadTasks().map((t) => [t.id, t]))
  const ids = [...doc.screen, ...doc.confirm, ...doc.excluded]
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(doc.candidates, ids.length)
  for (const id of ids) assert.ok(tasks.has(id), id)
  assert.match(doc.git_sha, /^[0-9a-f]{40}$/)
  assert.match(doc.date, /^\d{4}-\d{2}-\d{2}$/)
  const again = splitHeldout(ids.map((id) => ({ id, repo: tasks.get(id).repo })), doc.max_per_repo)
  assert.deepEqual({ screen: doc.screen, confirm: doc.confirm, excluded: doc.excluded }, again)
  const named = namedTasks()
  for (const id of ids) assert.ok(!named.has(id), `${id} is already in an experiment`)
})
