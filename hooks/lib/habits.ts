// Habits: what one person's idle gaps look like, kept as counts. Pure: no `$`, no I/O.
//
// A cell holds, for one kind of request (context size, model family, whether the request called a tool), how long the
// person then stayed away: a count per gap length, and a count of requests that were the last of their session. From
// the counts, `returnProb` answers "this chat has been idle for t minutes: how likely is a prompt in the next w
// minutes?", and `pingValue` turns that into dollars for the cache keeper. The file holds counts, never text, paths or
// times of day, and stays small: counts halve when they pass a cap, so old habits fade.
import { cacheWriteX, rateAt, type Rate } from './prices.ts'
import type { Family } from './types.ts'

export type CtxBucket = 'small' | 'mid' | 'big'
export const ctxOf = (tokens: number): CtxBucket => (tokens < 60_000 ? 'small' : tokens < 150_000 ? 'mid' : 'big')

// Gap buckets in minutes: bucket i is [EDGES[i], EDGES[i+1]), and the last one runs to a day. Shorter gaps are normal flow.
export const EDGES = [3, 6, 15, 30, 60, 120, 240, 480] as const
const TOP = 1440
const hi = (i: number) => (i + 1 < EDGES.length ? EDGES[i + 1] : TOP)
export const bucketOfGap = (min: number) => { let b = -1; for (let i = 0; i < EDGES.length; i++) if (min >= EDGES[i]) b = i; return b }

export interface Cell { gaps: number[]; ends: number }
// kw is the keepalive's own ledger for this person: what its pings cost, what the rewrites they avoided would have cost,
// and whether the person ever said yes to it. Both sums halve when large, so recent weeks weigh most.
export interface Ledger { pingUsd: number; savedUsd: number; optIn: boolean }
export interface Habits { v: 1; watermark: number; finalsAt: number; sessions: number; cells: Record<string, Cell>; kw: Ledger }
export const EMPTY_HABITS: Habits = { v: 1, watermark: 0, finalsAt: 0, sessions: 0, cells: {}, kw: { pingUsd: 0, savedUsd: 0, optIn: false } }

const CAP = 4_000
export const keyOf = (ctx: CtxBucket, family: Family, acted: boolean) => `${ctx}|${family}|${acted ? 'a' : 'n'}`
const emptyCell = (): Cell => ({ gaps: EDGES.map(() => 0), ends: 0 })

export function parseHabits(text: string): Habits {
  try {
    const j = JSON.parse(text) as Partial<Habits>
    if (j.v !== 1 || !j.cells || typeof j.cells !== 'object') return EMPTY_HABITS
    const cells: Record<string, Cell> = {}
    for (const [k, c] of Object.entries(j.cells)) {
      if (!/^(small|mid|big)\|(haiku|sonnet|opus)\|[an]$/.test(k)) continue
      if (!Array.isArray(c?.gaps) || c.gaps.length !== EDGES.length || !c.gaps.every((n) => Number.isFinite(n) && n >= 0) || !Number.isFinite(c.ends) || c.ends < 0) continue
      cells[k] = { gaps: c.gaps.map((n) => Math.round(n)), ends: Math.round(c.ends) }
    }
    const kw = (j.kw ?? {}) as Partial<Ledger>
    const usd = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0)
    return { v: 1, watermark: Number(j.watermark) || 0, finalsAt: Number(j.finalsAt) || 0, sessions: Number(j.sessions) || 0, cells, kw: { pingUsd: usd(kw.pingUsd), savedUsd: usd(kw.savedUsd), optIn: kw.optIn === true } }
  } catch {
    return EMPTY_HABITS
  }
}

const total = (h: Habits) => Object.values(h.cells).reduce((a, c) => a + c.ends + c.gaps.reduce((x, y) => x + y, 0), 0)
function halveIfBig(h: Habits): Habits {
  if (total(h) <= CAP) return h
  const cells: Record<string, Cell> = {}
  for (const [k, c] of Object.entries(h.cells)) cells[k] = { gaps: c.gaps.map((n) => Math.floor(n / 2)), ends: Math.floor(c.ends / 2) }
  return { ...h, cells }
}

