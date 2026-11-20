// Reading a transcript for habits. Pure: it takes the text of one Claude Code transcript (.jsonl) and returns numbers.
// No prompt text, reply text, path or project name leaves this function: only request times, sizes, the model family, whether a
// request called a tool, how many prompts a person typed, and which Claude Code surface wrote the file.
import { familyOf } from './prices.ts'
import type { Family } from './types.ts'
import { SURE_ENDED_MS, addPend, ctxOf, dropPend, observeEnd, observeGap, type Habits } from './habits.ts'

export interface Req { at: number; tokens: number; family: Family; acted: boolean; ttlMs: number | null }
export interface Folded { prompts: number; entry: string | null; reqs: Req[] }

const typed = (r: any) => {
  if (r.type !== 'user' || r.isSidechain || r.isMeta || r.isCompactSummary) return false
  const c = r.message?.content
  if (typeof c === 'string') return !c.startsWith('<command-') && !c.startsWith('<local-command') && c.trim().length > 0
  return Array.isArray(c) && c.some((b: any) => b?.type === 'text' && b.text?.trim() && !b.text.startsWith('<command-')) && !c.some((b: any) => b?.type === 'tool_result')
}

export function foldTranscript(text: string): Folded {
  const by = new Map<string, Req>()
  let prompts = 0
  let entry: string | null = null
  for (const line of text.split('\n')) {
    if (!line) continue
    let r: any
    try { r = JSON.parse(line) } catch { continue }
    if (entry === null && typeof r.entrypoint === 'string') entry = r.entrypoint
    if (typed(r)) { prompts += 1; continue }
    if (r.type !== 'assistant' || r.isSidechain || !r.message?.usage || !r.requestId) continue
    const u = r.message.usage
    const family = familyOf(String(r.message.model ?? ''))
    if (!family) continue
    const prev = by.get(r.requestId)
    const acted = prev?.acted || (Array.isArray(r.message.content) && r.message.content.some((b: any) => b?.type === 'tool_use'))
    const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0
    const ttlMs = w1h > w5m ? 3_600_000 : w5m > 0 ? 300_000 : prev?.ttlMs ?? null
    by.set(r.requestId, { ttlMs, at: prev?.at ?? Date.parse(r.timestamp), tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), family, acted: !!acted })
  }
  return { prompts, entry, reqs: [...by.values()].filter((q) => Number.isFinite(q.at)).sort((a, b) => a.at - b.at) }
}

const MIN_PROMPTS = 2
const DAY = 86_400_000
// A session is a person at a keyboard when it has two typed prompts and was not written by a script (`sdk-cli` is `claude -p`, which
// benchmarks, cron jobs and other tools use). On one machine 864 of 1,442 recent transcripts were scripts.
export const interactive = (f: Folded) => f.prompts >= MIN_PROMPTS && f.entry !== 'sdk-cli'

// Compact is all the habits need from a session: whether it was interactive, each idle gap of three minutes or more with the size and
// tool use of the request before it, and its last request. scripts/habits-fold.mjs makes the same shape from a huge file without
// loading it, in the person's own node. A test keeps the two equal.
export interface Compact { interactive: boolean; gaps: [endAt: number, gapMin: number, tokens: number, acted: boolean][]; last: { at: number; tokens: number } | null }
export function compactOf(s: Folded): Compact {
  const gaps: Compact['gaps'] = []
  for (let i = 1; i < s.reqs.length; i++) {
    const a = s.reqs[i - 1], b = s.reqs[i]
    const gapMin = (b.at - a.at) / 60_000
    if (gapMin >= 3) gaps.push([b.at, gapMin, a.tokens, a.acted])
  }
  const l = s.reqs[s.reqs.length - 1]
  return { interactive: interactive(s), gaps, last: l ? { at: l.at, tokens: l.tokens } : null }
}

// observeCompact adds one transcript. A gap counts when the request that ended it is newer than the watermark, so a file read again
// after it grew counts only what is new. A gap after a request that called a tool is tool time and is skipped. A gap of a day or more is
// an end: no keepalive horizon reaches it. The last request is a pending end until the file has been quiet for SURE_ENDED_MS.
// `fid` names the transcript, so a session that resumes cancels its pending end.
export function observeCompact(h: Habits, c: Compact, now: number, fid: string): Habits {
  let out = dropPend(h, fid)
  if (!c.interactive || !c.last) return out
  for (const [endAt, gapMin, tokens, acted] of c.gaps) {
    if (endAt <= h.watermark || acted) continue
    out = gapMin >= 1440 ? observeEnd(out, ctxOf(tokens)) : observeGap(out, ctxOf(tokens), gapMin)
  }
  out = now - c.last.at > SURE_ENDED_MS ? observeEnd(out, ctxOf(c.last.tokens)) : addPend(out, fid, ctxOf(c.last.tokens), c.last.at)
  return { ...out, sessions: out.sessions + 1 }
}
export const observeFolded = (h: Habits, s: Folded, now: number, fid = 'f'): Habits => observeCompact(h, compactOf(s), now, fid)

// finishScan moves the watermark once every file was read, unless one failed: a file that could not be read must be tried again.
export const finishScan = (h: Habits, newest: number, failed: number): Habits => ({ ...h, watermark: failed ? h.watermark : Math.max(h.watermark, newest) })
export { DAY }
