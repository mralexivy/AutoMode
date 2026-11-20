// Measured cache lifetime. Pure: no `$`, no I/O.
// Claude Code writes a 1-hour cache on a Claude plan and a 5-minute cache elsewhere, and `ttlMs` in mode.ts only
// guesses which. The usage on each main request settles it:
//   a big rewrite after 5.5 minutes to the assumed lifetime of idle means the cache expired early: 5 minutes;
//   a big read after more than 5.5 minutes of idle means the cache lived on: 1 hour.
// The idea comes from the cache-keeper mod (MIT, github.com/nateherkai/claude-code-mods).
export const FIVE_MIN = 300_000
export const ONE_HOUR = 3_600_000
const IDLE_MIN_MS = 330_000
const BIG_PROMPT = 30_000

export interface TtlObservation {
  input: number; cacheRead: number; cacheWrite: number // the request's usage, 5m and 1h writes summed
  gapMs: number | null // idle time since the previous main request
  assumedMs: number // the lifetime in force now
  compacted: boolean // a compaction came between the two requests: a rewrite then proves nothing
}

// inferTtl returns the lifetime this request proves, or null when it proves nothing.
export function inferTtl(o: TtlObservation): number | null {
  const total = o.input + o.cacheRead + o.cacheWrite
  if (o.gapMs === null || o.compacted || total <= BIG_PROMPT || o.gapMs <= IDLE_MIN_MS) return null
  if (o.cacheWrite / total > 0.5 && o.gapMs < o.assumedMs) return FIVE_MIN
  if (o.cacheRead / total > 0.8) return ONE_HOUR
  return null
}
