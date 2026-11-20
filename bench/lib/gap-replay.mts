// Replay a keepalive policy over recorded idle gaps. $0: it reads folded transcripts and makes no model call.
// For each idle gap (and for each session's last request, a gap that never ends) the policy is asked, ping by ping, whether to keep
// the chat warm. A ping reads the whole prefix. If the person returns while the cache is still warm and the real gap was longer than
// the cache lifetime, the policy avoided a rewrite. Prices are the mod's own (hooks/lib/prices.ts), and the gates are the mod's own
// (hooks/lib/keepgate.ts), so the replay and the mod agree. Habits are trained only on gaps that ended before the split time.
import { ANTHROPIC, cacheWriteX, rateAt } from '../../hooks/lib/prices.ts'
import { EMPTY_HABITS, SURE_ENDED_MS, type Habits } from '../../hooks/lib/habits.ts'
import { gate, type TaskState } from '../../hooks/lib/keepgate.ts'
import { compactOf, interactive, observeCompact, type Folded, type Req } from '../../hooks/lib/scan.ts'

export interface Gap { a: Req; gapMin: number; ttlMs: number; session: number; endAt: number } // gapMin Infinity: the session ended here
export interface Policy { name: string; keep: (g: Gap, idleMin: number, pings: number) => boolean }

const margin = (ttlMs: number) => (ttlMs >= 3_600_000 ? 8 * 60_000 : 150_000)
export function costs(a: Req, ttlMs: number) {
  const r = rateAt(ANTHROPIC.rates[a.family], a.tokens)
  return { read: (a.tokens * r.input * r.cacheReadX) / 1e6, rewrite: (a.tokens * r.input * cacheWriteX(ttlMs)) / 1e6 }
}

// gapsOf lists the gaps of interactive sessions, skipping gaps after a request that called a tool (tool time, not a person). A last
// request counts as an end only once the session is sure to be over, as in the mod.
export function gapsOf(sessions: Folded[], now: number, from = 0): Gap[] {
  const out: Gap[] = []
  sessions.forEach((s, session) => {
    if (!interactive(s) || !s.reqs.length) return
    const ttl = s.reqs.find((q) => q.ttlMs)?.ttlMs ?? 3_600_000
    for (let i = 1; i < s.reqs.length; i++) {
      const gapMin = (s.reqs[i].at - s.reqs[i - 1].at) / 60_000
      if (gapMin >= 3 && !s.reqs[i - 1].acted && s.reqs[i].at >= from) out.push({ a: s.reqs[i - 1], gapMin: gapMin >= 1440 ? Infinity : gapMin, ttlMs: ttl, session, endAt: s.reqs[i].at })
    }
    const last = s.reqs[s.reqs.length - 1]
    if (now - last.at > SURE_ENDED_MS && last.at >= from) out.push({ a: last, gapMin: Infinity, ttlMs: ttl, session, endAt: last.at })
  })
  return out
}

export interface Result { policy: string; gaps: number; pings: number; pingUsd: number; savedUsd: number; netUsd: number; worse: number; bySession: Map<number, number> }

export function simulate(gaps: Gap[], p: Policy): Result {
  const res: Result = { policy: p.name, gaps: gaps.length, pings: 0, pingUsd: 0, savedUsd: 0, netUsd: 0, worse: 0, bySession: new Map() }
  for (const g of gaps) {
    const c = costs(g.a, g.ttlMs)
    const every = (g.ttlMs - margin(g.ttlMs)) / 60_000
    let pings = 0
    for (let k = 1; ; k++) {
      const idle = k * every
      if (idle >= g.gapMin) break
      if (!p.keep(g, idle, pings)) break
      pings += 1
    }
    const expires = pings * every + g.ttlMs / 60_000
    const saved = g.gapMin > g.ttlMs / 60_000 && g.gapMin <= expires ? c.rewrite - c.read : 0
    const spent = pings * c.read
    res.pings += pings; res.pingUsd += spent; res.savedUsd += saved
    res.bySession.set(g.session, (res.bySession.get(g.session) ?? 0) + saved - spent)
    if (saved - spent < 0) res.worse += 1
  }
  res.netUsd = res.savedUsd - res.pingUsd
  return res
}

export const none: Policy = { name: 'none', keep: () => false }
export const flat = (hours: number): Policy => ({ name: `flat ${hours}h`, keep: (_g, idle) => idle <= hours * 60 })

const NEUTRAL: TaskState = { unfinished: false, finished: false, aboveNeed: false }
function verdict(h: Habits, g: Gap, idle: number, capHours: number, minUsd: number) {
  return gate({ habits: h, state: NEUTRAL, prefixTokens: g.a.tokens, ttlMs: g.ttlMs, idleMin: idle, rate: ANTHROPIC.rates[g.a.family], minRewriteUsd: minUsd, sessionPingUsd: 0, budgetUsd: 1e9, capMin: capHours * 60, stale: false })
}
// champion: the mod's simple rule. challenger: the mod's habits rule, with the habits it is given.
export const champion = (capHours = 2, minUsd = 0.3): Policy => ({ name: `champion (floor $${minUsd}, ${capHours}h)`, keep: (g, idle) => verdict(EMPTY_HABITS, g, idle, capHours, minUsd).champion.allow })
export const challenger = (h: Habits, capHours = 2, minUsd = 0.3): Policy => ({ name: `challenger (habits, floor $${minUsd}, ${capHours}h)`, keep: (g, idle) => verdict(h, g, idle, capHours, minUsd).challenger.allow })

// trainBefore builds habits from interactive sessions using only what ended before `T`: gaps that ended earlier, and last requests
// that were already sure to be over at T.
export function trainBefore(sessions: Folded[], T: number): Habits {
  let h: Habits = EMPTY_HABITS
  sessions.forEach((s, i) => {
    const c = compactOf(s)
    const gaps = c.gaps.filter((x) => x[0] < T)
    const last = c.last && c.last.at < T - SURE_ENDED_MS ? c.last : null
    h = observeCompact(h, { interactive: c.interactive, gaps, last: last ?? (c.last && c.last.at < T ? c.last : null) }, last ? T : c.last ? c.last.at : T, `s${i}`)
  })
  return h
}

// bootstrap: a 95% interval for the sum of per-session values, resampling sessions.
export function bootstrap(by: Map<number, number>, draws = 400, seed = 7): [number, number] {
  const v = [...by.values()]
  if (!v.length) return [0, 0]
  let s = seed
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
  const sums: number[] = []
  for (let d = 0; d < draws; d++) { let t = 0; for (let i = 0; i < v.length; i++) t += v[Math.floor(rnd() * v.length)]; sums.push(t) }
  sums.sort((a, b) => a - b)
  return [sums[Math.floor(draws * 0.025)], sums[Math.floor(draws * 0.975)]]
}
