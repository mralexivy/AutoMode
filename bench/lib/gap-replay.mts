// Replay a keepalive policy over recorded idle gaps. $0: it reads folded transcripts and makes no model call.
// For each idle gap (and for each session's last request, a gap that never ends) the policy is asked, ping by ping,
// whether to keep the chat warm. A ping reads the whole prefix. If the person returns while the cache is still warm
// and the real gap was longer than the cache lifetime, the policy avoided a rewrite. Prices are the mod's own
// (hooks/lib/prices.ts), so the replay and the mod agree.
import { ANTHROPIC, cacheWriteX, rateAt } from '../../hooks/lib/prices.ts'
import { ctxOf, parseHabits, pingValue, type Habits } from '../../hooks/lib/habits.ts'
import { observeFolded, type Folded, type Req } from '../../hooks/lib/scan.ts'

export interface Gap { a: Req; gapMin: number; ttlMs: number } // gapMin Infinity: the session ended here
export interface Policy { name: string; keep: (g: Gap, idleMin: number, pings: number) => boolean }

const margin = (ttlMs: number) => (ttlMs >= 3_600_000 ? 8 * 60_000 : 90_000)
export function costs(a: Req, ttlMs: number) {
  const r = rateAt(ANTHROPIC.rates[a.family], a.tokens)
  return { read: (a.tokens * r.input * r.cacheReadX) / 1e6, rewrite: (a.tokens * r.input * cacheWriteX(ttlMs)) / 1e6 }
}

// gapsOf lists the gaps of interactive sessions. `now` decides which last requests count as ended.
export function gapsOf(sessions: Folded[], now: number): Gap[] {
  const out: Gap[] = []
  for (const s of sessions) {
    if (s.prompts < 2 || !s.reqs.length) continue
    const ttl = s.reqs.find((q) => q.ttlMs)?.ttlMs ?? 3_600_000
    for (let i = 1; i < s.reqs.length; i++) {
      const gapMin = (s.reqs[i].at - s.reqs[i - 1].at) / 60_000
      if (gapMin >= 3) out.push({ a: s.reqs[i - 1], gapMin, ttlMs: ttl })
    }
    const last = s.reqs[s.reqs.length - 1]
    if (now - last.at > 86_400_000) out.push({ a: last, gapMin: Infinity, ttlMs: ttl })
  }
  return out
}

export interface Result { policy: string; gaps: number; pings: number; pingUsd: number; savedUsd: number; netUsd: number; rewriteUsd: number; worse: number }

export function simulate(gaps: Gap[], p: Policy): Result {
  const res: Result = { policy: p.name, gaps: gaps.length, pings: 0, pingUsd: 0, savedUsd: 0, netUsd: 0, rewriteUsd: 0, worse: 0 }
  for (const g of gaps) {
    const c = costs(g.a, g.ttlMs)
    const every = (g.ttlMs - margin(g.ttlMs)) / 60_000
    if (Number.isFinite(g.gapMin) && g.gapMin > g.ttlMs / 60_000) res.rewriteUsd += c.rewrite - c.read
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
    if (saved - spent < 0) res.worse += 1
  }
  res.netUsd = res.savedUsd - res.pingUsd
  return res
}

export const none: Policy = { name: 'none', keep: () => false }
export const flat = (hours: number): Policy => ({ name: `flat ${hours}h`, keep: (_g, idle) => idle <= hours * 60 })
export interface GateParams { minUsd: number; capHours: number; windowMin: number; pool: boolean }
export function gated(habits: Habits, q: GateParams): Policy {
  const { minUsd: minRewriteUsd, capHours, windowMin, pool } = q
  return {
    name: `gated min $${minRewriteUsd} cap ${capHours}h window ${windowMin}m${pool ? ' pooled' : ''}`,
    keep: (g, idle) => {
      if (idle > capHours * 60) return false
      const c = costs(g.a, g.ttlMs)
      if (c.rewrite < minRewriteUsd) return false
      return pingValue({ habits, prefixTokens: g.a.tokens, family: g.a.family, acted: pool ? null : g.a.acted, idleMin: idle, ttlMs: g.ttlMs, rate: ANTHROPIC.rates[g.a.family], windowMin }).net > 0
    },
  }
}

export function train(sessions: Folded[], now: number): Habits {
  let h = parseHabits('{}')
  for (const s of sessions) h = observeFolded(h, s, now)
  return h
}
export { ctxOf }
