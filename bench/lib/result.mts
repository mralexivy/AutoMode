// Result row, schema version 3. The flat fields stay as they were, because the report, the grader and bench/reconcile.mts
// read them. Version 3 adds the blocks that make a row reproducible. A row never holds prompt text or file contents.
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { ANTHROPIC, familyOf, usageUsd } from '../../hooks/lib/prices.ts'
import type { RunEvidence } from './run-evidence.mts'

export const RESULT_SCHEMA = 3
export const COST_BASIS = 'api-list-equivalent'
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')

export interface HarnessInfo { git_sha: string; dirty: boolean; runner: string; runner_version: string | null; node: string; platform: string }

let cached: HarnessInfo | null = null
export function harnessInfo(runner = 'claude-code'): HarnessInfo {
  if (cached) return cached
  const git = (...args: string[]) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 20_000 })
  cached = {
    git_sha: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0, runner,
    runner_version: version.status === 0 ? version.stdout.trim() : null, node: process.version, platform: `${process.platform}-${process.arch}`,
  }
  return cached
}

// estimatedUsd prices the transcript tokens at the dated book. It is null when any model has no row: a partial sum
// would read as a real total.
export function estimatedUsd(evidence: RunEvidence | null): number | null {
  if (!evidence || !Object.keys(evidence.by_model).length) return null
  let usd = 0
  for (const [model, t] of Object.entries(evidence.by_model)) {
    const family = familyOf(model)
    if (!family) return null
    usd += usageUsd(t, ANTHROPIC.rates[family])
  }
  return Math.round(usd * 1e6) / 1e6
}

export const pricingSnapshot = () => ANTHROPIC.checkedAt

// The fields every schema 3 row has. A row that stops early (setup or usage limit) has these and no verdict.
const REQUIRED = ['schema_version', 'run_id', 'task_id', 'cohort', 'arm', 'repeat', 'exit_reason', 'experiment', 'spec_hash', 'model', 'prompt', 'harness', 'cost_basis', 'at']

export function rowProblems(r: Record<string, any>) {
  const out = REQUIRED.filter((k) => r[k] === undefined).map((k) => `missing "${k}"`)
  if (r.schema_version !== RESULT_SCHEMA) out.push(`schema_version must be ${RESULT_SCHEMA}`)
  for (const k of ['text', 'prompt_text', 'reply']) if (k in r) out.push(`a row must not store "${k}"`)
  if (r.model && !r.model.provider) out.push('model.provider is missing')
  return out
}
