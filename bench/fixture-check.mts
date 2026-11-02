#!/usr/bin/env node
// fixture-check.mts <task-id ...> [--scratch dir] [--max-hunks 12] [--run-timeout 300]
// The free gates for a candidate task. No model call, no spend. Network: it clones the task's public repository.
// 1. The fixture gate from validate-fixture.mts: accept fails at base with the hidden tests, and passes at reference.
// 2. A hunk mutation check: apply the reference with one code hunk left out, then run accept. A killed hunk makes accept
//    fail. A task where no single hunk is killed is weak: its tests may not pin the change.
// 3. A coverage proxy: the share of changed code files with at least one killed hunk.
// It prints one JSON line per task, with no test output. It exits nonzero when any task fails the fixture gate.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { kindOf, parseDiff, pickHunks, renderDiff, score, withoutHunk, type HunkResult, type HunkVerdict } from './lib/fixture-check.mts'
import { removeTree, sealSetup } from './lib/run-one.mts'
import { loadTasks, taskRepo, type Task } from './lib/task-repo.mts'
import { freshWorkspace, runAccept, validate } from './validate-fixture.mts'

const argv = process.argv.slice(2)
const flag = (name: string, d: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d }
const valued = new Set(['--scratch', '--max-hunks', '--run-timeout'])
const scratch = flag('--scratch', path.join(os.tmpdir(), 'am-bench-fixture-check'))
const maxHunks = Number(flag('--max-hunks', '12'))
const runTimeoutS = Number(flag('--run-timeout', '300'))
const wanted = argv.filter((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]))
const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1e9 })
const log = (s: string) => process.stderr.write(`${s}\n`)

// keepAfterSetup lists what setup left in ignored paths, such as installed packages, so a reset keeps them.
const keepAfterSetup = (w: string) =>
  [...new Set(git(['ls-files', '-o', '-i', '--exclude-standard', '--directory'], w).split('\n').filter(Boolean).map((p) => p.split('/')[0]))]

function mutate(task: Task) {
  const cache = taskRepo(task)
  const diff = git(['-c', 'core.quotePath=false', 'diff', '--no-renames', '--binary', '--full-index', task.base, task.reference], cache)
  const files = parseDiff(diff)
  const codeFiles = files.filter((f) => kindOf(f.path, task.hidden_tests) === 'code').map((f) => f.path)
  const { picked, total } = pickHunks(files, task.hidden_tests, maxHunks)
  const w = path.join(scratch, `${task.id}-mutants`)
  const patch = path.join(scratch, `${task.id}.patch`)
  fs.mkdirSync(scratch, { recursive: true })
  const limits = { max_hunks: maxHunks, run_timeout_s: runTimeoutS, hunks_total: total }
  try {
    freshWorkspace(task, cache, task.base, w)
    const sealed = sealSetup(w)
    const keep = keepAfterSetup(w).flatMap((p) => ['-e', `/${p}`])
    const attempt = (text: string): HunkVerdict => {
      git(['reset', '-q', '--hard', sealed], w)
      git(['clean', '-q', '-f', '-d', '-x', ...keep], w)
      fs.writeFileSync(patch, text)
      if (spawnSync('git', ['apply', '--whitespace=nowarn', patch], { cwd: w }).status !== 0) return 'apply_failed'
      const r = runAccept(task, w, runTimeoutS * 1000)
      if (r.status === null) return 'timeout'
      return r.status === 0 ? 'survived' : 'killed'
    }
    // The full reference must pass in this workspace, or no mutant result means anything.
    const control = attempt(renderDiff(files))
    if (control !== 'survived') return { ...limits, control, ...score([], codeFiles), weak: true, code_files: codeFiles.length, results: [] }
    const results: HunkResult[] = []
    for (const h of picked) {
      const verdict = attempt(withoutHunk(files, h.file, h.hunk))
      log(`${task.id}: ${h.path} ${h.header.slice(0, 40)} ${verdict}`)
      results.push({ ...h, verdict })
    }
    return { ...limits, control: 'pass', ...score(results, codeFiles), code_files: codeFiles.length, results: results.map(({ path: p, header, verdict }) => ({ path: p, hunk: header.split(' @@')[0] + ' @@', verdict })) }
  } finally {
    removeTree(w)
    fs.rmSync(patch, { force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tasks = loadTasks().filter((t) => wanted.includes(t.id))
  if (!tasks.length) { console.log('Name at least one task id from bench/tasks.'); process.exit(2) }
  log(`Limits: at most ${maxHunks} hunks per task, ${runTimeoutS}s per accept run. A timeout is no verdict.`)
  let failed = 0
  for (const t of tasks) {
    const gate = validate(t, scratch)
    if (!gate.valid) { failed++; console.log(JSON.stringify({ id: t.id, gate })); continue }
    let mutation
    try { mutation = mutate(t) } catch (e) { mutation = { error: (e as Error).message } }
    console.log(JSON.stringify({ id: t.id, gate, mutation }))
  }
  process.exit(failed ? 1 : 0)
}
