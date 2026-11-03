// What a benchmark row depends on, split into parts, so a change invalidates only the rows that depend on it.
// Pure apart from reading the plugin tree. bench/BENCHMARK_ARCHITECTURE.md has the invalidation matrix.
//
// Four keys, one per stage:
//   execution  task + prompt + the arm's effective setup + the files that change the agent's behavior + the agent
//              environment policy + repetition. Only a change here can need a new paid run.
//   evidence   the run's own artifacts (transcript, diff, plugin records), named by run id. Immutable once written.
//   grading    evidence + the grader version. Regrading reads evidence and calls no model.
//   analysis   graded rows + the decision policy. Reanalysis calls no model.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Bump when the harness changes what the agent sees: its environment, workspace layout or tools. Version 2 gave the
// agent .bench-deps on its Python path; version 3 gives it every path the accept command sets (src layouts too).
export const AGENT_ENV_VERSION = 3
// Bump when grading changes: how the hidden tests are written in, how acceptance is decided.
export const GRADER_VERSION = 1

// The plugin files that can change what an agent does. Docs, the changelog, user scripts, type declarations and
// assets cannot, so editing them no longer invalidates a single row. Before this, a CHANGELOG line did.
export const BEHAVIOR = /^(hooks|agents|commands|output-styles|workflows)\/|^config\.json$|^\.claude-plugin\/plugin\.json$/
const SKIP = /(^|\/)(\.DS_Store|node_modules)(\/|$)|\.test\.(ts|tsx|mts)$|\.md$/

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
export const shortHash = (o: unknown) => sha(JSON.stringify(o)).slice(0, 16)

// behaviorFiles maps each behavior file to its content hash. plugin.json's version is left out: the release flow bumps it.
export function behaviorFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name)
      const rel = path.relative(root, file).split(path.sep).join('/')
      if (SKIP.test(rel)) continue
      if (fs.statSync(file).isDirectory()) { if (BEHAVIOR.test(`${rel}/`) || rel === '.claude-plugin') walk(file); continue }
      if (!BEHAVIOR.test(rel)) continue
      let body: string | Buffer = fs.readFileSync(file)
      if (rel === '.claude-plugin/plugin.json') { const m = JSON.parse(String(body)); delete m.version; body = JSON.stringify(m) }
      out[rel] = sha(body).slice(0, 16)
    }
  }
  walk(root)
  return out
}

export const filesHash = (files: Record<string, string>) => shortHash(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)))

// changedFiles names the behavior files that differ between two maps.
export function changedFiles(a: Record<string, string>, b: Record<string, string>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => a[f] !== b[f]).sort()
}

export interface TaskLike { id: string; base: string; reference: string; task: string; accept: string; hidden_tests: string[]; setup?: string; lint?: string; typecheck?: string; regression?: string; limits?: unknown; requirements?: unknown }

// taskHash covers everything about a task that changes what runs or how it is judged. The setup is in it: the old run
// id left it out, so pinning Pygments in pymarkdown-v2 would have kept its invalid rows as finished.
export const taskHash = (t: TaskLike) => shortHash({ base: t.base, reference: t.reference, task: t.task, accept: t.accept, hidden: t.hidden_tests, setup: t.setup ?? null, lint: t.lint ?? null, typecheck: t.typecheck ?? null, regression: t.regression ?? null, limits: t.limits ?? null, requirements: t.requirements ?? null })

export interface Identity {
  v: 2
  task: string        // taskHash
  arm: string         // shortHash of the arm's effective setup: model, effort, env, plugin config
  code: string | null // filesHash of the behavior files, for arms that load the plugin; null otherwise
  template: string    // prompt template sha256
  agentEnv: number    // AGENT_ENV_VERSION
  rep: number
}

export const executionKey = (i: Identity) => shortHash(i)
export const runId = (taskId: string, armId: string, i: Identity) => `${taskId}__${armId}__r${i.rep}__${executionKey(i)}`

// compareIdentity says which parts differ. An empty list means the same execution.
export function compareIdentity(a: Partial<Identity> | undefined, b: Identity): string[] {
  if (!a || a.v !== 2) return ['identity (row predates identity v2)']
  return (['task', 'arm', 'code', 'template', 'agentEnv', 'rep'] as const).filter((k) => a[k] !== b[k])
}
