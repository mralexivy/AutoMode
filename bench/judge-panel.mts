#!/usr/bin/env node
// Collects every judge verdict the routing pipeline could use, on upstream's 75 labeled effort cases, over several
// passes. bench/lib/judge-replay.mts then replays any routing rule on these verdicts, at no further cost. Each pass
// stores verdicts and ids only: no prompt text and no reply text.
//
//   node bench/judge-panel.mts                                                   # dry run
//   node bench/judge-panel.mts --run --passes 3 --parallel 8 --approve-usd 5 --out bench/results/judge-panel.jsonl
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JUDGE_CALL, JUDGE_SYSTEM, judgeQuestion, keepsEffort, parseVerdict, type Effort } from '../hooks/lib/effortless.ts'
import { judgeInputFor } from '../hooks/lib/effortless-adapt.ts'
import { JUDGE_SYSTEM as AUTOMODE_SYSTEM, judgePrompt, parseJudge } from '../hooks/lib/classify.ts'
import { add, ensure } from './lib/ledger.mts'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const argv = process.argv.slice(2)
const val = (k: string, d?: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const passes = Number(val('--passes', '3'))
const parallel = Number(val('--parallel', '8'))
const cap = Number(val('--approve-usd', '0'))
const out = path.resolve(val('--out', path.join(REPO, 'bench', 'results', 'judge-panel.jsonl')))
const batch = val('--batch', new Date().toISOString().slice(0, 10))
const FAMILIES = ['haiku', 'sonnet', 'opus'] as const
const DEFAULT_EFFORT: Record<string, Effort> = { haiku: 'medium', sonnet: 'high', opus: 'medium' } // v4.ts DEFAULT_EFFORT
const PER_CALL = 0.0025

export const cases = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'external', 'effortless', 'judge-cases.json'), 'utf8')).cases
export const messagesOf = (context: string) => String(context ?? '').split('\n').reduce((all: { role: string; text: string }[], line) => {
  const m = line.match(/^(user|assistant): ([\s\S]*)$/)
  if (m) all.push({ role: m[1], text: m[2] })
  else if (all.length) all[all.length - 1].text += `\n${line}`
  return all
}, [])
export const lastReplyOf = (context: string) => (String(context ?? '').split('\nassistant: ').pop() ?? '').replace(/^assistant: /, '')

export interface Ask { id: string; slot: string; system: string; input: string; maxTokens: number }

// asksFor lists every call one case can need. Slots: plain:<family> has upstream's input, closing:<family> has
// AutoMode's, and automode is the second judge. The running model is named at its running effort, as it is while the
// cache is warm (A7). Any other model is named at its default effort.
export function asksFor(c: any): Ask[] {
  const ctx = c.context ?? ''
  const asks: Ask[] = []
  for (const family of FAMILIES) {
    const effort = family === c.current.model ? c.current.effort : DEFAULT_EFFORT[family]
    asks.push({ id: c.id, slot: `plain:${family}`, system: JUDGE_SYSTEM, input: judgeQuestion(c.message, { model: family, effort }, ctx), maxTokens: JUDGE_CALL.maxTokens })
    asks.push({ id: c.id, slot: `closing:${family}`, system: JUDGE_SYSTEM, input: judgeInputFor(c.message, { family, effort, messages: messagesOf(ctx), closing: true }), maxTokens: JUDGE_CALL.maxTokens })
  }
  asks.push({ id: c.id, slot: 'automode', system: AUTOMODE_SYSTEM, input: judgePrompt(c.message, { lastReply: lastReplyOf(ctx) || undefined, stripReminders: true }), maxTokens: 240 })
  return asks
}

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-panel-'))
function call(a: Ask): Promise<{ text: string; usd: number; ok: boolean }> {
  ensure(PER_CALL, cap, batch)
  return new Promise((resolve) => {
    const child = spawn(process.env.CLAUDE_BIN || 'claude', ['-p', a.input, '--model', JUDGE_CALL.model, '--effort', JUDGE_CALL.effort, '--system-prompt', a.system, '--tools', '', '--disable-slash-commands', '--setting-sources', '', '--strict-mcp-config', '--output-format', 'json', '--no-session-persistence'], {
      cwd: empty, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(a.maxTokens), CLAUDE_CODE_USE_VERTEX: '0', ANTHROPIC_API_KEY: '' },
    })
    let s = ''
    const stop = setTimeout(() => child.kill(), 60_000)
    child.stdout.on('data', (d) => { s += d })
    child.on('close', () => {
      clearTimeout(stop)
      let j: any = {}
      try { j = JSON.parse(s) } catch {}
      const usd = Number(j.total_cost_usd ?? 0)
      add({ batch, what: 'judge-panel', usd, model: JUDGE_CALL.model, source: 'cli total_cost_usd' })
      resolve({ text: String(j.result ?? ''), usd, ok: !j.is_error && typeof j.result === 'string' })
    })
  })
}

async function main() {
  const asks = cases.flatMap(asksFor)
  console.log(`Judge panel: ${cases.length} cases, ${cases.filter((c: any) => c.holdout).length} held out, ${asks.length} calls a pass, ${passes} passes. Estimate $${(asks.length * passes * PER_CALL).toFixed(2)}.`)
  if (!argv.includes('--run')) { console.log('Dry run: nothing was spent.'); return }
  const done = new Set(fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.pass}|${r.id}|${r.slot}` }) : [])
  const queue = Array.from({ length: passes }, (_, i) => asks.map((a: Ask) => ({ ...a, pass: i + 1 }))).flat().filter((a) => !done.has(`${a.pass}|${a.id}|${a.slot}`))
  let i = 0, spent = 0, answered = 0
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (i < queue.length) {
      const a = queue[i++]
      const r = await call(a)
      spent += r.usd
      const row: Record<string, unknown> = { pass: a.pass, id: a.id, slot: a.slot, ok: r.ok }
      if (a.slot === 'automode') {
        const j = r.ok ? parseJudge(r.text) : null
        if (j) Object.assign(row, { tier: j.tier, complexity: j.complexity, risk: j.risk, consequence: j.consequence, effort: j.effort, confidence: j.confidence, newTask: j.newTask })
        row.parsed = !!j
      } else {
        const v = r.ok ? parseVerdict(r.text) : null
        if (v) Object.assign(row, { model: v.model, effort: v.effort, sure: v.sure })
        row.parsed = !!v
      }
      if (row.parsed) answered++
      fs.appendFileSync(out, JSON.stringify(row) + '\n')
      if (i % 100 === 0) console.log(`${i}/${queue.length} calls, ${answered} answered, $${spent.toFixed(3)}`)
    }
  }))
  console.log(`Done: ${queue.length} calls, ${answered} answered, $${spent.toFixed(3)}.`)
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1) })
