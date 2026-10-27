#!/usr/bin/env node
// AutoMode usage report. Reads Claude Code transcript JSONL files and prints the
// actual model calls, tokens, cache use, and durations for one session, including subagents
// and workflow agents. Cost is an API-list-price estimate, not a subscription charge.
//
// Usage: node am-usage.mjs [sessionId | --latest] [--json] [--trace] [--routes [--all]]
//   default session: $CLAUDE_CODE_SESSION_ID, else the most recent session.
//   --trace adds one row per subagent transcript: stage, role, label, model, tokens, cache, duration,
//   and estimated cost. A usage field that no message reported is null ("unknown"), never 0.
//   The report holds counts only: no prompt text and no file contents.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const PROJECTS = path.join(CONFIG_DIR, 'projects')

// USD per million tokens, API list prices. Source: platform.claude.com models overview, read 2026-10-17.
// Cache write multipliers (5m = 1.25x input, 1h = 2x input) are the standard API rates: check them on the pricing page.
const PRICES = [
  { match: /opus-5-5|opus-5\.5/,     input: 4,    output: 20,  cacheReadX: 0.05 },
  { match: /sonnet-5-5|sonnet-5\.5/, input: 2,    output: 10,  cacheReadX: 0.05 },
  { match: /haiku-5-5|haiku-5\.5/,   input: 0.10, output: 0.50, cacheReadX: 0.10, note: 'Haiku 5.5 is listed as "from" this price' },
]
const priceFor = (m) => PRICES.find((p) => p.match.test(m))

const argv = process.argv.slice(2)
// --routes: the V4 router's request and decision records for this session (scripts/am-routes.mjs).
if (argv.includes('--routes')) { await import('./am-routes.mjs'); process.exit(0) }
// --kpi: cost per accepted task and the secondary metrics, from the router's records (scripts/am-kpi.mjs).
if (argv.includes('--kpi')) { await import('./am-kpi.mjs'); process.exit(0) }
const asJson = argv.includes('--json')
const withTrace = argv.includes('--trace')
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
let sourceVersion = 'unknown'
try { sourceVersion = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version || 'unknown' } catch {}
let sid = argv.find((a) => !a.startsWith('--'))
if (!sid && !argv.includes('--latest')) sid = process.env.CLAUDE_CODE_SESSION_ID

function findSessionFile(id) {
  let best = null
  for (const proj of fs.readdirSync(PROJECTS)) {
    const dir = path.join(PROJECTS, proj)
    let entries
    try { entries = fs.readdirSync(dir) } catch { continue }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue
      const p = path.join(dir, f)
      if (id) { if (f === `${id}.jsonl`) return p; continue }
      const t = fs.statSync(p).mtimeMs
      if (!best || t > best.t) best = { p, t }
    }
  }
  return best && best.p
}

function walk(dir, out = []) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.jsonl') && e.name !== 'journal.jsonl') out.push(p)
  }
  return out
}

const mainFile = findSessionFile(sid)
if (!mainFile) { console.error(`No transcript found for session ${sid || '(latest)'} under ${PROJECTS}`); process.exit(1) }
const sessionId = path.basename(mainFile, '.jsonl')
const subFiles = walk(path.join(path.dirname(mainFile), sessionId, 'subagents'))

function readMeta(file) {
  try { return JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')) } catch { return {} }
}

// One streamed API response writes several lines with the same message.id. Keep the last one.
function collect(file) {
  const msgs = new Map()
  let first = null, last = null
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (d.timestamp) { first = first || d.timestamp; last = d.timestamp }
    if (d.type !== 'assistant' || !d.message || !d.message.usage) continue
    const m = d.message
    if (!m.model || m.model === '<synthetic>') continue
    msgs.set(m.id || `${file}:${msgs.size}`, { model: m.model, u: m.usage })
  }
  return { msgs: [...msgs.values()], first, last }
}

const rows = {}       // model -> totals
const sources = []    // per transcript file
const traceRows = []  // per subagent transcript, for --trace

