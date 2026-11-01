#!/usr/bin/env node
// Can Haiku find the right lines, and does the evidence check hold? Costs cents: one tool-free Haiku call per case.
//
//   node bench/delegate-eval.mts [--out FILE]
//
// Each case asks about files in this repository. A case passes when a verified finding cites a line that matches
// `want`, on the file as it stands. The absent case passes when nothing survives the check. Results hold counts only.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXTRACT_SYSTEM, extractPrompt, parseEvidence, verifyEvidence, type Finding } from '../hooks/lib/delegation.ts'

export interface Case { id: string; paths: string[]; question: string; want: RegExp | null }

export const CASES: Case[] = [
  { id: 'budget-stop', paths: ['hooks/v4.ts'], question: 'Where is a worker told to stop reading once its budget is spent?', want: /w\.stop &&/ },
  { id: 'explore-redirect', paths: ['hooks/v4.ts'], question: 'Where does the built-in Explore agent get replaced by the AutoMode explorer?', want: /subagentType: 'automode:explorer', model: 'haiku'/ },
  { id: 'tool-errors', paths: ['hooks/v4.ts'], question: 'How many tool errors in a row does it take to run the escalation ladder, and where is that checked?', want: /toolErrors < 3/ },
  { id: 'stale-report', paths: ['hooks/v4.ts'], question: 'How does the code detect that a worker report came back after its task changed?', want: /S\.envelope\.taskId !== taskId/ },
  { id: 'reduce-size', paths: ['hooks/guardian.ts'], question: 'Which comparison decides that a Bash result is too small to reduce?', want: /total <= G\.cfg\.reduceAboveChars/ },
  { id: 'keep-lines', paths: ['hooks/lib/guardian.ts'], question: 'How many lines from the start of an output does reduceOutput always keep?', want: /Math\.min\(40/ },
  { id: 'risk-rules', paths: ['workflows/run.js'], question: 'Where are the text patterns that rate a task as risky defined?', want: /RISK_RULES/ },
  { id: 'plugin-copy', paths: ['bench/arms.mts'], question: 'Which folders are kept out of the plugin copy for a benchmark run?', want: /EXCLUDED_FROM_PLUGIN = / },
  { id: 'two-files', paths: ['hooks/guardian.ts', 'hooks/lib/guardian.ts'], question: 'Which function decides that a tool result can be reduced?', want: /export const reducible/ },
  { id: 'absent', paths: ['hooks/lib/guardian.ts'], question: 'Where does this file open a WebSocket connection?', want: null },
]

// scoreCase: the check runs first, so an invented finding can never count as a hit.
export function scoreCase(c: Case, kept: Finding[], files: Record<string, string>): boolean {
  if (!c.want) return kept.length === 0
  return kept.some((f) => (files[f.path] ?? '').split('\n').slice(f.lines[0] - 1, f.lines[1]).some((l) => c.want!.test(l)))
}

function ask(system: string, prompt: string) {
  const out = execFileSync('claude', ['-p', '--model', 'claude-haiku-5-5', '--tools', '', '--system-prompt', system, '--output-format', 'json'], { input: prompt, encoding: 'utf8', maxBuffer: 1 << 26, timeout: 120_000 })
  const j = JSON.parse(out)
  return { text: String(j.result ?? ''), usd: Number(j.total_cost_usd ?? 0) }
}

function main() {
  const i = process.argv.indexOf('--out')
  const out = i >= 0 ? process.argv[i + 1] : `bench/results/delegate-eval-${new Date().toISOString().slice(0, 10)}.json`
  const rows = CASES.map((c) => {
    const files = Object.fromEntries(c.paths.map((p) => [p, fs.readFileSync(path.resolve(p), 'utf8')]))
    const r = ask(EXTRACT_SYSTEM, extractPrompt(files, c.question))
    const e = parseEvidence(r.text)
    const { kept, dropped } = e ? verifyEvidence(e, files) : { kept: [], dropped: 0 }
    return { id: c.id, passed: !!e && scoreCase(c, kept, files), parsed: !!e, kept: kept.length, dropped, usd: r.usd }
  })
  const passed = rows.filter((r) => r.passed).length, usd = rows.reduce((a, r) => a + r.usd, 0)
  fs.writeFileSync(out, `${JSON.stringify({ cases: rows.length, passed, usd: Math.round(usd * 1e4) / 1e4, rows }, null, 2)}\n`)
  console.log(`${passed}/${rows.length} passed, $${usd.toFixed(4)}, ${rows.reduce((a, r) => a + r.dropped, 0)} findings dropped`)
  for (const r of rows.filter((x) => !x.passed)) console.log(`failed: ${r.id} (parsed ${r.parsed}, kept ${r.kept}, dropped ${r.dropped})`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
