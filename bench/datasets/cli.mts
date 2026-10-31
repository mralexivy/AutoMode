#!/usr/bin/env node
// External benchmarks, from pinned data to scored rows. Data stays in bench/.cache (gitignored). Treat it as untrusted.
//
//   node bench/datasets/cli.mts list
//   node bench/datasets/cli.mts fetch <dataset> [--limit 20]       download rows, after checking the pinned revision
//   node bench/datasets/cli.mts tasks <dataset> --out dir          write task files for: node bench/run.mts --tasks-dir dir
//   node bench/datasets/cli.mts predictions <results.jsonl> --out dir [--dataset-name n]   SWE-bench prediction files and commands
//   node bench/datasets/cli.mts import <results.jsonl> <upstream results.json> --run <arm__r1>
//
// Function-level tasks run third-party tests, so they need the neutral runner and its sandbox.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DATASETS, type DatasetInfo } from './catalog.mts'
import { bigCodePlan, liveCodePlan, materialize } from './codegen.mts'
import { applyReport, evaluationCommand, predictions, sweTask } from './swebench.mts'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
export const CACHE = process.env.BENCH_DATASET_CACHE ?? path.join(REPO, 'bench', '.cache', 'datasets')
const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const dataFile = (d: DatasetInfo) => path.join(CACHE, `${d.id}-${d.revision.slice(0, 8)}.jsonl`)
const jsonl = (f: string) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))

async function checkRevision(d: DatasetInfo) {
  const j: any = await (await fetch(`https://huggingface.co/api/datasets/${d.source}`)).json()
  if (j.sha !== d.revision) throw new Error(`${d.id} moved from ${d.revision} to ${j.sha}. Review it, then update the pin in bench/datasets/catalog.mts.`)
}

async function fetchRows(d: DatasetInfo, limit: number) {
  const rows: unknown[] = []
  for (let offset = 0; rows.length < limit;) {
    const length = Math.min(100, limit - rows.length)
    const res = await fetch(`https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(d.source)}&config=default&split=${d.split}&offset=${offset}&length=${length}`)
    if (!res.ok) throw new Error(`rows request failed: HTTP ${res.status}`)
    const page = ((await res.json()) as any).rows.map((r: any) => r.row)
    rows.push(...page)
    if (page.length < length) break
    offset += length
  }
  return rows
}

// This file is over 100 MB, so it stops reading at `limit` lines.
async function streamLines(d: DatasetInfo, limit: number) {
  const res = await fetch(`https://huggingface.co/datasets/${d.source}/resolve/${d.revision}/${d.file}`)
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
  const rows: unknown[] = []
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let i
    while ((i = buffer.indexOf('\n')) >= 0 && rows.length < limit) { rows.push(JSON.parse(buffer.slice(0, i))); buffer = buffer.slice(i + 1) }
    if (rows.length >= limit) break
  }
  return rows
}

const command = process.argv[2]
const name = process.argv[3]
const dataset = (id: string) => { const d = DATASETS[id]; if (!d) throw new Error(`unknown dataset ${id}; known: ${Object.keys(DATASETS).join(', ')}`); return d }

if (command === 'list') {
  for (const d of Object.values(DATASETS)) console.log(`${d.id}: ${d.use}. ${d.source}@${d.revision.slice(0, 8)}. License: ${d.license}.`)
} else if (command === 'fetch') {
  const d = dataset(name)
  if (d.kind === 'terminal-bench') throw new Error('Terminal-Bench data is pulled by Harbor: see bench/datasets/terminal-bench.mts')
  const limit = Number(arg('limit', '20'))
  await checkRevision(d)
  const rows = d.file ? await streamLines(d, limit) : await fetchRows(d, limit)
  fs.mkdirSync(CACHE, { recursive: true })
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
  fs.writeFileSync(dataFile(d), text)
  console.log(`${rows.length} rows in ${path.relative(REPO, dataFile(d))}, sha256 ${crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)}.`)
} else if (command === 'tasks') {
  const d = dataset(name)
  const out = arg('out')
  if (!out) throw new Error('--out is required')
  fs.mkdirSync(out, { recursive: true })
  for (const item of jsonl(dataFile(d))) {
    const task = d.kind === 'swebench' ? sweTask(item, d.source, d.revision)
      : materialize(d.kind === 'bigcodebench' ? bigCodePlan(item, d.source, d.revision) : liveCodePlan(item, d.source, d.revision), path.join(CACHE, 'repos', d.id, String(item.task_id ?? item.question_id).replace(/[^A-Za-z0-9]+/g, '-')))
    fs.writeFileSync(path.join(out, `${task.id}.json`), JSON.stringify(task, null, 2) + '\n')
  }
  console.log(`Task files in ${out}.`)
} else if (command === 'predictions') {
  const out = arg('out')
  if (!out) throw new Error('--out is required')
  fs.mkdirSync(out, { recursive: true })
  const rows = jsonl(name).filter((r) => r.external_eval === 'swebench' && r.exit_reason !== 'quota')
  const patch = (runId: string) => { const f = path.join(path.dirname(name), 'diffs', `${runId}.patch`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null }
  for (const [run, items] of predictions(rows, patch)) {
    const file = path.join(out, `${run}.jsonl`)
    fs.writeFileSync(file, items.map((p) => JSON.stringify(p)).join('\n') + '\n')
    console.log(evaluationCommand(arg('dataset-name', 'princeton-nlp/SWE-bench_Verified'), file, run).join(' '))
  }
} else if (command === 'import') {
  const run = arg('run')
  if (!run) throw new Error('--run is required')
  const rows = applyReport(jsonl(name), JSON.parse(fs.readFileSync(process.argv[4], 'utf8')), run)
  fs.writeFileSync(name, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  console.log(`Verdicts for ${run} are in ${name}.`)
} else {
  console.error('usage: node bench/datasets/cli.mts list | fetch <dataset> | tasks <dataset> --out dir | predictions <results> --out dir | import <results> <results.json> --run name')
  process.exit(1)
}
