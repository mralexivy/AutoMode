#!/usr/bin/env node
// validate-fixture.mts <task-id ...> [--scratch dir] [--offline]
// A task is a valid benchmark fixture when its hidden tests fail at the base commit and pass at the reference commit,
// run with the task's own `accept` command. Those tests become the hidden acceptance tests. No model call, no spend.
// It also checks the task file itself (bench/lib/task-repo.mts `problems`). Network: it clones the task's public repository.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadTasks, problems, taskRepo, type Task } from './lib/task-repo.mts'

const argv = process.argv.slice(2)
const si = argv.indexOf('--scratch')
const scratch = si >= 0 ? argv[si + 1] : path.join(os.tmpdir(), 'am-bench-validate')
const wanted = argv.filter((a, i) => !a.startsWith('--') && (si < 0 || i !== si + 1))
const git = (args: string[], cwd?: string) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1e8 })
const accepts = (task: Task, cwd: string) => spawnSync('sh', ['-c', task.accept], { cwd, encoding: 'utf8', timeout: 10 * 60_000 }).status === 0

export function validate(task: Task) {
  const bad = problems(task)
  if (bad.length) return { id: task.id, valid: false, problems: bad }
  const cache = taskRepo(task)
  const w = path.join(scratch, task.id)
  fs.rmSync(w, { recursive: true, force: true })
  fs.mkdirSync(scratch, { recursive: true })
  git(['clone', '-q', '--no-checkout', cache, w])
  try {
    git(['checkout', '-q', '--detach', task.base], w)
    if (task.setup) spawnSync('sh', ['-c', task.setup], { cwd: w, encoding: 'utf8', timeout: 10 * 60_000 })
    for (const t of task.hidden_tests) {
      fs.mkdirSync(path.dirname(path.join(w, t)), { recursive: true })
      fs.writeFileSync(path.join(w, t), git(['show', `${task.reference}:${t}`], cache))
    }
    const atBase = accepts(task, w)
    git(['checkout', '-q', '--force', '--detach', task.reference], w)
    if (task.setup) spawnSync('sh', ['-c', task.setup], { cwd: w, encoding: 'utf8', timeout: 10 * 60_000 })
    const atReference = accepts(task, w)
    return { id: task.id, base_with_hidden: atBase ? 'pass' : 'fail', reference: atReference ? 'pass' : 'fail', valid: !atBase && atReference }
  } finally {
    fs.rmSync(w, { recursive: true, force: true })
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // --offline checks the task files only, with no clone and no test run, so CI can run it on every pull request.
  if (argv.includes('--offline')) {
    const seen = new Set<string>()
    let bad = 0
    for (const t of loadTasks()) {
      const faults = [...problems(t), ...(seen.has(t.id) ? [`duplicate id ${t.id}`] : [])]
      seen.add(t.id)
      if (faults.length) { bad++; console.log(`${t.id ?? '?'}: ${faults.join('; ')}`) }
    }
    console.log(`${seen.size} task files checked.`)
    process.exit(bad ? 1 : 0)
  }
  const tasks = loadTasks().filter((t) => !wanted.length || wanted.includes(t.id))
  if (!tasks.length) { console.log('No tasks found in bench/tasks. See bench/tasks/README.md to add one.'); process.exit(0) }
  let invalid = 0
  for (const t of tasks) { const r = validate(t); if (!r.valid) invalid++; console.log(JSON.stringify(r)) }
  process.exit(invalid ? 1 : 0)
}
