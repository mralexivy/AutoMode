// Habits: what one person's idle gaps look like, kept as counts. Pure: no `$`, no I/O.
//
// A cell holds, for one size of chat, how long the person then stayed away: a count per gap length, and a count of sessions that
// ended there. From the counts, `returnProb` answers "this chat has been idle for t minutes: how likely is a prompt in the next w
// minutes?". The file holds counts, never text, paths or times of day.
//
// What an audit of this estimator on real data found, and what the code now does about it:
//  - Cells split by model and by tool use were too thin and no better than one number per chat size. Cells are by size only.
//  - A gap after a request that called a tool is mostly tool time, not a person returning. Those gaps are not counted.
//  - A session that ended counts as never returning only once it is old enough to be sure; younger ones wait in `pend`.
//  - A prior pulled the estimate up at long idle times. The prior now fades with idle time, and a person's own counts take over
//    as they accumulate (full weight at PERSONAL_FULL observations).
//  - Counts halve past a cap as floats, so rare long gaps do not round to zero.
import { cacheWriteX, rateAt, type Rate } from './prices.ts'

export type CtxBucket = 'small' | 'mid' | 'big'
export const ctxOf = (tokens: number): CtxBucket => (tokens < 60_000 ? 'small' : tokens < 150_000 ? 'mid' : 'big')

// Gap buckets in minutes: bucket i is [EDGES[i], EDGES[i+1]), and the last one runs to a day. Shorter gaps are normal flow.
export const EDGES = [3, 6, 15, 30, 60, 120, 240, 480] as const
const TOP = 1440
const hi = (i: number) => (i + 1 < EDGES.length ? EDGES[i + 1] : TOP)
export const bucketOfGap = (min: number) => { let b = -1; for (let i = 0; i < EDGES.length; i++) if (min >= EDGES[i]) b = i; return b }

export interface Cell { gaps: number[]; ends: number }
// kw is the keepalive's ledger for this person: what its pings cost, what the rewrites they avoided would have cost, and whether
// the person said yes. Both sums fade with a 30-day half-life, so a bad month does not turn pings off for good.
export interface Ledger { pingUsd: number; savedUsd: number; optIn: boolean; at: number }
// cc is the champion and challenger race on this person's own gaps. The champion is the simple rule, the challenger the habits.
// Each accumulates what its pings cost and saved (net), and how many pings it sent, over gaps where either would have pinged.
export interface Shadow { n: number; champNet: number; chalNet: number; champPings: number; chalPings: number; active: 'champion' | 'challenger' }
export interface Habits { v: 2; watermark: number; sessions: number; cells: Partial<Record<CtxBucket, Cell>>; pend: Record<string, [CtxBucket, number]>; scan: boolean; kw: Ledger; cc: Shadow }
export const EMPTY_HABITS: Habits = {
  v: 2, watermark: 0, sessions: 0, cells: {}, pend: {}, scan: false,
  kw: { pingUsd: 0, savedUsd: 0, optIn: false, at: 0 }, cc: { n: 0, champNet: 0, chalNet: 0, champPings: 0, chalPings: 0, active: 'champion' },
}

const CAP = 4_000
const PEND_MAX = 200
export const SURE_ENDED_MS = 3 * 86_400_000 // a session untouched this long is over
const emptyCell = (): Cell => ({ gaps: EDGES.map(() => 0), ends: 0 })
const r2 = (n: number) => Math.round(n * 100) / 100
const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0)

export function parseHabits(text: string): Habits {
  try {
    const j = JSON.parse(text) as Partial<Habits>
    if (j.v !== 2 || !j.cells || typeof j.cells !== 'object') return EMPTY_HABITS
    const cells: Habits['cells'] = {}
    for (const k of ['small', 'mid', 'big'] as const) {
      const c = j.cells[k]
      if (c && Array.isArray(c.gaps) && c.gaps.length === EDGES.length && c.gaps.every((n) => Number.isFinite(n) && n >= 0) && Number.isFinite(c.ends) && c.ends >= 0) cells[k] = { gaps: c.gaps.slice(), ends: c.ends }
    }
    const pend: Habits['pend'] = {}
    for (const [k, v] of Object.entries(j.pend ?? {}).slice(0, PEND_MAX)) if (Array.isArray(v) && ['small', 'mid', 'big'].includes(v[0]) && Number.isFinite(v[1])) pend[k] = [v[0], v[1]]
    const kw = (j.kw ?? {}) as Partial<Ledger>, cc = (j.cc ?? {}) as Partial<Shadow>
    return {
      v: 2, watermark: num(j.watermark), sessions: num(j.sessions), cells, pend, scan: j.scan === true,
      kw: { pingUsd: num(kw.pingUsd), savedUsd: num(kw.savedUsd), optIn: kw.optIn === true, at: num(kw.at) },
      cc: { n: num(cc.n), champNet: Number(cc.champNet) || 0, chalNet: Number(cc.chalNet) || 0, champPings: num(cc.champPings), chalPings: num(cc.chalPings), active: cc.active === 'challenger' ? 'challenger' : 'champion' },
    }
  } catch {
    return EMPTY_HABITS
  }
}

