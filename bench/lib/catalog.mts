// The dated price and identity table for models outside Anthropic. Rates depend on the date, on the hour for DeepSeek,
// and on prompt size for some models, so a cost is computed per request.
import fs from 'node:fs'
import path from 'node:path'
import type { NormalizedUsage } from '../providers/provider.mts'

const FILE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'pricing', '2026-10-31.json')

interface RateRow { before?: string; belowPrompt?: number; tariff?: 'peak' | 'offpeak'; input: number; cached: number; output: number }
export interface CatalogModel { provider: string; status: 'verified' | 'unverified'; source: string; note?: string; rates: RateRow[] }
export interface Catalog { snapshot: string; models: Record<string, CatalogModel> }

export const loadCatalog = (file = FILE): Catalog => JSON.parse(fs.readFileSync(file, 'utf8'))

// DeepSeek peak: 01:00 to 04:00 and 06:00 to 10:00 UTC, Monday to Friday.
export function isPeak(at: Date) {
  const day = at.getUTCDay(), h = at.getUTCHours()
  return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10))
}

export function rateFor(model: CatalogModel, at: Date, promptTokens: number) {
  const tariff = isPeak(at) ? 'peak' : 'offpeak'
  return model.rates.find((r) => (!r.before || at < new Date(`${r.before}T00:00:00Z`)) && (!r.belowPrompt || promptTokens < r.belowPrompt) && (!r.tariff || r.tariff === tariff)) ?? null
}

// requestUsd prices one request. It is null if the usage or the rate is unknown: a guess must not pass as a cost.
export function requestUsd(model: CatalogModel | undefined, u: NormalizedUsage, at: Date) {
  if (!model || u.inputTokens === null || u.outputTokens === null) return null
  const rate = rateFor(model, at, u.inputTokens)
  if (!rate) return null
  const cached = u.cacheReadTokens ?? 0
  return ((u.inputTokens - cached) * rate.input + cached * rate.cached + u.outputTokens * rate.output) / 1e6
}
