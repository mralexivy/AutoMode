// Habits: what one person's idle gaps look like, as numbers. Pure: no `$`, no I/O.
//
// Each idle gap that ended, and each session that ended, becomes a few training points for the return model (lib/model.ts): a chat of a
// given size, session age, prompt count and last-turn work that stayed idle this long, and whether the person came back within the hour.
// The file holds those numbers, never text, paths or times of day.
//
// What an audit of the first design (a table of counts by chat size) on real data found, and what the code does about it:
//  - A gap after a request that called a tool is mostly tool time, not a person returning. Those gaps are not counted.
//  - A session that ended counts as never returning only once it is old enough to be sure; younger ones wait in `pend`.
//  - Too few events to learn from alone (see lib/model.ts), so the model starts from a prior and moves slowly.
//  - Where the model is judged on the person's own gaps (`ev`), and the race (`cc`) decides whether it acts.
import { cacheWriteX, rateAt, type Rate } from './prices.ts'
import { PRIOR, fit, pointsOf, prob, probOfPoint, type Base, type Feat } from './model.ts'

export type CtxBucket = 'small' | 'mid' | 'big'
export const ctxOf = (tokens: number): CtxBucket => (tokens < 60_000 ? 'small' : tokens < 150_000 ? 'mid' : 'big')

// kw is the keepalive's ledger for this person: what its pings cost, what the rewrites they avoided would have cost, and whether
// the person said yes. Both sums fade with a 30-day half-life, so a bad month does not turn pings off for good.
export interface Ledger { pingUsd: number; savedUsd: number; optIn: boolean; at: number }
// cc is the champion and challenger race on this person's own gaps. The champion is the simple rule, the challenger the model.
// Each accumulates what its pings cost and saved (net), and how many pings it sent, over gaps where either would have pinged.
export interface Shadow { n: number; champNet: number; chalNet: number; champPings: number; chalPings: number; active: 'champion' | 'challenger' }
// ev is the model's report card, kept as the person's gaps settle. Each new point is scored by the model as it stood before the point,
// the prior alone, and the base rate, so the sums are honest out-of-sample errors (prequential). bModel below bConst means the model
// has learned something about this person.
export interface Report { n: number; bModel: number; bPrior: number; bConst: number }
// pend holds the last request of sessions too young to be sure they ended: [lastAt, tokens, ageMin, prompts, turnOut, asked].
// liveFrom is when the mod began to learn from gaps live; the scan counts only gaps before it, so no gap is counted twice.
export interface Habits { v: 3; watermark: number; liveFrom: number; sessions: number; pts: number[][]; w: number[]; ev: Report; pend: Record<string, number[]>; scan: boolean; kw: Ledger; cc: Shadow }
export const EMPTY_HABITS: Habits = {
  v: 3, watermark: 0, liveFrom: 0, sessions: 0, pts: [], w: PRIOR.slice(), ev: { n: 0, bModel: 0, bPrior: 0, bConst: 0 }, pend: {}, scan: false,
  kw: { pingUsd: 0, savedUsd: 0, optIn: false, at: 0 }, cc: { n: 0, champNet: 0, chalNet: 0, champPings: 0, chalPings: 0, active: 'champion' },
}

const PTS_MAX = 400
const PEND_MAX = 200
export const SURE_ENDED_MS = 3 * 86_400_000 // a session untouched this long is over
const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0)

export function parseHabits(text: string): Habits {
  try {
    const j = JSON.parse(text) as Partial<Habits>
    if (j.v !== 3 || !Array.isArray(j.pts)) return EMPTY_HABITS
    const pts = j.pts.filter((p) => Array.isArray(p) && p.length === 7 && p.every((x) => Number.isFinite(x))).slice(-PTS_MAX)
    const w = Array.isArray(j.w) && j.w.length === PRIOR.length && j.w.every((x) => Number.isFinite(x)) ? j.w.slice() : fit(pts)
    const pend: Habits['pend'] = {}
    for (const [k, v] of Object.entries(j.pend ?? {}).slice(0, PEND_MAX)) if (Array.isArray(v) && v.length === 6 && v.every((x) => Number.isFinite(x))) pend[k] = v.slice()
    const kw = (j.kw ?? {}) as Partial<Ledger>, cc = (j.cc ?? {}) as Partial<Shadow>, ev = (j.ev ?? {}) as Partial<Report>
    return {
      v: 3, watermark: num(j.watermark), liveFrom: num(j.liveFrom), sessions: num(j.sessions), pts, w, pend, scan: j.scan === true,
      ev: { n: num(ev.n), bModel: num(ev.bModel), bPrior: num(ev.bPrior), bConst: num(ev.bConst) },
      kw: { pingUsd: num(kw.pingUsd), savedUsd: num(kw.savedUsd), optIn: kw.optIn === true, at: num(kw.at) },
      cc: { n: num(cc.n), champNet: Number(cc.champNet) || 0, chalNet: Number(cc.chalNet) || 0, champPings: num(cc.champPings), chalPings: num(cc.chalPings), active: cc.active === 'challenger' ? 'challenger' : 'champion' },
    }
  } catch {
    return EMPTY_HABITS
  }
}

