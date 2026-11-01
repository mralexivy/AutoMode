#!/usr/bin/env node
// What route learning would have learned from your own decision records. $0: reads local records, counts only.
//
//   node bench/learn-replay.mts [--records DIR] [--out FILE]
//
// It replays each task's tier, need, first model, moves and corrections through hooks/lib/learn.ts, in time order, and
// counts the tasks a learned Opus start would have changed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMPTY_LEARNED, bucketOf, noteTask, opusBuckets, opusFirst, type Learned, type LearnedTask } from '../hooks/lib/learn.ts'
import { familyOf } from '../hooks/lib/prices.ts'

export interface Row { kind?: string; at?: number; taskId?: string; next?: string; point?: string; effective?: { model?: string }; auto?: { hm?: { tier?: string } | null; need?: { verdict?: string | null } | null } }

// tasksOf folds one session's records into tasks. Only a route record names a model, so a task needs one.
export function tasksOf(rows: Row[]): LearnedTask[] {
  const out = new Map<string, LearnedTask & { last: string }>()
  for (const r of rows) {
    if (!r.taskId || r.taskId === 'none') continue
    const t = out.get(r.taskId)
    if (r.kind === 'decision' && r.effective?.model) {
      const family = familyOf(r.effective.model)
      const tier = r.auto?.hm?.tier
      if (!family) continue
      if (!t && tier) out.set(r.taskId, { id: r.taskId, bucket: bucketOf(tier, r.auto?.need?.verdict?.split('/')[0]), family, outcome: 'open', at: r.at ?? 0, last: family })
      else if (t) { t.last = family; if (family === 'opus' && t.family !== 'opus') t.outcome = 'bad' }
    }
    if (r.kind === 'signal' && t && (r.next === 'corrected' || r.next === 'retried')) t.outcome = 'bad'
    if (r.kind === 'outcome' && t && t.outcome === 'open' && (r as { checks?: { pass?: number } }).checks?.pass) t.outcome = 'ok'
  }
  return [...out.values()].map(({ last, ...t }) => t)
}

export function replay(tasks: LearnedTask[]) {
  let l: Learned = EMPTY_LEARNED, changed = 0
  for (const t of [...tasks].sort((a, b) => a.at - b.at)) {
    if (t.family !== 'opus' && opusFirst(l, t.bucket, t.at)) changed += 1
    l = noteTask(l, t)
  }
  return { tasks: tasks.length, ok: tasks.filter((t) => t.outcome === 'ok').length, bad: tasks.filter((t) => t.outcome === 'bad').length, open: tasks.filter((t) => t.outcome === 'open').length, changed, learned: opusBuckets(l, Math.max(0, ...tasks.map((t) => t.at))) }
}

function main() {
  const opt = (k: string, d: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d }
  const dir = opt('--records', path.join(os.homedir(), '.claude/plugins/data/automode/records'))
  const tasks = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => tasksOf(fs.readFileSync(path.join(dir, f), 'utf8').split('\n').flatMap((l): Row[] => { try { return l.trim() ? [JSON.parse(l)] : [] } catch { return [] } })))
  const r = replay(tasks)
  const out = opt('--out', '')
  if (out) fs.writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`)
  console.log(JSON.stringify(r))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
