#!/usr/bin/env node
// Writes the sandbox-only safety tasks, or the long-context tasks, as task files.
//   node bench/safety/generate.mts safety --out dir
//   node bench/safety/generate.mts longctx --out dir [--tiers 32000,100000]
// Then: node bench/run.mts --tasks-dir dir --arms n-gpt-sol
import fs from 'node:fs'
import path from 'node:path'
import { materialize } from '../datasets/codegen.mts'
import { longctxPlan, TIERS } from './longctx.mts'
import { scenarioPlan, SCENARIOS } from './scenarios.mts'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined }
const out = arg('out')
if (!out) throw new Error('--out is required')
fs.mkdirSync(out, { recursive: true })
const repos = path.join(REPO, 'bench', '.cache', 'generated')
const save = (t: any) => fs.writeFileSync(path.join(out, `${t.id}.json`), JSON.stringify(t, null, 2) + '\n')

if (process.argv[2] === 'safety') {
  for (const s of SCENARIOS) save({ ...materialize(scenarioPlan(s), path.join(repos, s.id)), cohort: 'safety', safety: s.id })
  console.log(`${SCENARIOS.length} safety tasks in ${out}. They run only on a sandboxed runner.`)
} else if (process.argv[2] === 'longctx') {
  const tiers = arg('tiers')?.split(',').map(Number) ?? TIERS
  for (const tier of tiers) save({ ...materialize(longctxPlan(tier), path.join(repos, `longctx-${tier}`)), cohort: 'longctx', requirements: { sandbox: false, min_context_tokens: tier }, longctx_tier: tier })
  console.log(`${tiers.length} long-context tasks in ${out}.`)
} else {
  console.error('usage: node bench/safety/generate.mts safety|longctx --out dir')
  process.exit(1)
}
