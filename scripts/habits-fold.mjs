#!/usr/bin/env node
// Streams one Claude Code transcript (.jsonl) and prints the numbers AutoMode's habits need, as JSON: whether a person typed in it, each
// idle gap of three minutes or more with the request before it, and the last request. It prints no prompt text, reply text or path.
// It repeats hooks/lib/scan.ts (foldTranscript + compactOf) for files too big to read whole; tests/habits-fold.test.mts keeps them equal.
// Runs in the person's own node, so it uses nothing newer than node 18.
import fs from 'node:fs'
import readline from 'node:readline'

const family = (m) => (/haiku/i.test(m) ? 'haiku' : /sonnet/i.test(m) ? 'sonnet' : /opus/i.test(m) ? 'opus' : null)
const typed = (r) => {
  if (r.type !== 'user' || r.isSidechain || r.isMeta || r.isCompactSummary) return false
  const c = r.message && r.message.content
  if (typeof c === 'string') return !c.startsWith('<command-') && !c.startsWith('<local-command') && c.trim().length > 0
  return Array.isArray(c) && c.some((b) => b && b.type === 'text' && b.text && b.text.trim() && !b.text.startsWith('<command-')) && !c.some((b) => b && b.type === 'tool_result')
}

const by = new Map()
const promptsAt = []
let entry = null
const rl = readline.createInterface({ input: fs.createReadStream(process.argv[2], { encoding: 'utf8' }), crlfDelay: Infinity })
for await (const line of rl) {
  if (!line) continue
  let r
  try { r = JSON.parse(line) } catch { continue }
  if (entry === null && typeof r.entrypoint === 'string') entry = r.entrypoint
  if (typed(r)) { const t = Date.parse(r.timestamp); if (Number.isFinite(t)) promptsAt.push(t); continue }
  if (r.type !== 'assistant' || r.isSidechain || !r.message || !r.message.usage || !r.requestId) continue
  const u = r.message.usage
  const fam = family(String(r.message.model || ''))
  if (!fam) continue
  const prev = by.get(r.requestId)
  const blocks = Array.isArray(r.message.content) ? r.message.content : []
  const acted = (prev && prev.acted) || blocks.some((b) => b && b.type === 'tool_use')
  const said = blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text || '')).join(' ').trim()
  const ask = (prev && prev.ask) || (said.length > 0 && /\?\s*$/.test(said))
  by.set(r.requestId, { at: prev ? prev.at : Date.parse(r.timestamp), tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), acted: !!acted, out: u.output_tokens || 0, ask: !!ask })
}
promptsAt.sort((a, b) => a - b)
const reqs = [...by.values()].filter((q) => Number.isFinite(q.at)).sort((a, b) => a.at - b.at)
const baseAt = (i) => {
  const a = reqs[i]
  let lastPrompt = reqs[0].at, prompts = 0
  for (const t of promptsAt) { if (t <= a.at) { prompts += 1; lastPrompt = t } else break }
  let turnOut = 0
  for (const q of reqs) if (q.at >= lastPrompt - 1000 && q.at <= a.at) turnOut += q.out
  return { ageMin: (a.at - reqs[0].at) / 60000, prompts, turnOut }
}
const gaps = []
for (let i = 1; i < reqs.length; i++) {
  const gapMin = (reqs[i].at - reqs[i - 1].at) / 60000
  if (gapMin >= 3) { const f = baseAt(i - 1); gaps.push([reqs[i].at, gapMin, reqs[i - 1].tokens, reqs[i - 1].acted, f.ageMin, f.prompts, f.turnOut, reqs[i - 1].ask]) }
}
const n = reqs.length
const f = n ? baseAt(n - 1) : null
process.stdout.write(JSON.stringify({ interactive: promptsAt.length >= 2 && entry !== 'sdk-cli', gaps, last: f ? [reqs[n - 1].at, reqs[n - 1].tokens, f.ageMin, f.prompts, f.turnOut, reqs[n - 1].ask] : null }))
