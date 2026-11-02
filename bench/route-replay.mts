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
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { outcomeOf, routeAuto, routeFingerprint, type AutoRouteInput, type RouteOutcome } from '../hooks/lib/auto-route.ts'
import { counterfactual, exact, type BatchPolicy } from './lib/route-replay.mts'
import { policyB } from './lib/route-policy.mts'

const args = process.argv.slice(2)
const opt = (n: string, d?: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
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

const records = loadRecords()
let report: unknown
if (mode === 'exact') {
  report = exact(records, (i) => outcomeOf(routeAuto(i)), routeFingerprint())
} else if (mode === 'counterfactual') {
  let b
  try { b = policyB({ ref: opt('--policy'), module: opt('--policy-module') }) } catch (err) { console.error((err as Error).message); process.exit(1) }
  console.error(`policy B: ${b.label}`)
  try { report = counterfactual(records, local, b.batch) } finally { b.cleanup() }
} else {
  console.error(`unknown mode: ${mode}`)
  process.exit(1)
}

console.log(JSON.stringify(report, null, 1))
const out = opt('--out')
if (out) fs.writeFileSync(out, JSON.stringify(report, null, 1) + '\n')
