#!/usr/bin/env node
// supervise.mts -- <bench/run.mts arguments>
// Runs bench/run.mts until the plan is done. On a usage limit (exit 75) it sleeps until the reset time the CLI stated,
// plus a margin, and runs again; a resume skips finished rows. With no stated reset it stops and says so: it never
// guesses a time and never spins. Any other exit (gate, lock, integrity defect, error) stops it at once.
//
// To survive a closed terminal or a job cap, start it under the OS service manager, not a shell job:
//   macOS: launchctl submit -l automode-bench -o /tmp/automode-bench.log -e /tmp/automode-bench.log -- \
//            "$(command -v node)" "$PWD/bench/supervise.mts" -- --experiment <id>
//   Linux: systemd-run --user --unit automode-bench --working-directory "$PWD" node bench/supervise.mts -- --experiment <id>
// nohup alone is not enough: a supervisor that kills the process group kills it too (the 2-hour job cap did).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const MARGIN_MS = 3 * 60_000
export const MAX_SLEEP_MS = 6 * 3_600_000

// nextAction decides from a run's exit and its status file. Pure, so the test drives it with no clock.
export function nextAction(code: number | null, status: { reset_at?: string | null } | null, now: number, margin = MARGIN_MS): { act: 'done' | 'sleep' | 'stop'; ms?: number; why: string } {
  if (code === 0) return { act: 'done', why: 'the plan is done' }
  if (code !== 75) return { act: 'stop', why: `the runner exited ${code}: not a usage limit, so nothing is retried` }
  const at = status?.reset_at ? Date.parse(status.reset_at) : NaN
  if (!Number.isFinite(at)) return { act: 'stop', why: 'usage limit with no stated reset time: resume by hand when the plan has room' }
  const ms = Math.max(0, at - now) + margin
  if (ms > MAX_SLEEP_MS) return { act: 'stop', why: `the stated reset (${status!.reset_at}) is more than 6 hours away: resume by hand` }
  return { act: 'sleep', ms, why: `usage limit; the CLI says it resets at ${status!.reset_at}` }
}

const statusFile = (args: string[]) => {
  const i = args.indexOf('--out'), e = args.indexOf('--experiment')
  const out = i >= 0 ? args[i + 1] : path.join('bench', 'results', `${e >= 0 ? args[e + 1] : 'results'}.jsonl`)
  return out.replace(/\.jsonl$/, '') + '.status.json'
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sep = process.argv.indexOf('--')
  const args = sep >= 0 ? process.argv.slice(sep + 1) : process.argv.slice(2)
  const runner = process.env.SUPERVISE_RUNNER ?? path.join(path.dirname(new URL(import.meta.url).pathname), 'run.mts')
  for (let cycle = 1; cycle <= 50; cycle++) {
    const r = spawnSync(process.execPath, [runner, ...args], { stdio: 'inherit' })
    let status = null
    try { status = JSON.parse(fs.readFileSync(statusFile(args), 'utf8')) } catch {}
    const next = nextAction(r.status, status, Date.now(), Number(process.env.SUPERVISE_MARGIN_MS ?? MARGIN_MS))
    console.log(`[supervise] cycle ${cycle}: ${next.why}`)
    if (next.act === 'done') process.exit(0)
    if (next.act === 'stop') process.exit(r.status === 75 ? 75 : r.status ?? 1)
    console.log(`[supervise] sleeping ${Math.ceil(next.ms! / 60_000)} min, then resuming`)
    await new Promise((res) => setTimeout(res, next.ms))
  }
  console.log('[supervise] 50 cycles without finishing: stopping for a person to look')
  process.exit(1)
}
