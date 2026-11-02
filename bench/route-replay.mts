#!/usr/bin/env node
// Replays policy-auto routes from decision records. It costs $0: no judge or model call runs.
//
//   node bench/route-replay.mts [--mode exact] [--data DIR | --records FILE.jsonl] [--out FILE.json]
//   node bench/route-replay.mts --mode counterfactual --policy <git-ref> [--data DIR]
//   node bench/route-replay.mts --mode counterfactual --policy-module bench/fixtures/mutant-drop-critical-floor.mts
//   node bench/route-replay.mts --mode classifier        # explains why records cannot answer this
//
// exact          Does this code reproduce each recorded route? Agreement counts only records with this code's route
//                fingerprint. Records from other code are listed apart.
// counterfactual How does policy B route the same frozen evidence as this code (policy A)? Policy B runs in a child
//                process: a git ref from a pinned worktree in a temporary folder, a module from its path. Code from
//                another ref is never imported into this process.
// classifier     Needs the prompt text to ask the judges again. Records never hold it. Use bench/retro-judge.mts or
//                the judge benches instead.
//
// A record without a complete route input is unreplayable, and the report counts it by reason. No field is guessed.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { outcomeOf, routeAuto, routeFingerprint, type AutoRouteInput, type RouteOutcome } from '../hooks/lib/auto-route.ts'
import { counterfactual, exact, type BatchPolicy } from './lib/route-replay.mts'

const args = process.argv.slice(2)
const opt = (n: string, d?: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const here = path.dirname(fileURLToPath(import.meta.url))
const local: BatchPolicy = (inputs) => inputs.map((i) => outcomeOf(routeAuto(i)))

// --serve: the child side. Reads a JSON array of inputs on stdin and writes their outcomes as JSON on stdout.
if (args.includes('--serve')) {
  const inputs: AutoRouteInput[] = JSON.parse(fs.readFileSync(0, 'utf8'))
  const mod = opt('--module')
  const policy: (i: AutoRouteInput) => RouteOutcome = mod ? (await import(pathToFileURL(path.resolve(mod)).href)).policy : (i) => outcomeOf(routeAuto(i))
  process.stdout.write(JSON.stringify(inputs.map(policy)))
  process.exit(0)
}

const mode = opt('--mode', 'exact')
if (mode === 'classifier') {
  console.log('Classifier replay needs the prompt text, and decision records never store it. Use bench/retro-judge.mts or the judge benches (bench/judge-bench-effortless.mts) to measure new judge inference.')
  process.exit(2)
}

function readJsonl(file: string): any[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)] } catch { return [] } })
}
function loadRecords(): any[] {
  const file = opt('--records')
  if (file) return readJsonl(file)
  const dir = opt('--data', path.join(os.homedir(), '.claude', 'plugins', 'data', 'automode'))!
  const files = [path.join(dir, 'decisions.jsonl')]
  try { for (const f of fs.readdirSync(path.join(dir, 'records'))) if (/\.jsonl(\.1)?$/.test(f)) files.push(path.join(dir, 'records', f)) } catch { /* no records folder */ }
  return files.filter((f) => fs.existsSync(f)).flatMap(readJsonl)
}

// child: run policy B in its own node process.
function child(script: string, cwd: string, extra: string[]): BatchPolicy {
  return (inputs) => {
    const r = spawnSync(process.execPath, [script, '--serve', ...extra], { cwd, input: JSON.stringify(inputs), maxBuffer: 1 << 30, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`policy B failed: ${(r.stderr || '').slice(-800)}`)
    return JSON.parse(r.stdout)
  }
}

const records = loadRecords()
let report: unknown
if (mode === 'exact') {
  report = exact(records, (i) => outcomeOf(routeAuto(i)), routeFingerprint())
} else if (mode === 'counterfactual') {
  const ref = opt('--policy')
  const mod = opt('--policy-module')
  if (!ref === !mod) { console.error('counterfactual needs exactly one of --policy <git-ref> or --policy-module <path>'); process.exit(1) }
  let cleanup = () => {}
  let b: BatchPolicy
  if (ref) {
    const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, encoding: 'utf8' }).stdout.trim()
    const sha = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).stdout.trim()
    if (!sha) { console.error(`unknown git ref: ${ref}`); process.exit(1) }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-replay-'))
    const add = spawnSync('git', ['worktree', 'add', '--detach', dir, sha], { cwd: root, encoding: 'utf8' })
    if (add.status !== 0) { console.error(add.stderr); process.exit(1) }
    cleanup = () => { spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root }) }
    const script = path.join(dir, 'bench', 'route-replay.mts')
    if (!fs.existsSync(script)) { cleanup(); console.error(`${ref} (${sha.slice(0, 8)}) has no bench/route-replay.mts, so it cannot replay route inputs`); process.exit(1) }
    b = child(script, dir, [])
    console.error(`policy B: ${ref} at ${sha.slice(0, 12)}`)
  } else {
    b = child(fileURLToPath(import.meta.url), process.cwd(), ['--module', path.resolve(mod!)])
    console.error(`policy B: module ${mod}`)
  }
  try { report = counterfactual(records, local, b) } finally { cleanup() }
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(1)
}

console.log(JSON.stringify(report, null, 1))
const out = opt('--out')
if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1) + '\n')
