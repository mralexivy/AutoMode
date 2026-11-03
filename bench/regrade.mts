#!/usr/bin/env node
// regrade.mts <results.jsonl> --diffs <dir> [--out grades.jsonl] [--only id,id] [--scratch dir] [--tasks-dir dir]
// Grades saved runs again with no model call: it rebuilds the workspace (base commit, then setup), applies the
// agent's saved change (bench/results/diffs/<run_id>.diff), writes in the hidden tests from the reference commit and
// runs the accept command. A grader or fixture fix is checked against old evidence this way, never by paying again.
// Each grade has a grading key: the run id, the diff's hash, the grader version and the accept command.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GRADER_VERSION, shortHash } from './lib/identity.mts'
import { readRows } from './lib/plan.mts'
import { prepareWorkspace, removeTree, sealSetup } from './lib/run-one.mts'
import { loadTasks, taskRepo, type Task } from './lib/task-repo.mts'
import { runAccept, writeHiddenTests } from './validate-fixture.mts'

export interface Grade { run_id: string; task_id: string; arm: string; grading_key: string; grader_version: number; accepted: boolean | null; previous: boolean | null; changed: boolean; why: string; at: string }

export function regradeRow(row: any, task: Task, diffFile: string, scratch: string): Grade {
  const diff = fs.existsSync(diffFile) ? fs.readFileSync(diffFile, 'utf8') : null
  const head = { run_id: row.run_id, task_id: row.task_id, arm: row.arm, grader_version: GRADER_VERSION, previous: row.accepted ?? null, at: new Date().toISOString() }
  const key = shortHash({ run: row.run_id, diff: diff === null ? null : createHash('sha256').update(diff).digest('hex'), grader: GRADER_VERSION, accept: task.accept, hidden: task.hidden_tests })
  if (diff === null) return { ...head, grading_key: key, accepted: null, changed: false, why: 'no saved diff: the evidence cannot be regraded' }
  const w = path.join(scratch, row.run_id)
  try {
    const cache = taskRepo(task)
    removeTree(w)
    prepareWorkspace(cache, task.base, w)
    if (task.setup) { execFileSync('sh', ['-c', task.setup], { cwd: w, stdio: 'ignore', timeout: 10 * 60_000 }); sealSetup(w) }
    if (diff.trim()) execFileSync('git', ['apply', '--whitespace=nowarn', '-'], { cwd: w, input: diff, stdio: ['pipe', 'ignore', 'pipe'] })
    writeHiddenTests(task, cache, w)
    const r = runAccept(task, w)
    const accepted = r.status === null ? null : r.status === 0
    return { ...head, grading_key: key, accepted, changed: accepted !== head.previous, why: r.status === null ? 'the accept command did not finish' : 'graded' }
  } catch (e) {
    return { ...head, grading_key: key, accepted: null, changed: false, why: `could not rebuild: ${(e as Error).message.split('\n')[0]}` }
  } finally { removeTree(w) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const arg = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined }
  const file = argv.find((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))
  const diffs = arg('diffs')
  if (!file || !diffs) { console.error('usage: regrade.mts <results.jsonl> --diffs <dir> [--out grades.jsonl] [--only id,id]'); process.exit(1) }
  const only = new Set((arg('only') ?? '').split(',').filter(Boolean))
  const tasks = new Map(loadTasks(arg('tasks-dir') ?? undefined).map((t) => [t.id, t]))
  const out = arg('out') ?? file.replace(/\.jsonl$/, '') + `.grades-v${GRADER_VERSION}.jsonl`
  const scratch = arg('scratch') ?? path.join(os.tmpdir(), 'am-regrade')
  const done = new Set(readRows(out).map((g) => g.grading_key))
  let n = 0, changed = 0, skipped = 0
  for (const row of readRows(file)) {
    if (only.size && !only.has(row.run_id)) continue
    const task = tasks.get(row.task_id)
    if (!task || row.accepted === undefined) continue
    const g = regradeRow(row, task, path.join(diffs, `${row.run_id}.diff`), scratch)
    if (done.has(g.grading_key)) { skipped++; continue }
    fs.appendFileSync(out, JSON.stringify(g) + '\n')
    n++
    if (g.changed) changed++
    console.log(`${row.run_id}: ${g.accepted === null ? `no grade (${g.why})` : g.accepted ? 'accepted' : 'rejected'}${g.changed ? `, was ${g.previous}` : ''}`)
  }
  console.log(`${n} regraded, ${changed} changed, ${skipped} already graded with this key. Model calls: 0.`)
}
