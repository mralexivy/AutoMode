#!/usr/bin/env node
// Streams one Claude Code transcript (.jsonl) and prints the numbers AutoMode's habits need, as JSON: typed prompts, each idle gap of
// three minutes or more with the request before it, and the last request. It prints no prompt text, reply text or path.
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
let prompts = 0
const rl = readline.createInterface({ input: fs.createReadStream(process.argv[2], { encoding: 'utf8' }), crlfDelay: Infinity })
for await (const line of rl) {
  if (!line) continue
  let r
  try { r = JSON.parse(line) } catch { continue }
  if (typed(r)) { prompts += 1; continue }
  if (r.type !== 'assistant' || r.isSidechain || !r.message || !r.message.usage || !r.requestId) continue
  const u = r.message.usage
  const fam = family(String(r.message.model || ''))
  if (!fam) continue
  const prev = by.get(r.requestId)
  const acted = (prev && prev.acted) || (Array.isArray(r.message.content) && r.message.content.some((b) => b && b.type === 'tool_use'))
  by.set(r.requestId, { at: prev ? prev.at : Date.parse(r.timestamp), tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), family: fam, acted: !!acted })
}
const reqs = [...by.values()].filter((q) => Number.isFinite(q.at)).sort((a, b) => a.at - b.at)
const gaps = []
for (let i = 1; i < reqs.length; i++) {
  const gapMin = (reqs[i].at - reqs[i - 1].at) / 60000
  if (gapMin >= 3) gaps.push([reqs[i].at, gapMin, reqs[i - 1].tokens, reqs[i - 1].family, reqs[i - 1].acted])
}
const l = reqs[reqs.length - 1]
process.stdout.write(JSON.stringify({ prompts, gaps, last: l ? { at: l.at, tokens: l.tokens, family: l.family, acted: l.acted } : null }))
