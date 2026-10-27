// Price book and cost math. Rates are USD per million tokens at list price, per provider, each row
// with its source and the date it was read. Provider-specific rates never overwrite the Anthropic
// row; a provider without its own row is priced at the Anthropic row and labeled as such.
import type { Basis, Family, TokenUsage } from './types.ts'

export interface Rate {
  input: number
  output: number
  cacheReadX: number // cache read as a multiple of input
  longContext?: { above: number; multiplier: number }
}
export interface PriceRow { provider: string; source: string; checkedAt: string; rates: Record<Family, Rate> }

export const ANTHROPIC: PriceRow = {
  provider: 'anthropic',
  source: 'platform.claude.com pricing (Opus 5.5, Sonnet 5.5, Haiku 5.5 list prices)',
  checkedAt: '2026-10-17',
  rates: {
    opus: { input: 4, output: 20, cacheReadX: 0.05 },
    sonnet: { input: 2, output: 10, cacheReadX: 0.05 },
    haiku: { input: 0.1, output: 0.5, cacheReadX: 0.1, longContext: { above: 100_000, multiplier: 5 } },
  },
}

export const familyOf = (model: string): Family | null =>
  /haiku/i.test(model) ? 'haiku' : /sonnet/i.test(model) ? 'sonnet' : /opus/i.test(model) ? 'opus' : null

// rowFor returns the configured row for a provider, or the Anthropic row with `fallback` set.
export function rowFor(provider: string, rows: PriceRow[] = []): PriceRow & { fallback?: boolean } {
  const own = rows.find((r) => r.provider === provider)
  if (own) return own
  return provider === 'anthropic' ? ANTHROPIC : { ...ANTHROPIC, fallback: true }
}

// rateAt applies the long-context multiplier when the whole prompt is over its threshold.
export function rateAt(rate: Rate, promptTokens: number): Rate {
  if (!rate.longContext || promptTokens <= rate.longContext.above) return rate
  const m = rate.longContext.multiplier
  return { ...rate, input: rate.input * m, output: rate.output * m }
}

// cacheWriteX is the cache-write multiple of input for the lifetime in use.
export const cacheWriteX = (ttlMs: number) => (ttlMs >= 3_600_000 ? 2 : 1.25)

export function usageUsd(u: TokenUsage, rate: Rate): number {
  const prompt = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h
  const r = rateAt(rate, prompt)
  return (u.input * r.input + u.output * r.output + u.cacheRead * r.input * r.cacheReadX +
    u.cacheWrite5m * r.input * 1.25 + u.cacheWrite1h * r.input * 2) / 1e6
}

// A cost value always says how it was obtained.
export interface Usd { usd: number; basis: Basis; source: string }
export const usd = (value: number, basis: Basis, source: string): Usd => ({ usd: Math.round(value * 1e6) / 1e6, basis, source })