// addPoints scores each new point with the model as it stood, then keeps it. `gapMin` is Infinity for a session that ended. The
// weights are refit once per call, so a whole scan costs one fit.
export function addPoints(h: Habits, pts: number[][]): Habits {
  if (!pts.length) return h
  const base = h.pts.length ? h.pts.filter((p) => p[0] === 1).length / h.pts.length : 0.15
  const ev = { ...h.ev }
  for (const p of pts) {
    ev.n += 1; ev.bModel += (probOfPoint(h.w, p) - p[0]) ** 2; ev.bPrior += (probOfPoint(PRIOR, p) - p[0]) ** 2; ev.bConst += (base - p[0]) ** 2
  }
  if (ev.n > 2_000) for (const k of ['n', 'bModel', 'bPrior', 'bConst'] as const) ev[k] /= 2
  const all = [...h.pts, ...pts].slice(-PTS_MAX)
  return { ...h, pts: all, ev, w: fit(all) }
}
export const observeGapFeat = (h: Habits, b: Base, gapMin: number): Habits => addPoints(h, pointsOf(b, gapMin))

// returnProb: the chance that a prompt arrives within the next hour for a chat of this kind idle `idleMin` minutes. `seen` is how many
// training points the person's own model rests on.
export const returnProb = (h: Habits, f: Feat): { p: number; seen: number } => ({ p: prob(h.w, f), seen: h.pts.length })

export interface PingValue { pReturn: number; seen: number; saveUsd: number; costUsd: number; net: number; rewriteUsd: number }

// pingValue prices keeping one chat warm for the next `windowMin` minutes. The saving is a rewrite avoided, less the read that replaces it,
// and counts only the share of the window that lies past the cache lifetime. The cost is every ping in the window.
export function pingValue(o: { habits: Habits; feat: Feat; ttlMs: number; rate: Rate; windowMin?: number }): PingValue {
  const w = o.windowMin ?? 60
  const r = rateAt(o.rate, o.feat.tokens)
  const read = (o.feat.tokens * r.input * r.cacheReadX) / 1e6
  const rewrite = (o.feat.tokens * r.input * cacheWriteX(o.ttlMs)) / 1e6
  const every = Math.max(1, (o.ttlMs - (o.ttlMs >= 3_600_000 ? 8 * 60_000 : 150_000)) / 60_000)
  const { p, seen } = returnProb(o.habits, o.feat)
  const past = Math.max(0, o.feat.idleMin + 60 - Math.max(o.feat.idleMin, o.ttlMs / 60_000)) / 60
  const saveUsd = p * past * (rewrite - read)
  const costUsd = (w / every) * read
  return { pReturn: p * past, seen, saveUsd, costUsd, net: saveUsd - costUsd, rewriteUsd: rewrite }
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

// A pending end waits until the session is old enough to be sure it ended. `fid` names the transcript. A pending row is
// [lastAt, tokens, ageMin, prompts, turnOut, asked].
export function settlePend(h: Habits, now: number): Habits {
  const due: number[][] = []
  const pend = { ...h.pend }
  for (const [fid, p] of Object.entries(h.pend)) {
    if (now - p[0] <= SURE_ENDED_MS) continue
    due.push(...pointsOf({ tokens: p[1], ageMin: p[2], prompts: p[3], turnOut: p[4], asked: p[5] === 1 }, Infinity))
    delete pend[fid]
  }
  return addPoints({ ...h, pend }, due)
}
export function addPend(h: Habits, fid: string, row: number[]): Habits {
  const keys = Object.keys(h.pend)
  const pend = { ...h.pend }
  if (keys.length >= PEND_MAX) delete pend[keys[0]]
  pend[fid] = row
  return { ...h, pend }
}
export const dropPend = (h: Habits, fid: string): Habits => { if (!(fid in h.pend)) return h; const pend = { ...h.pend }; delete pend[fid]; return { ...h, pend } }