const total = (c: Cell) => c.ends + c.gaps.reduce((x, y) => x + y, 0)
function halveIfBig(h: Habits, k: CtxBucket): Habits {
  const c = h.cells[k]!
  if (total(c) <= CAP) return h
  return { ...h, cells: { ...h.cells, [k]: { gaps: c.gaps.map((n) => r2(n / 2)), ends: r2(c.ends / 2) } } }
}

// observeGap counts one idle gap that ended with a new request.
export function observeGap(h: Habits, ctx: CtxBucket, gapMin: number): Habits {
  const b = bucketOfGap(gapMin)
  if (b < 0) return h
  const c = h.cells[ctx] ?? emptyCell()
  const gaps = c.gaps.slice()
  gaps[b] += 1
  return halveIfBig({ ...h, cells: { ...h.cells, [ctx]: { gaps, ends: c.ends } } }, ctx)
}

// observeEnd counts a session that ended after a request of this size.
export function observeEnd(h: Habits, ctx: CtxBucket): Habits {
  const c = h.cells[ctx] ?? emptyCell()
  return halveIfBig({ ...h, cells: { ...h.cells, [ctx]: { gaps: c.gaps, ends: c.ends + 1 } } }, ctx)
}

// A prior for a person with no data: the chance of a prompt within the hour after 10 idle minutes. It fades with idle time.
const PRIOR_60 = { small: 0.05, mid: 0.15, big: 0.3 } as const
export const PERSONAL_FULL = 100
const overlap = (lo: number, top: number, a: number, b: number) => Math.max(0, Math.min(top, b) - Math.max(lo, a)) / (top - lo)

// returnProb: the chance that a prompt arrives in (max(idle, from), idle + window] minutes, for a chat of this size that has already
// been idle `idle` minutes. `from` leaves out returns that a warm cache would have served anyway. `seen` is how many observations the
// person's own counts rest on.
export function returnProb(h: Habits, ctx: CtxBucket, idleMin: number, windowMin = 60, fromMin = 0): { p: number; seen: number } {
  const start = Math.max(idleMin, fromMin), end = idleMin + windowMin
  const prior = end > start ? Math.min(0.9, PRIOR_60[ctx] * (60 / (60 + idleMin)) * ((end - start) / 60)) : 0
  const c = h.cells[ctx]
  if (!c) return { p: prior, seen: 0 }
  let alive = c.ends, back = 0
  for (let i = 0; i < EDGES.length; i++) {
    alive += c.gaps[i] * overlap(EDGES[i], hi(i), idleMin, Infinity)
    back += c.gaps[i] * overlap(EDGES[i], hi(i), start, end)
  }
  const own = alive > 0 ? back / alive : prior
  const w = Math.min(1, total(c) / PERSONAL_FULL)
  return { p: w * own + (1 - w) * prior, seen: Math.round(total(c)) }
}

export interface PingValue { pReturn: number; seen: number; saveUsd: number; costUsd: number; net: number; rewriteUsd: number }

