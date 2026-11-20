// Keepalive decisions. Pure: no `$`, no I/O.
// A ping is a tiny forked request that reads the whole cached prefix and so restarts its lifetime. It pays when the
// pings cost less than the one rewrite they avoid, so the rules below stop it at the break-even, at the hour limit,
// after a ping that wrote instead of read, and after a ping that got no answer.
// The idea comes from the cache-keeper mod (MIT, github.com/nateherkai/claude-code-mods).
import { cacheWriteX, type Rate } from './prices.ts'

export const MAX_HOURS = 24
export const TICK_MS = 30_000

// A chat's first two requests build the cache in a different shape from the ones after them (measured live: a ping after the
// first request read the system prompt and rewrote the rest; after three requests it read everything). So pings start at the
// third request, and one ping that writes is forgiven: it builds the cache the next ping reads.
export const MIN_REQUESTS = 3
export const MAX_WRITE_STREAK = 2

export interface KeepWarmState { on: boolean; untilMs: number; pings: number; pingUsd: number; lastPingAt: number | null; stopped: string | null; writeStreak: number }
export const KEEP_OFF: KeepWarmState = { on: false, untilMs: 0, pings: 0, pingUsd: 0, lastPingAt: null, stopped: null, writeStreak: 0 }

export const clampHours = (h: number, max = MAX_HOURS) => (Number.isFinite(h) && h > 0 ? Math.min(h, max) : 0)

export const startKeepWarm = (now: number, hours: number): KeepWarmState => ({ ...KEEP_OFF, on: clampHours(hours) > 0, untilMs: now + clampHours(hours) * 3_600_000 })

// marginMs: how long before expiry a ping goes out.
export const marginMs = (ttlMs: number) => (ttlMs >= 3_600_000 ? 8 * 60_000 : 90_000)

// rewriteUsd: what one cold start of this prefix costs at the model's rate and the cache lifetime.
export const rewriteUsd = (prefixTokens: number, rate: Rate, ttlMs: number) => (prefixTokens * rate.input * cacheWriteX(ttlMs)) / 1e6
// pingUsd: one ping reads the prefix and answers with a word.
export const pingCostUsd = (prefixTokens: number, rate: Rate) => (prefixTokens * rate.input * rate.cacheReadX + 5 * rate.output) / 1e6

export interface TickInput { mainRequests: number; now: number; lastActivityAt: number | null; ttlMs: number; busy: boolean; prefixTokens: number; rate: Rate }

// tick returns what to do on one timer tick: ping now, wait, or stop for a reason.
export function tick(s: KeepWarmState, i: TickInput): { action: 'wait' } | { action: 'ping' } | { action: 'stop'; reason: string } {
  if (!s.on) return { action: 'wait' }
  if (i.now >= s.untilMs) return { action: 'stop', reason: 'the keep-warm time ran out' }
  if (i.busy || i.lastActivityAt === null || i.prefixTokens <= 0 || i.mainRequests < MIN_REQUESTS) return { action: 'wait' }
  const idle = i.now - Math.max(i.lastActivityAt, s.lastPingAt ?? 0)
  // A cache that already expired is not warmed by a ping: the ping would write the whole prefix again.
  if (idle >= i.ttlMs) return { action: 'stop', reason: 'the cache already expired' }
  if (idle < i.ttlMs - marginMs(i.ttlMs)) return { action: 'wait' }
  // The pings so far plus this one must still cost less than the rewrite they avoid.
  if (s.pingUsd + pingCostUsd(i.prefixTokens, i.rate) > rewriteUsd(i.prefixTokens, i.rate, i.ttlMs)) return { action: 'stop', reason: 'the pings now cost more than a cold rewrite' }
  return { action: 'ping' }
}

// afterPing folds one ping's result into the state. `usage` is absent when the ping got no answer.
export function afterPing(s: KeepWarmState, now: number, usd: number, usage: { cacheRead: number; cacheWrite: number } | null): KeepWarmState {
  const after = { ...s, pings: s.pings + 1, pingUsd: s.pingUsd + usd, lastPingAt: now }
  if (!usage) return { ...after, on: false, stopped: 'a ping got no answer' }
  if (usage.cacheWrite > 0.1 * Math.max(1, usage.cacheRead)) {
    const streak = s.writeStreak + 1
    return streak >= MAX_WRITE_STREAK ? { ...after, writeStreak: streak, on: false, stopped: 'pings wrote the cache instead of reading it' } : { ...after, writeStreak: streak }
  }
  return { ...after, writeStreak: 0 }
}
