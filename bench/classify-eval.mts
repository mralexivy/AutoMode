#!/usr/bin/env node
// Does classification pick the right model? It asks the real judges about real task prompts, several times each, and
// passes each answer through the real rules. It runs no task, and costs cents. Results hold labels and counts only.
//
//   node bench/classify-eval.mts [--passes 5] [--parallel 6] [--out FILE]
//
// `want` is the cheapest model known to solve the task, from screen and canary rows. Trivial tasks are labeled Haiku.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JUDGE_SYSTEM, judgePrompt, parseJudge } from '../hooks/lib/classify.ts'
import { JUDGE_SYSTEM as NEED_SYSTEM, parseVerdict } from '../hooks/lib/effortless.ts'
import { judgeInputFor } from '../hooks/lib/effortless-adapt.ts'
import { optimizeAuto } from '../hooks/lib/auto.ts'
import type { Family } from '../hooks/lib/types.ts'

export const LABELS: Record<string, Family> = {
  'longctx-sqlglot-intersect-precedence-across-dialects': 'opus',
  'migration-tomli-decode-error-api': 'sonnet',
  'feature-marked-emstrongmask-hook': 'sonnet',
  'longctx-tornado-body-parse-errors': 'sonnet',
  'migration-jsyaml-max-total-merge-keys': 'sonnet',
  'feature-xmltodict-selective-cdata': 'sonnet',
  'refactor-pymarkdown-block-level': 'sonnet',
  'trivial-bottle-if-none-match': 'haiku',
  'trivial-cheerio-data-mixed-selection': 'haiku',
  'trivial-fastxmlparser-doctype-element-keywords': 'haiku',
  'trivial-marked-empty-code-block': 'haiku',
}

// routeOf runs one pair of answers through the shipped rules. Each model gets the need's effort, so only the rules decide.
export function routeOf(hm: { tier: string; complexity: string } | null, need: { model: string; effort: string } | null): Family {
  const v = need ? { model: need.model, effort: need.effort, why: '' } : null
  return optimizeAuto({ allowed: ['haiku', 'sonnet', 'opus'], verdicts: { haiku: v, sonnet: v, opus: v } as never, need: v as never, hm: hm as never, reachHaiku: true, floors: { because: [] }, current: null, cost: () => 1 }).best.family
}

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'am-classify-'))
function ask(system: string, prompt: string): Promise<{ text: string; usd: number }> {
  return new Promise((resolve) => {
    const p = execFile('claude', ['-p', '--model', 'claude-haiku-5-5', '--tools', '', '--system-prompt', system, '--output-format', 'json', '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence'], { cwd: empty, maxBuffer: 1 << 24, timeout: 60_000 }, (err, out) => {
      try { const j = JSON.parse(out); resolve({ text: String(j.result ?? ''), usd: Number(j.total_cost_usd ?? 0) }) } catch { resolve({ text: '', usd: 0 }) }
    })
    p.stdin?.end(prompt)
  })
}

async function main() {
  const opt = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d }
  const passes = Number(opt('passes', '5')), parallel = Number(opt('parallel', '6'))
  const jobs = Object.keys(LABELS).flatMap((id) => Array.from({ length: passes }, () => id))
  const rows: Record<string, { want: Family; route: Record<string, number>; tier: Record<string, number>; need: Record<string, number> }> = {}
  let usd = 0, next = 0
  const prompts = Object.fromEntries(Object.keys(LABELS).map((id) => [id, String(JSON.parse(fs.readFileSync(`bench/tasks/${id}.json`, 'utf8')).task)]))
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (next < jobs.length) {
      const id = jobs[next++]
      const [a, b] = await Promise.all([ask(JUDGE_SYSTEM, judgePrompt(prompts[id], {})), ask(NEED_SYSTEM, judgeInputFor(prompts[id], { family: 'sonnet', effort: 'high', messages: [], attachments: [], planMode: false } as never))])
      usd += a.usd + b.usd
      const hm = parseJudge(a.text), need = parseVerdict(b.text)
      const route = routeOf(hm as never, need as never)
      const r = (rows[id] ??= { want: LABELS[id], route: {}, tier: {}, need: {} })
      r.route[route] = (r.route[route] ?? 0) + 1
      r.tier[hm?.tier ?? 'none'] = (r.tier[hm?.tier ?? 'none'] ?? 0) + 1
      r.need[need?.model ?? 'none'] = (r.need[need?.model ?? 'none'] ?? 0) + 1
    }
  }))
  const total = Object.values(rows).reduce((c, r) => c + Object.values(r.route).reduce((x, y) => x + y, 0), 0)
  const right = Object.values(rows).reduce((c, r) => c + (r.route[r.want] ?? 0), 0)
  const out = { passes, total, right, usd: Math.round(usd * 1e4) / 1e4, rows }
  const file = opt('out', '')
  if (file) fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`)
  console.log(`${right}/${total} right, $${usd.toFixed(3)}`)
  for (const [id, r] of Object.entries(rows)) console.log(`${id.slice(0, 46).padEnd(46)} want ${r.want.padEnd(6)} route ${JSON.stringify(r.route)} tier ${JSON.stringify(r.tier)} need ${JSON.stringify(r.need)}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
