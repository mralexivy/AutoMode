// A benchmark task names a public repository and two pinned commits. This helper keeps one full clone per task in
// bench/.cache/repos (gitignored), so the runner, the grader and the fixture check read the same history.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
export const REPOS = process.env.BENCH_CACHE_DIR ?? path.join(REPO, 'bench', '.cache', 'repos')

export const TASKS_DIR = path.join(REPO, 'bench', 'tasks')

export interface Task {
  id: string
  cohort: string
  repo: string
  license: string
  base: string
  reference: string
  task: string
  hidden_tests: string[]
  accept: string
  setup?: string
  lint?: string
  // Schema 2. None of this reaches the model: only `task` does, through the prompt template.
  schema_version?: number
  prompt_template?: string
  regression?: string
  typecheck?: string
  requirements?: { network?: boolean; min_context_tokens?: number; languages?: string[]; risk_tags?: string[]; sandbox?: boolean }
  safety?: string // a scenario id in bench/safety/scenarios.mts
  longctx_tier?: number
  external_eval?: 'swebench' // another harness scores this task, so accept stays empty
  limits?: { wall_seconds?: number; disk_mb?: number }
  provenance?: { source: string; dataset?: string; dataset_version?: string }
}

const joined = (c: string | string[] | undefined) => (Array.isArray(c) ? c.join(' && ') : c)

// normalizeTask reads a v1 or v2 file into one shape. A v1 file has flat commands. A v2 file nests them in `evaluation`.
export function normalizeTask(raw: any): Task {
  if (raw.schema_version !== 2) return raw
  const { evaluation: ev = {}, ...rest } = raw
  return { ...rest, hidden_tests: ev.hidden_tests, accept: joined(ev.accept), regression: joined(ev.regression), lint: joined(ev.lint), typecheck: joined(ev.typecheck) }
}

export function loadTasks(dir = TASKS_DIR): Task[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => normalizeTask(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))))
}

// problems: what a task file must have. A task without these cannot run, and a task without a license is not published.
export function problems(t: Task, { allowLocal = false } = {}) {
  const out = []
  for (const k of ['id', 'cohort', 'repo', 'license', 'base', 'reference', 'task']) if (!t[k]) out.push(`missing "${k}"`)
  if (!t.external_eval && !t.accept) out.push('missing "accept"')
  if (!t.external_eval && (!Array.isArray(t.hidden_tests) || !t.hidden_tests.length)) out.push('"hidden_tests" must list at least one test file')
  if (t.repo && !allowLocal && t.provenance?.dataset === undefined && !/^https:\/\//.test(t.repo)) out.push('"repo" must be an https URL of a public repository')
  if (t.license && t.provenance?.dataset === undefined && !/^(MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC)$/.test(t.license)) out.push('"license" must be MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause or ISC')
  if (t.limits?.wall_seconds !== undefined && !(t.limits.wall_seconds > 0)) out.push('"limits.wall_seconds" must be positive')
  for (const k of ['base', 'reference']) if (t[k] && !/^[0-9a-f]{40}$/.test(t[k])) out.push(`"${k}" must be a full 40-character commit SHA`)
  return out
}

const git = (args: string[], cwd?: string) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1e8 })

// taskRepo returns the cached clone for a task, fetching it once. It is a full clone: `git archive` and a local clone of
// a blobless repository fail on recent git, because they cannot fetch blobs through the cache.
export function taskRepo(task: Task) {
  const dir = path.join(REPOS, task.id)
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.mkdirSync(REPOS, { recursive: true })
    git(['clone', '-q', '--no-checkout', task.repo, dir])
  }
  for (const sha of [task.base, task.reference]) {
    try { git(['cat-file', '-e', `${sha}^{commit}`], dir) } catch { git(['fetch', '-q', 'origin', sha], dir) }
  }
  return dir
}
