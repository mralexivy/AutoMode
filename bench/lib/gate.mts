// The paid-run gate. A paid run starts only with a passing preflight report for the exact plan it is about to run.
// The plan's hash covers every planned run id, and a run id covers the task, the arm, the behavior files, the prompt
// and the agent environment. So any change to code, fixtures or arms after the preflight makes the hash differ, and
// the runner refuses until the preflight runs again. That is the experiment freeze.
import fs from 'node:fs'
import path from 'node:path'
import { shortHash } from './identity.mts'

export const PREFLIGHT_DIR = (resultsDir: string) => path.join(resultsDir, 'preflight')
export const PREFLIGHT_MAX_AGE_MS = 24 * 3_600_000

export interface Plan { experiment: string; runIds: string[]; budget: number | null; runCap: number | null; policy: string | null }
export const planHash = (p: Plan) => shortHash({ ...p, runIds: [...p.runIds].sort() })

export interface CheckResult { name: string; ok: boolean; detail: string; blocking: boolean }
export interface PreflightReport { experiment: string; plan_hash: string; at: string; pass: boolean; checks: CheckResult[]; slots: unknown; estimate_usd: number }

export const reportPath = (resultsDir: string, experiment: string) => path.join(PREFLIGHT_DIR(resultsDir), `${experiment}.json`)

// gateProblem says why a paid run may not start, or null when it may.
export function gateProblem(report: PreflightReport | null, hash: string, now = Date.now()): string | null {
  if (!report) return 'no preflight report: run `node bench/preflight.mts --experiment <id>` first'
  if (!report.pass) return `the preflight failed: ${report.checks.filter((c) => !c.ok && c.blocking).map((c) => c.name).join(', ')}`
  if (report.plan_hash !== hash) return `the plan changed since the preflight (${report.plan_hash} there, ${hash} now): code, fixtures or arms moved; run the preflight again`
  if (now - Date.parse(report.at) > PREFLIGHT_MAX_AGE_MS) return 'the preflight is older than 24 hours: run it again'
  return null
}

export function readReport(file: string): PreflightReport | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

// The fake `claude` the tests put on PATH answers `--version` with "(fake)". Only then may a run skip the gate.
export const isFake = (runnerVersion: string | null) => !!runnerVersion && /\(fake\)/.test(runnerVersion)