// sumUsage totals one transcript's messages. A field stays null when no message reported it.
function sumUsage(msgs) {
  const t = { calls: msgs.length, input: null, output: null, cache_read: null, cache_write: null, est_usd: null }
  const addTo = (k, v) => { if (typeof v === 'number') t[k] = (t[k] ?? 0) + v }
  for (const { model, u } of msgs) {
    addTo('input', u.input_tokens)
    addTo('output', u.output_tokens)
    addTo('cache_read', u.cache_read_input_tokens)
    const cc = u.cache_creation || {}
    const w = (cc.ephemeral_5m_input_tokens ?? null) !== null || (cc.ephemeral_1h_input_tokens ?? null) !== null
      ? (cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0)
      : u.cache_creation_input_tokens
    addTo('cache_write', w)
    const r = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite5m: cc.ephemeral_5m_input_tokens ?? u.cache_creation_input_tokens ?? 0, cacheWrite1h: cc.ephemeral_1h_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 }
    const c = cost(model, r)
    if (c !== null) t.est_usd = (t.est_usd ?? 0) + c
  }
  return t
}
function add(model, u) {
  const r = rows[model] || (rows[model] = { calls: 0, input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 })
  r.calls += 1
  r.input += u.input_tokens || 0
  r.output += u.output_tokens || 0
  const cc = u.cache_creation || {}
  const w5 = cc.ephemeral_5m_input_tokens, w1 = cc.ephemeral_1h_input_tokens
  if (w5 != null || w1 != null) { r.cacheWrite5m += w5 || 0; r.cacheWrite1h += w1 || 0 }
  else r.cacheWrite5m += u.cache_creation_input_tokens || 0
  r.cacheRead += u.cache_read_input_tokens || 0
}

for (const [file, kind] of [[mainFile, 'main'], ...subFiles.map((f) => [f, 'sub'])]) {
  const { msgs, first, last } = collect(file)
  const meta = kind === 'main' ? {} : readMeta(file)
  const models = {}
  for (const { model, u } of msgs) { add(model, u); models[model] = (models[model] || 0) + 1 }
  if (!msgs.length) continue
  if (withTrace) {
    traceRows.push({
      session_id: path.basename(mainFile, '.jsonl'),
      stage: kind === 'main' ? 'main' : meta.workflowPhase || null,
      role: kind === 'main' ? 'main' : meta.agentType || null,
      label: kind === 'main' ? null : meta.description || null,
      model_id: Object.keys(models).join(', '),
      duration_s: first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 1000) : null,
      source_version: sourceVersion,
      ...sumUsage(msgs),
    })
  }
  sources.push({
    source: kind === 'main' ? 'main conversation' : [meta.agentType, meta.workflowPhase, meta.description].filter(Boolean).join(' / ') || path.basename(file),
    models: Object.keys(models).join(', '),
    calls: msgs.length,
    durationS: first && last ? Math.round((Date.parse(last) - Date.parse(first)) / 1000) : null,
  })
}

function cost(model, r) {
  const p = priceFor(model)
  if (!p) return null
  const M = 1e6
  return (r.input * p.input + r.output * p.output + r.cacheWrite5m * p.input * 1.25 + r.cacheWrite1h * p.input * 2 + r.cacheRead * p.input * p.cacheReadX) / M
}

const report = {
  sessionId,
  transcript: mainFile,
  subagentTranscripts: subFiles.length,
  byModel: Object.entries(rows).map(([model, r]) => ({ model, ...r, estUsd: cost(model, r) })),
  bySource: sources,
  ...(withTrace ? { sourceVersion, trace: traceRows } : {}),
}

if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0) }

const n = (x) => (x == null ? '-' : x.toLocaleString('en-US'))
const usd = (x) => (x == null ? 'n/a' : `$${x.toFixed(2)}`)
console.log(`AutoMode usage for session ${sessionId}`)
console.log(`Transcripts: 1 main + ${subFiles.length} subagent/workflow\n`)
console.log('| Model | Calls | Input | Output | Cache write | Cache read | Est. API cost |')
console.log('|---|---:|---:|---:|---:|---:|---:|')
let total = 0
for (const r of report.byModel) {
  if (r.estUsd != null) total += r.estUsd
  console.log(`| ${r.model} | ${n(r.calls)} | ${n(r.input)} | ${n(r.output)} | ${n(r.cacheWrite5m + r.cacheWrite1h)} | ${n(r.cacheRead)} | ${usd(r.estUsd)} |`)
}
console.log(`\nEstimated API-equivalent total: ${usd(total)} (models without a price row are excluded).`)
console.log('This is an estimate at API list prices. It is not your subscription charge or quota use.\n')
console.log('| Source | Models | Calls | Duration |')
console.log('|---|---|---:|---:|')
for (const s of sources) console.log(`| ${s.source} | ${s.models} | ${s.calls} | ${s.durationS == null ? '-' : s.durationS + 's'} |`)
if (withTrace) {
  const v = (x) => (x == null ? 'unknown' : n(x))
  console.log(`\nTrace by stage (plugin ${sourceVersion}):\n`)
  console.log('| Stage | Role | Label | Model | Calls | Input | Output | Cache read | Cache write | Duration | Est. API cost |')
  console.log('|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|')
  for (const r of traceRows) console.log(`| ${r.stage ?? '-'} | ${r.role ?? '-'} | ${r.label ?? '-'} | ${r.model_id} | ${r.calls} | ${v(r.input)} | ${v(r.output)} | ${v(r.cache_read)} | ${v(r.cache_write)} | ${r.duration_s == null ? '-' : r.duration_s + 's'} | ${r.est_usd == null ? 'unknown' : usd(r.est_usd)} |`)
}
