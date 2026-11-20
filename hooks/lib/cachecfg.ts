// The cache-keeper settings in config.json: `"cacheKeeper": { "ttl": "auto", "guard": true, "guardTokens": 150000, "keepWarmHours": 0 }`.
// Pure. A missing or odd value falls back to the default, so a bad edit never turns a cost guard into a crash.
import { GUARD_TOKENS } from './coldguard.ts'
import { clampHours } from './keepwarm.ts'

export interface CacheKeeperConfig { ttl: 'auto' | '5' | '60'; guard: boolean; guardTokens: number; keepWarmHours: number }
export const CK_DEFAULTS: CacheKeeperConfig = { ttl: 'auto', guard: true, guardTokens: GUARD_TOKENS, keepWarmHours: 0 }

export function ckConfig(cfg: unknown): CacheKeeperConfig {
  const raw = ((cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>).cacheKeeper : null) ?? {}) as Record<string, unknown>
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
  return {
    ttl: raw.ttl === '5' || raw.ttl === '60' ? raw.ttl : 'auto',
    guard: raw.guard !== false,
    guardTokens: n(raw.guardTokens, CK_DEFAULTS.guardTokens),
    keepWarmHours: clampHours(n(raw.keepWarmHours, 0)),
  }
}
