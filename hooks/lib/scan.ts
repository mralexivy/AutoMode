// Reading a transcript for habits. Pure: it takes the text of one Claude Code transcript (.jsonl) and returns numbers.
// No prompt text, reply text, path or project name leaves this function: only request times, sizes, the model family
// and whether a request called a tool, plus how many prompts a person typed.
import { familyOf } from './prices.ts'
import type { Family } from './types.ts'
import { EMPTY_HABITS, keyOf, ctxOf, observeEnd, observeGap, type Habits } from './habits.ts'

export interface Req { at: number; tokens: number; family: Family; acted: boolean; ttlMs: number | null }
export interface Folded { prompts: number; reqs: Req[] }

const typed = (r: any) => {
  if (r.type !== 'user' || r.isSidechain || r.isMeta || r.isCompactSummary) return false
  const c = r.message?.content
  if (typeof c === 'string') return !c.startsWith('<command-') && !c.startsWith('<local-command') && c.trim().length > 0
  return Array.isArray(c) && c.some((b: any) => b?.type === 'text' && b.text?.trim() && !b.text.startsWith('<command-')) && !c.some((b: any) => b?.type === 'tool_result')
}

export function foldTranscript(text: string): Folded {
  const by = new Map<string, Req>()
  let prompts = 0
  for (const line of text.split('\n')) {
    if (!line) continue
    let r: any
    try { r = JSON.parse(line) } catch { continue }
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
  return { prompts, reqs: [...by.values()].filter((q) => Number.isFinite(q.at)).sort((a, b) => a.at - b.at) }
}

const DAY = 86_400_000
const MIN_PROMPTS = 2 // a one-prompt session is a script or a benchmark run, not a person at a keyboard

// Compact is all the habits need from a session: its typed prompts, each idle gap with the request before it, and its last request.
// scripts/habits-fold.mjs makes the same shape from a huge file without loading it, in the person's own node. A test keeps the two equal.
export interface Compact { prompts: number; gaps: [endAt: number, gapMin: number, tokens: number, family: Family, acted: boolean][]; last: { at: number; tokens: number; family: Family; acted: boolean } | null }
export function compactOf(s: Folded): Compact {
  const gaps: Compact['gaps'] = []
  for (let i = 1; i < s.reqs.length; i++) {
    const a = s.reqs[i - 1], b = s.reqs[i]
    const gapMin = (b.at - a.at) / 60_000
    if (gapMin >= 3) gaps.push([b.at, gapMin, a.tokens, a.family, a.acted])
  }
  const l = s.reqs[s.reqs.length - 1]
  return { prompts: s.prompts, gaps, last: l ? { at: l.at, tokens: l.tokens, family: l.family, acted: l.acted } : null }
}

// observeFolded adds one session. A gap counts when the request that ended it is newer than the watermark, so a file read
// again after it grew counts only what is new. The last request counts as an end once it is a day old.
export const observeFolded = (h: Habits, s: Folded, now: number): Habits => observeCompact(h, compactOf(s), now)
export function observeCompact(h: Habits, c: Compact, now: number): Habits {
  if (c.prompts < MIN_PROMPTS || !c.last) return h
  let out = h
  for (const [endAt, gapMin, tokens, family, acted] of c.gaps) {
    if (endAt <= h.watermark) continue
    out = observeGap(out, keyOf(ctxOf(tokens), family, acted), gapMin)
  }
  if (now - c.last.at > DAY && c.last.at > h.finalsAt) out = observeEnd(out, keyOf(ctxOf(c.last.tokens), c.last.family, c.last.acted))
  return { ...out, sessions: out.sessions + 1 }
}

// finishScan moves the watermarks once every file is read.
export const finishScan = (h: Habits, newest: number, now: number): Habits => ({ ...h, watermark: Math.max(h.watermark, newest), finalsAt: Math.max(h.finalsAt, now - DAY) })
export { EMPTY_HABITS }
