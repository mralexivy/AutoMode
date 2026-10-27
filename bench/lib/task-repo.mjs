// A benchmark task names a public repository and two pinned commits. This helper keeps one bare-ish clone per task in
// bench/.cache/repos (gitignored), so the runner, the grader and the fixture check read the same history.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
export const REPOS = path.join(REPO, 'bench', '.cache', 'repos')

export const TASKS_DIR = path.join(REPO, 'bench', 'tasks')

export function loadTasks(dir = TASKS_DIR) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
}

// problems: what a task file must have. A task without these cannot run, and a task without a license is not published.
export function problems(t) {
  const out = []
  for (const k of ['id', 'cohort', 'repo', 'license', 'base', 'reference', 'task', 'accept']) if (!t[k]) out.push(`missing "${k}"`)
  if (!Array.isArray(t.hidden_tests) || !t.hidden_tests.length) out.push('"hidden_tests" must list at least one test file')
  if (t.repo && !/^https:\/\//.test(t.repo)) out.push('"repo" must be an https URL of a public repository')
  if (t.license && !/^(MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC)$/.test(t.license)) out.push('"license" must be MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause or ISC')
  for (const k of ['base', 'reference']) if (t[k] && !/^[0-9a-f]{40}$/.test(t[k])) out.push(`"${k}" must be a full 40-character commit SHA`)
  return out
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1e8 })

// taskRepo returns the cached clone for a task, fetching it once. Blobs load on demand.
export function taskRepo(task) {
  const dir = path.join(REPOS, task.id)
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(REPOS, { recursive: true })
    git(['clone', '-q', '--no-checkout', '--filter=blob:none', task.repo, dir])
  }
  for (const sha of [task.base, task.reference]) {
    try { git(['cat-file', '-e', `${sha}^{commit}`], dir) } catch { git(['fetch', '-q', 'origin', sha], dir) }
  }
  return dir
}