// observeGap counts one idle gap that ended with a new request.
export function observeGap(h: Habits, key: string, gapMin: number): Habits {
  const b = bucketOfGap(gapMin)
  if (b < 0) return h
  const c = h.cells[key] ?? emptyCell()
  const gaps = c.gaps.slice()
  gaps[b] += 1
  return halveIfBig({ ...h, cells: { ...h.cells, [key]: { gaps, ends: c.ends } } })
}

// observeEnd counts a request after which the person never came back (the session's last).
export function observeEnd(h: Habits, key: string): Habits {
  const c = h.cells[key] ?? emptyCell()
  return halveIfBig({ ...h, cells: { ...h.cells, [key]: { gaps: c.gaps, ends: c.ends + 1 } } })
}

// noteKeepalive adds what one idle gap's pings cost and saved to the ledger.
export function noteKeepalive(h: Habits, pingUsd: number, savedUsd: number): Habits {
  let { pingUsd: p, savedUsd: v } = h.kw
  p += pingUsd; v += savedUsd
  if (p > 20) { p /= 2; v /= 2 }
  return { ...h, kw: { ...h.kw, pingUsd: p, savedUsd: v } }
}
export const optIn = (h: Habits, yes: boolean): Habits => ({ ...h, kw: { ...h.kw, optIn: yes } })

// A prior for a kind of chat nobody has measured: from one person's 60 days, a big context came back within the hour
// about 70% of the time and a small one about 4%. The prior is cut well below that, and counts for K observations.
const PRIOR_60 = { small: 0.05, mid: 0.15, big: 0.35 } as const
const K = 6
const overlap = (lo: number, top: number, a: number, b: number) => Math.max(0, Math.min(top, b) - Math.max(lo, a)) / (top - lo)

// returnProb: the chance that a prompt arrives within `windowMin` minutes, for a chat of this kind that has already been
// idle `idleMin` minutes. `acted` null pools both kinds. Sessions that ended count as never returning.
export function returnProb(h: Habits, ctx: CtxBucket, family: Family | null, acted: boolean | null, idleMin: number, windowMin = 60): { p: number; seen: number } {
  let alive = 0, back = 0
  for (const [k, c] of Object.entries(h.cells)) {
    const [kc, kf, ka] = k.split('|')
    if (kc !== ctx || (family !== null && kf !== family) || (acted !== null && ka !== (acted ? 'a' : 'n'))) continue
    alive += c.ends
    for (let i = 0; i < EDGES.length; i++) {
      alive += c.gaps[i] * overlap(EDGES[i], hi(i), idleMin, Infinity)
      back += c.gaps[i] * overlap(EDGES[i], hi(i), idleMin, idleMin + windowMin)
    }
  }
  const prior = Math.min(0.9, PRIOR_60[ctx] * (windowMin / 60))
  return { p: (back + K * prior) / (alive + K), seen: Math.round(alive) }
}

export interface PingValue { pReturn: number; seen: number; saveUsd: number; costUsd: number; net: number }

// pingValue prices keeping one chat warm for the next `windowMin` minutes. The saving is a rewrite avoided, less the
// read that replaces it. The cost is every ping in the window, each a read of the whole prefix.
export function pingValue(o: { habits: Habits; prefixTokens: number; family: Family; acted: boolean | null; idleMin: number; ttlMs: number; rate: Rate; windowMin?: number }): PingValue {
  const w = o.windowMin ?? 60
  const r = rateAt(o.rate, o.prefixTokens)
  const read = (o.prefixTokens * r.input * r.cacheReadX) / 1e6
  const rewrite = (o.prefixTokens * r.input * cacheWriteX(o.ttlMs)) / 1e6
  const every = Math.max(1, (o.ttlMs - (o.ttlMs >= 3_600_000 ? 8 * 60_000 : 90_000)) / 60_000)
  const { p, seen } = returnProb(o.habits, ctxOf(o.prefixTokens), o.family, o.acted, o.idleMin, w)
  const saveUsd = p * (rewrite - read)
  const costUsd = (w / every) * read
  return { pReturn: p, seen, saveUsd, costUsd, net: saveUsd - costUsd }
}
