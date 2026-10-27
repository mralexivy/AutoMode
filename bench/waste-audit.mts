#!/usr/bin/env node
// @ts-nocheck TODO(types): 6 errors with strict off. Fix them and delete this line to turn checking on for this file.
// Waste patterns in the last N days of local Claude Code transcripts. $0: reads files only.
//   cache breaks  - main-thread requests that rewrote most of a large prompt instead of reading it
//   bloat         - tool results (file reads, logs, diffs, MCP output) priced by what they cost while they
//                   stayed in context: one cache write, then a cache read on every later main request until
//                   the next compaction
//   runaway loops - prompts with very many sequential requests, and the same command repeated in one prompt
// Costs are calculated (usage x list price per model id, bench/spend-audit.mts), not billed.
//
// Usage: node bench/waste-audit.mts [--days 30] [--top 15] [--out FILE]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseLines, requestsOf, isPersonPrompt, loadSubagents } from './lib/transcripts.mts'
import { costOf, sum, rateOf, workloadOf } from './spend-audit.mts'

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const END = Date.now(), START = END - Number(opt('--days', 30)) * 86_400_000
const TOP = Number(opt('--top', 15))
const ROOTS = [path.join(os.homedir(), '.claude/projects'), path.join(os.homedir(), '.claude-ectest/projects')]
const CHARS_PER_TOKEN = 3.5 // the router's own estimate (hooks/v4.ts); a result's token count is not in the transcript

const resultText = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '' : JSON.stringify(b ?? ''))).join('') : JSON.stringify(c ?? '')
// What a tool call was, in a form that groups habits: the file, the command's first words, the MCP tool.
export function labelOf(name, input = {}) {
  if (name === 'Read') return { kind: 'Read', what: String(input.file_path ?? '?') }
  if (name === 'Bash') {
    const cmd = String(input.command ?? '').replace(/\s+/g, ' ').trim()
    const habit = /\bgit (diff|show|log)\b/.test(cmd) ? `git ${cmd.match(/\bgit (diff|show|log)\b/)[1]}`
      : /\b(cat|head|tail|less)\b[^|]*\.(log|txt|json|jsonl|csv)\b/.test(cmd) ? 'dump a log/data file'
      : /\b(go test|npm (run )?test|node --test|pytest|jest|vitest|make (test|check)|claude plugin test)\b/.test(cmd) ? 'run tests'
      : /\b(grep|rg|find)\b/.test(cmd) ? 'shell search'
      : /\b(curl|gh api|wget)\b/.test(cmd) ? 'fetch over HTTP'
      : cmd.split(' ').slice(0, 2).join(' ')
    return { kind: 'Bash', what: cmd.slice(0, 140), habit }
  }
  if (/^mcp__/.test(name)) return { kind: 'MCP', what: name }
  if (name === 'Grep' || name === 'Glob') return { kind: name, what: String(input.pattern ?? '') }
  if (name === 'Agent' || name === 'Task') return { kind: 'Agent', what: String(input.subagent_type ?? 'general-purpose') }
  return { kind: name, what: name }
}

