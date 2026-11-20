// The cache-keeper settings in config.json: `"cacheKeeper": { "ttl": "auto", "guard": true, "guardTokens": 150000, "keepWarm": "ask", "keepWarmHours": 2, "budgetUsd": 0.5, "minRewriteUsd": 0.3, "learnFromHistory": false }`.
// Pure. A missing or odd value falls back to the default, so a bad edit never turns a cost guard into a crash.
import { GUARD_TOKENS } from './coldguard.ts'
import { clampHours } from './keepwarm.ts'

// keepWarm: `off` never pings; `ask` pings once the person says yes in the cold-send dialog (or runs /automode keepwarm);
// `auto` pings on its own where the gate says it pays. learnFromHistory reads the person's local transcripts for counts.
export interface CacheKeeperConfig { ttl: 'auto' | '5' | '60'; guard: boolean; guardTokens: number; keepWarmHours: number; keepWarm: 'off' | 'ask' | 'auto'; budgetUsd: number; minRewriteUsd: number; learnFromHistory: boolean }
export const CK_DEFAULTS: CacheKeeperConfig = { ttl: 'auto', guard: true, guardTokens: GUARD_TOKENS, keepWarmHours: 2, keepWarm: 'ask', budgetUsd: 0.5, minRewriteUsd: 0.3, learnFromHistory: false }

export function ckConfig(cfg: unknown): CacheKeeperConfig {
  const raw = ((cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>).cacheKeeper : null) ?? {}) as Record<string, unknown>
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
  return {
    ttl: raw.ttl === '5' || raw.ttl === '60' ? raw.ttl : 'auto',
    guard: raw.guard !== false,
    guardTokens: n(raw.guardTokens, CK_DEFAULTS.guardTokens),
    keepWarmHours: clampHours(n(raw.keepWarmHours, CK_DEFAULTS.keepWarmHours)) || CK_DEFAULTS.keepWarmHours,
    keepWarm: raw.keepWarm === 'off' || raw.keepWarm === 'auto' ? raw.keepWarm : 'ask',
    budgetUsd: n(raw.budgetUsd, CK_DEFAULTS.budgetUsd),
    minRewriteUsd: n(raw.minRewriteUsd, CK_DEFAULTS.minRewriteUsd),
    learnFromHistory: raw.learnFromHistory === true,
  }
}