// pingValue prices keeping one chat warm for the next `windowMin` minutes. The saving is a rewrite avoided, less the read that
// replaces it, and counts only returns that come after the cache would have expired. The cost is every ping in the window.
export function pingValue(o: { habits: Habits; prefixTokens: number; idleMin: number; ttlMs: number; rate: Rate; windowMin?: number; oddsBoost?: number }): PingValue {
  const w = o.windowMin ?? 60
  const r = rateAt(o.rate, o.prefixTokens)
  const read = (o.prefixTokens * r.input * r.cacheReadX) / 1e6
  const rewrite = (o.prefixTokens * r.input * cacheWriteX(o.ttlMs)) / 1e6
  const every = Math.max(1, (o.ttlMs - (o.ttlMs >= 3_600_000 ? 8 * 60_000 : 150_000)) / 60_000)
  const { p, seen } = returnProb(o.habits, ctxOf(o.prefixTokens), o.idleMin, w, o.ttlMs / 60_000)
  const q = o.oddsBoost && o.oddsBoost !== 1 && p > 0 && p < 1 ? Math.min(0.9, (p * o.oddsBoost) / (1 - p + p * o.oddsBoost)) : p
  const saveUsd = q * (rewrite - read)
  const costUsd = (w / every) * read
  return { pReturn: q, seen, saveUsd, costUsd, net: saveUsd - costUsd, rewriteUsd: rewrite }
}

// noteKeepalive adds what one idle gap's pings cost and saved to the ledger. fadeLedger ages the sums with a 30-day half-life;
// the saved file is faded when it is merged, so a bad month does not turn pings off for good.
export const noteKeepalive = (h: Habits, pingUsd: number, savedUsd: number): Habits => ({ ...h, kw: { ...h.kw, pingUsd: h.kw.pingUsd + pingUsd, savedUsd: h.kw.savedUsd + savedUsd } })
export function fadeLedger(l: Ledger, now: number): Ledger {
  const f = l.at > 0 ? Math.pow(0.5, Math.max(0, now - l.at) / (30 * 86_400_000)) : 1
  return { ...l, pingUsd: l.pingUsd * f, savedUsd: l.savedUsd * f, at: now }
}
export const optIn = (h: Habits, yes: boolean): Habits => ({ ...h, kw: { ...h.kw, optIn: yes } })

// The race. A pinged gap costs money the moment a ping goes out, so costs are booked at once, and savings when the person returns.
// A gap where nobody returns costs and saves nothing, so the race is not flattered by the sessions that never came back.
// After MIN_RACE gaps, the challenger takes over when it sent clearly fewer pings and was no worse in net dollars, and the champion
// takes back when the challenger is clearly worse. The gap between the two rules is the hysteresis.
export const MIN_RACE = 30
export function decideActive(cc: Shadow): Shadow {
  if (cc.n < MIN_RACE) return cc
  if (cc.active === 'champion' && cc.chalNet >= cc.champNet && cc.chalPings <= 0.8 * cc.champPings) return { ...cc, active: 'challenger' }
  if (cc.active === 'challenger' && cc.chalNet < cc.champNet - Math.max(0.5, 0.1 * Math.abs(cc.champNet))) return { ...cc, active: 'champion' }
  return cc
}
export const raceCost = (h: Habits, d: { champPings: number; chalPings: number; champUsd: number; chalUsd: number; newGap: boolean }): Habits => ({
  ...h, cc: { ...h.cc, n: h.cc.n + (d.newGap ? 1 : 0), champPings: h.cc.champPings + d.champPings, chalPings: h.cc.chalPings + d.chalPings, champNet: h.cc.champNet - d.champUsd, chalNet: h.cc.chalNet - d.chalUsd },
})
export function raceSave(h: Habits, champUsd: number, chalUsd: number): Habits {
  let cc = decideActive({ ...h.cc, champNet: h.cc.champNet + champUsd, chalNet: h.cc.chalNet + chalUsd })
  if (cc.n > 400) cc = { ...cc, n: cc.n / 2, champNet: cc.champNet / 2, chalNet: cc.chalNet / 2, champPings: cc.champPings / 2, chalPings: cc.chalPings / 2 }
  return { ...h, cc }
}

// A pending end waits until the session is old enough to be sure it ended. `fid` names the transcript.
export function settlePend(h: Habits, now: number): Habits {
  let out = h
  const pend = { ...h.pend }
  for (const [fid, [ctx, at]] of Object.entries(h.pend)) if (now - at > SURE_ENDED_MS) { out = observeEnd(out, ctx); delete pend[fid] }
  return { ...out, pend }
}
export function addPend(h: Habits, fid: string, ctx: CtxBucket, at: number): Habits {
  const keys = Object.keys(h.pend)
  const pend = { ...h.pend }
  if (keys.length >= PEND_MAX) delete pend[keys[0]]
  pend[fid] = [ctx, at]
  return { ...h, pend }
}
export const dropPend = (h: Habits, fid: string): Habits => { if (!(fid in h.pend)) return h; const pend = { ...h.pend }; delete pend[fid]; return { ...h, pend } }