export function analyzeSession(L, start = START, end = END) {
  const reqs = requestsOf(L)
  const main = []
  const pendingTools = new Map() // tool_use id -> { name, input, at }
  const results = []
  let prompt = null
  const prompts = []
  const seen = new Set()
  for (const r of L) {
    if (isPersonPrompt(r)) { prompt = { at: Date.parse(r.timestamp), text: typeof r.message.content === 'string' ? r.message.content : r.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), requests: 0, cmds: new Map(), firstIdx: main.length }; prompts.push(prompt); continue }
    if (r.type === 'system' && r.subtype === 'compact_boundary') main.push({ compact: true })
    if (r.type === 'assistant' && Array.isArray(r.message?.content)) for (const b of r.message.content) if (b?.type === 'tool_use') pendingTools.set(b.id, { name: b.name, input: b.input ?? {}, at: Date.parse(r.timestamp) })
    if (r.type === 'assistant' && r.requestId && !r.isSidechain && reqs.has(r.requestId) && !seen.has(r.requestId)) {
      seen.add(r.requestId)
      const q = reqs.get(r.requestId)
      main.push(q)
      if (prompt) prompt.requests += 1
    }
    if (r.type === 'user' && !r.isSidechain && Array.isArray(r.message?.content)) for (const b of r.message.content) {
      if (b?.type !== 'tool_result') continue
      const call = pendingTools.get(b.tool_use_id)
      if (!call) continue
      const text = resultText(b.content)
      results.push({ at: Date.parse(r.timestamp), idx: main.length, chars: text.length, ...labelOf(call.name, call.input), error: !!b.is_error })
      if (prompt && call.name === 'Bash') { const k = String(call.input.command ?? '').trim(); prompt.cmds.set(k, (prompt.cmds.get(k) ?? 0) + 1) }
    }
  }
  const live = main.filter((q) => !q.compact && q.at >= start && q.at < end && rateOf(q.model))
  const tok = { input: 0, write: 0, read: 0, output: 0 }
  let usd = 0
  const breaks = []
  for (let i = 0; i < live.length; i++) {
    const q = live[i], t = q.tokens, c = costOf(t, q.model)
    usd += sum(c)
    tok.input += t.input; tok.write += t.cacheWrite5m + t.cacheWrite1h; tok.read += t.cacheRead; tok.output += t.output
    const w = t.cacheWrite5m + t.cacheWrite1h, p = w + t.cacheRead + t.input
    if (i > 0 && p > 20_000 && w > 0.5 * p) breaks.push({ at: q.at, tokens: w, usd: c.write5m + c.write1h, gapMin: Math.round((q.at - live[i - 1].at) / 60000), modelChanged: q.model !== live[i - 1].model })
  }
  // Bloat: a result's tokens are written once and then read on every later main request until a compaction.
  const bloat = []
  for (const res of results) {
    if (res.at < start || res.at >= end || res.chars < 8_000) continue
    const tokens = res.chars / CHARS_PER_TOKEN
    let reads = 0, readUsd = 0, writeUsd = 0, wrote = false
    for (let j = res.idx; j < main.length; j++) {
      const q = main[j]
      if (q.compact) break
      const r = rateOf(q.model)
      if (!r) continue
      if (!wrote) { writeUsd = tokens * r.input * (q.tokens.cacheWrite1h > q.tokens.cacheWrite5m ? 2 : 1.25) / 1e6; wrote = true; continue }
      reads += 1; readUsd += tokens * r.input * r.readX / 1e6
    }
    bloat.push({ ...res, tokens: Math.round(tokens), carriedRequests: reads, usd: writeUsd + readUsd })
  }
  const loops = prompts.filter((p) => p.at >= start && p.at < end).map((p) => {
    const reps = [...p.cmds.entries()].sort((a, b) => b[1] - a[1])[0]
    const slice = main.slice(p.firstIdx, p.firstIdx + p.requests).filter((q) => !q.compact && rateOf(q.model))
    return { at: p.at, text: p.text.replace(/\s+/g, ' ').slice(0, 90), requests: p.requests, usd: slice.reduce((a, q) => a + sum(costOf(q.tokens, q.model)), 0), topCommand: reps ? { cmd: reps[0].slice(0, 100), times: reps[1] } : null }
  })
  return { usd, tok, breaks, bloat, loops, mainRequests: live.length }
}

export function audit() {
  const sessions = []
  for (const root of ROOTS) {
    let projects = []
    try { projects = fs.readdirSync(root) } catch { continue }
    for (const project of projects) {
      let files = []
      try { files = fs.readdirSync(path.join(root, project)).filter((f) => f.endsWith('.jsonl')) } catch { continue }
      for (const f of files) {
        const file = path.join(root, project, f)
        if (fs.statSync(file).mtimeMs < START) continue
        const a = analyzeSession(parseLines(file))
        const sub = loadSubagents(file).filter((q) => q.at >= START && q.at < END && rateOf(q.model))
        const subUsd = sub.reduce((s, q) => s + sum(costOf(q.tokens, q.model)), 0)
        for (const q of sub) { const t = q.tokens; a.tok.input += t.input; a.tok.write += t.cacheWrite5m + t.cacheWrite1h; a.tok.read += t.cacheRead; a.tok.output += t.output }
        if (!a.mainRequests && !sub.length) continue
        sessions.push({ project: project.replace(/^-Users-[^-]+-/, ''), session: f.slice(0, 8), workload: workloadOf(root, project), ...a, subUsd, usd: a.usd + subUsd })
      }
    }
  }
  return sessions
}

