#!/usr/bin/env node
// Subagent cost breakdown from local transcripts. $0, read-only, no prompt text.
//
//   node bench/subagents.mjs [--root DIR]... [--out PREFIX]
//
// Per agent type and model: agents, requests, measured USD, the first request's context (what the
// handoff and setup cost), and whether the model was set explicitly (agent definition or the call) or
// inherited from the main session. Outcome, where the transcripts carry one: a workflow agent's final
// state, or a subagent run that ended without a final response (stream incomplete).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listTranscripts, loadSubagents } from './lib/transcripts.mjs'
import { ANTHROPIC, familyOf, usageUsd } from '../hooks/lib/prices.ts'

const here = path.dirname(new URL(import.meta.url).pathname)
const args = process.argv.slice(2)
const roots = []
let out = path.join(here, 'results', `subagents-${new Date().toISOString().slice(0, 10)}`)
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') roots.push(args[++i].replace(/^~/, os.homedir()))
  else if (args[i] === '--out') out = args[++i]
}
if (!roots.length) roots.push(path.join(os.homedir(), '.claude', 'projects'), path.join(os.homedir(), '.claude-ectest', 'projects'))

const rows = {}
let total = 0
for (const f of listTranscripts(roots)) {
  const reqs = loadSubagents(f)
  const byAgent = new Map()
  for (const r of reqs) { const a = byAgent.get(r.agentFile) ?? []; a.push(r); byAgent.set(r.agentFile, a) }
  for (const [, rs] of byAgent) {
    const first = rs[0]
    const fam = familyOf(first.model ?? '') ?? 'other'
    const key = `${first.agentType} | ${fam} | ${first.modelSet}`
    const row = (rows[key] ??= { agents: 0, requests: 0, usd: 0, firstPrompt: [], incomplete: 0 })
    row.agents += 1
    row.requests += rs.length
    for (const r of rs) { const u = usageUsd(r.tokens, ANTHROPIC.rates[familyOf(r.model ?? '') ?? 'sonnet']); row.usd += u; total += u }
    row.firstPrompt.push(first.tokens.input + first.tokens.cacheRead + first.tokens.cacheWrite5m + first.tokens.cacheWrite1h)
    row.incomplete += rs.filter((r) => r.incomplete).length
  }
}
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)] ?? 0 }
const table = Object.entries(rows).map(([k, r]) => { const [type, model, modelSet] = k.split(' | '); return { type, model, modelSet, agents: r.agents, requests: r.requests, usd: Math.round(r.usd * 100) / 100, share: Math.round((1000 * r.usd) / total) / 10, medianFirstPrompt: med(r.firstPrompt), incompleteRequests: r.incomplete } }).sort((a, b) => b.usd - a.usd)
fs.writeFileSync(`${out}.json`, JSON.stringify({ generatedAt: new Date().toISOString(), cost: '$0', totalUsd: Math.round(total * 100) / 100, rows: table }, null, 2) + '\n')
const md = ['| agent type | model | model set by | agents | requests | USD | share % | median first-request context | incomplete |', '|---|---|---|---:|---:|---:|---:|---:|---:|',
  ...table.map((r) => `| ${r.type} | ${r.model} | ${r.modelSet} | ${r.agents} | ${r.requests} | ${r.usd} | ${r.share} | ${r.medianFirstPrompt} | ${r.incompleteRequests} |`)].join('\n')
fs.writeFileSync(`${out}.md`, `# Subagent cost, ${new Date().toISOString().slice(0, 10)}\n\nTotal measured: $${Math.round(total * 100) / 100}.\n\n${md}\n`)
console.log(`total $${total.toFixed(2)}\n${md}`)
