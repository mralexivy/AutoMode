import test from 'node:test'
import assert from 'node:assert/strict'
import { nextSignal } from '../hooks/lib/records.ts'
import { EMPTY_LEARNED, bucketOf, noteTask, opusBuckets, opusFirst, parseLearned, type Learned, type LearnedTask } from '../hooks/lib/learn.ts'

const NOW = 1_000 * 86_400_000
const b = bucketOf('T3', 'opus')
const task = (id: string, outcome: LearnedTask['outcome'], o: Partial<LearnedTask> = {}): LearnedTask => ({ id, bucket: b, family: 'sonnet', outcome, at: NOW, ...o })
const fill = (...ts: LearnedTask[]): Learned => ts.reduce(noteTask, EMPTY_LEARNED)

test('one failure teaches nothing, and two in a row move the bucket to Opus', () => {
  assert.equal(opusFirst(fill(task('a', 'bad')), b, NOW), false)
  assert.equal(opusFirst(fill(task('a', 'bad'), task('b', 'bad')), b, NOW), true)
})

test('a bucket that mostly works stays on the cheaper model', () => {
  const l = fill(task('a', 'bad'), task('b', 'bad'), ...['c', 'd', 'e', 'f'].map((id) => task(id, 'ok')))
  assert.equal(opusFirst(l, b, NOW), false)
})

test('old evidence ages out, so the bucket gets another try', () => {
  const l = fill(task('a', 'bad'), task('b', 'bad'))
  assert.equal(opusFirst(l, b, NOW + 29 * 86_400_000), true)
  assert.equal(opusFirst(l, b, NOW + 31 * 86_400_000), false)
})

test('a task that started on Opus says nothing about Sonnet', () => {
  assert.equal(opusFirst(fill(task('a', 'bad', { family: 'opus' }), task('b', 'bad', { family: 'opus' })), b, NOW), false)
})

test('noteTask keeps the first family, and a bad outcome stands', () => {
  const l = fill(task('a', 'open'), task('a', 'ok', { family: 'opus' }), task('a', 'bad'), task('a', 'ok'))
  assert.equal(l.tasks.length, 1)
  assert.equal(l.tasks[0].family, 'sonnet')
  assert.equal(l.tasks[0].outcome, 'bad')
})

test('an open note never erases an outcome', () => {
  assert.equal(fill(task('a', 'ok'), task('a', 'open')).tasks[0].outcome, 'ok')
})

test('open tasks do not count', () => {
  assert.equal(opusFirst(fill(task('a', 'open'), task('b', 'open'), task('c', 'open')), b, NOW), false)
})

test('the file stays bounded', () => {
  const l = fill(...Array.from({ length: 250 }, (_, i) => task(`t${i}`, 'ok')))
  assert.equal(l.tasks.length, 200)
  assert.equal(l.tasks[0].id, 't50')
})

test('a broken or foreign file starts empty', () => {
  assert.deepEqual(parseLearned('not json'), EMPTY_LEARNED)
  assert.deepEqual(parseLearned('{"v":2,"tasks":[]}'), EMPTY_LEARNED)
  assert.equal(parseLearned('{"v":1,"tasks":[{"id":"a"},{"id":"b","bucket":"x","family":"sonnet","outcome":"ok","at":1}]}').tasks.length, 1)
})

test('opusBuckets lists what was learned', () => {
  assert.deepEqual(opusBuckets(fill(task('a', 'bad'), task('b', 'bad'), task('c', 'ok', { bucket: 'T1/sonnet' })), NOW), [b])
})

test('both spellings of a correction count', () => {
  assert.equal(nextSignal("that's wrong"), 'corrected')
  assert.equal(nextSignal('that is wrong, it still fails'), 'corrected')
  assert.equal(nextSignal('that is fine, thanks'), 'moved-on')
})
