// @ts-nocheck TODO(types): 10 errors with strict off. Fix them and delete this line to turn checking on for this file.
// Read-only loader for Claude Code transcripts (~/.claude*/projects/*/*.jsonl). It returns, per
// session, the person-typed prompts in order, each with the main-thread requests it caused, plus the
// subagent requests. A request carries what the API reported (usage, model) and, where the transcript
// has an api-request record, the parameters Claude Code sent (model, output_config.effort).
// Nothing here writes, and no prompt text leaves this module unless a caller asks for it.
import fs from 'node:fs'
import path from 'node:path'

export function listTranscripts(roots) {
  const out = []
  for (const root of roots) {
    let dirs = []
    try { dirs = fs.readdirSync(root) } catch { continue }
    for (const d of dirs) {
      let files = []
      try { files = fs.readdirSync(path.join(root, d)) } catch { continue }
      for (const f of files) if (f.endsWith('.jsonl')) out.push(path.join(root, d, f))
    }
  }
  return out
}

export function parseLines(file) {
  const out = []
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l) continue
    try { out.push(JSON.parse(l)) } catch {}
  }
  return out
}

export const isPersonPrompt = (r) => {
  if (r.type !== 'user' || r.isSidechain || r.isMeta || r.isCompactSummary) return false
  const c = r.message?.content
  if (typeof c === 'string') return !c.startsWith('<command-') && !c.startsWith('<local-command') && c.trim().length > 0
  if (!Array.isArray(c)) return false
  return c.some((b) => b?.type === 'text' && b.text?.trim() && !b.text.startsWith('<command-')) && !c.some((b) => b?.type === 'tool_result')
}

// Thinking tokens are part of output_tokens (billed as output). `thinking` is reported beside output,
// never added to it.
export function tokensOf(u = {}) {
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h)
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite5m: w5m, cacheWrite1h: w1h, thinking: u.output_tokens_details?.thinking_tokens ?? null }
}

// A streamed response writes several assistant lines with one requestId; the last line carries the
// final usage (output grows while streaming). The request counts once, with its last usage.
export function requestsOf(L) {
  const by = new Map()
  for (const r of L) {
    if (r.type !== 'assistant' || !r.message?.usage || !r.requestId) continue
    const prev = by.get(r.requestId)
    // incomplete: the response's last line still has stop_reason null, so the final usage (from the
    // closing message_delta) was never written. This happens when a workflow agent ends on its
    // StructuredOutput call: the transcript keeps a partial output count. Its true output is unknown here.
    const req = { at: prev?.at ?? Date.parse(r.timestamp), requestId: r.requestId, model: r.message.model, appEffort: r.effort ?? null, sidechain: !!r.isSidechain, tokens: tokensOf(r.message.usage), incomplete: r.message.stop_reason == null, line: prev?.line ?? r }
    by.set(r.requestId, req)
  }
  return by
}

// Subagent transcripts live next to the session: <session>/subagents/**/agent-*.jsonl with a .meta.json.
export function loadSubagents(file) {
  const dir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents')
  const out = []
  const walk = (d) => {
    let es = []
    try { es = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.jsonl')) {
        let meta = {}
        try { meta = JSON.parse(fs.readFileSync(p.replace(/\.jsonl$/, '.meta.json'), 'utf8')) } catch {}
        const type = String(meta.agentType ?? 'unknown')
        const role = /review/i.test(type) ? 'reviewer' : /explorer|diagnoser|Explore/i.test(type) ? 'worker' : meta.workflowPhase ? 'workflow' : 'subagent'
        const modelSet = meta.model ? 'explicit' : 'inherited or definition'
        for (const r of requestsOf(parseLines(p)).values()) out.push({ ...r, agentType: type, role, modelSet, agentFile: p, line: undefined })
      }
    }
  }
  walk(dir)
  return out
}

// queued: a message the person typed while a turn ran is stored as a `queued_command` attachment with humanTurn: true,
// not as a user line. With queued, it is a prompt of its own (marked midTurn); without, prompts stay as before.
const queuedText = (r) => {
  const p = r.attachment?.prompt
  return typeof p === 'string' ? p : Array.isArray(p) ? p.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : ''
}
const isQueuedPersonPrompt = (r) => r.attachment?.type === 'queued_command' && r.attachment?.humanTurn === true

export function loadSession(file, { withText = false, subagents = false, queued = false } = {}) {
  const L = parseLines(file)
  const sessionId = L.find((r) => r.sessionId)?.sessionId ?? path.basename(file, '.jsonl')
  const sent = L.filter((r) => r.type === 'api-request').map((r) => ({ at: Date.parse(r.timestamp), model: r.params?.model ?? null, effort: r.params?.output_config?.effort ?? null, betas: r.params?.betas ?? [], querySource: r.querySource }))
  const reqs = requestsOf(L)
  const prompts = []
  const sidechain = []
  const counted = new Set()
  let current = null
  let mainIndex = 0
  for (const r of L) {
    if (queued && isQueuedPersonPrompt(r)) {
      const text = queuedText(r)
      current = { at: Date.parse(r.attachment.timestamp ?? r.timestamp), chars: text.length, requests: [], midTurn: true, ...(withText ? { text } : {}) }
      prompts.push(current)
      continue
    }
    if (isPersonPrompt(r)) {
      const text = typeof r.message.content === 'string' ? r.message.content : r.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      current = { at: Date.parse(r.timestamp), chars: text.length, requests: [], ...(withText ? { text } : {}) }
      prompts.push(current)
      continue
    }
    if (r.type === 'system' && r.subtype === 'compact_boundary' && current) current.compacted = true
    if (r.type !== 'assistant' || !r.requestId || counted.has(r.requestId) || !reqs.has(r.requestId)) continue
    counted.add(r.requestId)
    const { line, ...req } = reqs.get(r.requestId)
    if (req.sidechain) { sidechain.push(req); continue }
    // Pair with the api-request record in order: the main thread's sent parameters.
    const s = sent[mainIndex]
    if (s && s.model === req.model) { req.sentEffort = s.effort; req.sentModel = s.model; req.perMessageEffortBeta = s.betas.some((b) => /mid-conversation-output-config|per-turn-control/.test(b)) }
    mainIndex += 1
    if (current) current.requests.push(req)
  }
  return { sessionId, file, prompts, sidechain, subagents: subagents ? loadSubagents(file) : [], apiRequests: sent.length }
}

export function recordsBySession(file) {
  const by = new Map()
  if (!fs.existsSync(file)) return by
  for (const r of parseLines(file)) {
    if (!r.sessionId) continue
    if (!by.has(r.sessionId)) by.set(r.sessionId, [])
    by.get(r.sessionId).push(r)
  }
  return by
}

export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null }
export const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] : null }

// readRecords reads the router's records from a plugin data folder: per-session files under records/
// and the legacy decisions.jsonl.
export function readRecords(dataDir) {
  const out = []
  const files = []
  for (const f of ['decisions.jsonl.1', 'decisions.jsonl']) files.push(path.join(dataDir, f))
  try { for (const f of fs.readdirSync(path.join(dataDir, 'records'))) if (/\.jsonl(\.1)?$/.test(f)) files.push(path.join(dataDir, 'records', f)) } catch {}
  for (const f of files) { if (fs.existsSync(f)) out.push(...parseLines(f)) }
  return out
}
