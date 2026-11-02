#!/usr/bin/env node
// split.mts [task-id ...] [--out file] [--date YYYY-MM-DD]
// Writes the held-out split of candidate tasks into `screen` and `confirm`, by the fixed rule in bench/lib/split.mts.
// With no ids, the candidates are the tasks that no experiment file names yet. No model call, no spend.
// Run it once, before any screen row exists, and commit the file. Never rerun it to move a task.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { MAX_PER_REPO, RULE, splitHeldout } from './lib/split.mts'
import { loadTasks } from './lib/task-repo.mts'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
export const EXPERIMENTS = path.join(ROOT, 'bench', 'experiments')
export const HELDOUT = path.join(EXPERIMENTS, 'heldout.json')

// namedTasks lists every task an experiment file names. The split file is not an experiment, so it is skipped.
export function namedTasks(dir = EXPERIMENTS) {
  const out = new Set<string>()
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && path.join(dir, x) !== HELDOUT)) {
    for (const id of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).tasks ?? []) out.add(id)
  }
  return out
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const flag = (name: string, d: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : d }
  const out = flag('--out', HELDOUT)
  const date = flag('--date', new Date().toISOString().slice(0, 10))
  const ids = argv.filter((a, i) => !a.startsWith('--') && !['--out', '--date'].includes(argv[i - 1]))
  const tasks = loadTasks()
  const named = namedTasks()
  const chosen = ids.length ? tasks.filter((t) => ids.includes(t.id)) : tasks.filter((t) => !named.has(t.id))
  const unknown = ids.filter((id) => !tasks.some((t) => t.id === id))
  if (unknown.length) { console.error(`Unknown task ids: ${unknown.join(', ')}`); process.exit(2) }
  if (!chosen.length) { console.error('No candidate tasks.'); process.exit(2) }
  const split = splitHeldout(chosen.map((t) => ({ id: t.id, repo: t.repo })))
  const git_sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  const doc = { rule: RULE, max_per_repo: MAX_PER_REPO, date, git_sha, candidates: chosen.length, ...split }
  fs.writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`)
  console.log(`screen ${split.screen.length}, confirm ${split.confirm.length}, excluded ${split.excluded.length} -> ${path.relative(ROOT, out)}`)
}
