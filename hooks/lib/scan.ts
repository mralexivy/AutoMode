// Reading a transcript for habits. Pure: it takes the text of one Claude Code transcript (.jsonl) and returns numbers.
// No prompt text, reply text, path or project name leaves this function. Two booleans are read from text in memory and then dropped:
// whether a request ran a tool, and whether the assistant's reply ended with a question mark.
import { familyOf } from './prices.ts'
import type { Family } from './types.ts'
import { SURE_ENDED_MS, addPend, addPoints, dropPend, observeGapFeat, type Habits } from './habits.ts'
import { pointsOf, type Base } from './model.ts'

export interface Req { at: number; tokens: number; family: Family; acted: boolean; ttlMs: number | null; out: number; ask: boolean }
export interface Folded { prompts: number; promptsAt: number[]; entry: string | null; reqs: Req[] }

const typed = (r: any) => {
  if (r.type !== 'user' || r.isSidechain || r.isMeta || r.isCompactSummary) return false
  const c = r.message?.content
  if (typeof c === 'string') return !c.startsWith('<command-') && !c.startsWith('<local-command') && c.trim().length > 0
  return Array.isArray(c) && c.some((b: any) => b?.type === 'text' && b.text?.trim() && !b.text.startsWith('<command-')) && !c.some((b: any) => b?.type === 'tool_result')
}

export function foldTranscript(text: string): Folded {
  const by = new Map<string, Req>()
  const promptsAt: number[] = []
  let entry: string | null = null
  for (const line of text.split('\n')) {
    if (!line) continue
    let r: any
    try { r = JSON.parse(line) } catch { continue }
    if (entry === null && typeof r.entrypoint === 'string') entry = r.entrypoint
    if (typed(r)) { const t = Date.parse(r.timestamp); if (Number.isFinite(t)) promptsAt.push(t); continue }
    if (r.type !== 'assistant' || r.isSidechain || !r.message?.usage || !r.requestId) continue
    const u = r.message.usage
    const family = familyOf(String(r.message.model ?? ''))
    if (!family) continue
    const prev = by.get(r.requestId)
    const blocks: any[] = Array.isArray(r.message.content) ? r.message.content : []
    const acted = prev?.acted || blocks.some((b) => b?.type === 'tool_use')
    const said = blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join(' ').trim()
    const ask = prev?.ask || (said.length > 0 && /\?\s*$/.test(said))
    const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? 0
    const ttlMs = w1h > w5m ? 3_600_000 : w5m > 0 ? 300_000 : prev?.ttlMs ?? null
    by.set(r.requestId, { ttlMs, at: prev?.at ?? Date.parse(r.timestamp), tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), family, acted: !!acted, out: u.output_tokens ?? 0, ask: !!ask })
  }
  promptsAt.sort((a, b) => a - b)
  return { prompts: promptsAt.length, promptsAt, entry, reqs: [...by.values()].filter((q) => Number.isFinite(q.at)).sort((a, b) => a.at - b.at) }
}

const MIN_PROMPTS = 2
const DAY = 86_400_000
// A session is a person at a keyboard when it has two typed prompts and was not written by a script (`sdk-cli` is `claude -p`, which
// benchmarks, cron jobs and other tools use). On one machine 864 of 1,442 recent transcripts were scripts.
export const interactive = (f: Folded) => f.prompts >= MIN_PROMPTS && f.entry !== 'sdk-cli'

// baseAt: the features of the chat at request `i`, from what was known when that request ended: its size, how long the session has run,
// how many prompts the person had typed, how much the assistant wrote since the last prompt, and whether it ended on a question.
export function baseAt(s: Folded, i: number): Base {
  const a = s.reqs[i]
  let lastPrompt = s.reqs[0].at, prompts = 0
  for (const t of s.promptsAt) { if (t <= a.at) { prompts += 1; lastPrompt = t } else break }
  let turnOut = 0
  for (const q of s.reqs) if (q.at >= lastPrompt - 1000 && q.at <= a.at) turnOut += q.out
  return { tokens: a.tokens, ageMin: (a.at - s.reqs[0].at) / 60_000, prompts, turnOut, asked: a.ask }
}

// Compact is all the habits need from a session: whether it was interactive, each idle gap of three minutes or more with the features of
// the request before it, and its last request. Rows are [endAt, gapMin, tokens, acted, ageMin, prompts, turnOut, asked]. The last request
// is [at, tokens, ageMin, prompts, turnOut, asked]. scripts/habits-fold.mjs makes the same shape from a huge file without loading it,
// in the person's own node. A test keeps the two equal.
export interface Compact { interactive: boolean; gaps: [number, number, number, boolean, number, number, number, boolean][]; last: [number, number, number, number, number, boolean] | null }
export function compactOf(s: Folded): Compact {
  const gaps: Compact['gaps'] = []
  for (let i = 1; i < s.reqs.length; i++) {
    const a = s.reqs[i - 1], b = s.reqs[i]
    const gapMin = (b.at - a.at) / 60_000
    if (gapMin >= 3) { const f = baseAt(s, i - 1); gaps.push([b.at, gapMin, a.tokens, a.acted, f.ageMin, f.prompts, f.turnOut, f.asked]) }
  }
  const n = s.reqs.length
  const f = n ? baseAt(s, n - 1) : null
  return { interactive: interactive(s), gaps, last: f ? [s.reqs[n - 1].at, f.tokens, f.ageMin, f.prompts, f.turnOut, f.asked] : null }
}

// observeCompact adds one transcript. A gap counts when the request that ended it is newer than the watermark, so a file read again
// after it grew counts only what is new. A gap after a request that called a tool is tool time and is skipped. A gap of a day or more is
// an end: no keepalive horizon reaches it. The last request is a pending end until the file has been quiet for SURE_ENDED_MS.
// `fid` names the transcript, so a session that resumes cancels its pending end.
export function observeCompact(h: Habits, c: Compact, now: number, fid: string): Habits {
  let out = dropPend(h, fid)
  if (!c.interactive) return out
  const pts: number[][] = []
  for (const [endAt, gapMin, tokens, acted, ageMin, prompts, turnOut, asked] of c.gaps) {
    if (endAt <= h.watermark || (h.liveFrom > 0 && endAt >= h.liveFrom) || acted) continue
    pts.push(...pointsOf({ tokens, ageMin, prompts, turnOut, asked }, gapMin >= 1440 ? Infinity : gapMin))
  }
  if (c.last) {
    const [at, tokens, ageMin, prompts, turnOut, asked] = c.last
    if (now - at > SURE_ENDED_MS) pts.push(...pointsOf({ tokens, ageMin, prompts, turnOut, asked }, Infinity))
    else out = addPend(out, fid, [at, tokens, ageMin, prompts, turnOut, asked ? 1 : 0])
  }
  return { ...addPoints(out, pts), sessions: out.sessions + 1 }
}
export const observeFolded = (h: Habits, s: Folded, now: number, fid = 'f'): Habits => observeCompact(h, compactOf(s), now, fid)

// finishScan moves the watermark once every file was read, unless one failed: a file that could not be read must be tried again.
export const finishScan = (h: Habits, newest: number, failed: number): Habits => ({ ...h, watermark: failed ? h.watermark : Math.max(h.watermark, newest) })
export { DAY, observeGapFeat }