const r2 = (x) => Math.round(x * 100) / 100
if (import.meta.url === `file://${process.argv[1]}`) {
  const S = audit()
  const total = S.reduce((a, s) => a + s.usd, 0)
  const T = S.reduce((a, s) => ({ input: a.input + s.tok.input, write: a.write + s.tok.write, read: a.read + s.tok.read, output: a.output + s.tok.output }), { input: 0, write: 0, read: 0, output: 0 })
  const byProject = new Map()
  for (const s of S) { const p = byProject.get(s.project) ?? { usd: 0, sessions: 0, read: 0, write: 0 }; p.usd += s.usd; p.sessions += 1; p.read += s.tok.read; p.write += s.tok.write; byProject.set(s.project, p) }
  const breaks = S.flatMap((s) => s.breaks.map((b) => ({ ...b, project: s.project, session: s.session })))
  const bloat = S.flatMap((s) => s.bloat.map((b) => ({ ...b, project: s.project, session: s.session })))
  const loops = S.flatMap((s) => s.loops.map((l) => ({ ...l, project: s.project, session: s.session })))
  const group = (xs, key) => { const m = new Map(); for (const x of xs) { const k = key(x); const e = m.get(k) ?? { usd: 0, n: 0, tokens: 0 }; e.usd += x.usd; e.n += 1; e.tokens += x.tokens ?? 0; m.set(k, e) } return [...m].sort((a, b) => b[1].usd - a[1].usd) }
  const out = {
    window: { start: new Date(START).toISOString(), end: new Date(END).toISOString() }, basis: 'calculated at list price per model id; not billed',
    total: r2(total), sessions: S.length,
    tokens: T, cacheEfficiency: { readShareOfPrompt: r2((100 * T.read) / (T.read + T.write + T.input)), readsPerWrittenToken: r2(T.read / T.write) },
    topProjects: [...byProject].sort((a, b) => b[1].usd - a[1].usd).slice(0, 8).map(([k, v]) => ({ project: k, usd: r2(v.usd), sessions: v.sessions, readsPerWrite: r2(v.read / v.write) })),
    topSessions: [...S].sort((a, b) => b.usd - a.usd).slice(0, 8).map((s) => ({ project: s.project, session: s.session, workload: s.workload, usd: r2(s.usd), mainRequests: s.mainRequests, readsPerWrite: r2(s.tok.read / s.tok.write), breaks: s.breaks.length, breakUsd: r2(s.breaks.reduce((a, b) => a + b.usd, 0)), bloatUsd: r2(s.bloat.reduce((a, b) => a + b.usd, 0)), subagentUsd: r2(s.subUsd) })),
    cacheBreaks: { n: breaks.length, usd: r2(breaks.reduce((a, b) => a + b.usd, 0)),
      byCause: group(breaks, (b) => b.modelChanged ? 'model switch' : b.gapMin > 60 ? 'idle > 1h' : b.gapMin > 5 ? 'idle 5-60 min' : 'no idle gap (prefix changed)').map(([k, v]) => ({ cause: k, n: v.n, usd: r2(v.usd) })) },
    bloat: { results: bloat.length, usd: r2(bloat.reduce((a, b) => a + b.usd, 0)),
      byKind: group(bloat, (b) => b.kind).map(([k, v]) => ({ kind: k, n: v.n, usd: r2(v.usd) })),
      byHabit: group(bloat, (b) => b.kind === 'Bash' ? `Bash: ${b.habit}` : b.kind === 'Read' ? `Read: .${(b.what.match(/\.(\w+)$/) ?? [, 'none'])[1]} file` : `${b.kind}: ${b.what}`).slice(0, TOP).map(([k, v]) => ({ habit: k, n: v.n, usd: r2(v.usd), tokens: Math.round(v.tokens) })),
      topFiles: group(bloat.filter((b) => b.kind === 'Read'), (b) => b.what).slice(0, TOP).map(([k, v]) => ({ file: k, reads: v.n, usd: r2(v.usd), tokens: Math.round(v.tokens) })),
      topItems: [...bloat].sort((a, b) => b.usd - a.usd).slice(0, TOP).map((b) => ({ project: b.project, session: b.session, kind: b.kind, what: b.what.slice(0, 110), tokens: b.tokens, carried: b.carriedRequests, usd: r2(b.usd) })) },
    loops: { promptsOver100Requests: loops.filter((l) => l.requests > 100).length, usdInThem: r2(loops.filter((l) => l.requests > 100).reduce((a, l) => a + l.usd, 0)),
      top: [...loops].sort((a, b) => b.usd - a.usd).slice(0, TOP).map((l) => ({ project: l.project, session: l.session, requests: l.requests, usd: r2(l.usd), prompt: l.text, topCommand: l.topCommand })) },
  }
  if (opt('--out')) fs.writeFileSync(opt('--out'), JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 1))
}
