// An experiment says what is being measured, as data. It names arms from bench/arms.mts and holds the limits of one
// study. specHash covers everything that can change a result, so a resume never reuses a row from another setup.
import fs from 'node:fs'
import path from 'node:path'
import { sha256 } from './prompt.mts'

export type Track = 'automode-system' | 'neutral-model' | 'claude-compatible'
export const TRACKS: Track[] = ['automode-system', 'neutral-model', 'claude-compatible']
export type ProviderId = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'xai' | 'mistral' | 'local'

export interface ReasoningSpec {
  mode: 'provider-default' | 'effort' | 'fixed-budget'
  requestedEffort?: string
  budgetTokens?: number
  native?: Record<string, unknown>
}
export interface ContextSpec { policy: 'native' | 'capped-200k'; compactWindow?: number; compactPct?: number; maxTokens?: number }
export interface CacheSpec { enabled: boolean }
export interface ModelSpec {
  provider: ProviderId
  requestedModel: string
  reasoning: ReasoningSpec
  context: ContextSpec
  cache: CacheSpec
}

export interface ExperimentSpec {
  schema_version: 1
  id: string
  track: Track
  description?: string
  arms: string[]
  tasks?: string[]
  repeats: number
  parallel?: number
  prompt_template: string
  run_cap_usd?: number
  budget_usd?: number
  window_usd?: number
  dataset?: string
}

const DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'experiments')

export function experimentProblems(e: Partial<ExperimentSpec>, knownArms: string[]) {
  const out: string[] = []
  if (e.schema_version !== 1) out.push('"schema_version" must be 1')
  if (!e.id || !/^[a-z0-9-]+$/.test(e.id)) out.push('"id" must be lowercase words with hyphens')
  if (!TRACKS.includes(e.track)) out.push(`"track" must be one of ${TRACKS.join(', ')}`)
  if (!Array.isArray(e.arms) || !e.arms.length) out.push('"arms" must list at least one arm')
  for (const a of e.arms ?? []) if (!knownArms.includes(a)) out.push(`unknown arm ${a}`)
  if (!Number.isInteger(e.repeats) || e.repeats < 1) out.push('"repeats" must be a positive integer')
  if (!e.prompt_template) out.push('missing "prompt_template"')
  return out
}

export function loadExperiment(idOrFile: string, knownArms: string[]): ExperimentSpec {
  const file = idOrFile.endsWith('.json') ? idOrFile : path.join(DIR, `${idOrFile}.json`)
  const e = JSON.parse(fs.readFileSync(file, 'utf8'))
  const bad = experimentProblems(e, knownArms)
  if (bad.length) throw new Error(`experiment ${idOrFile}: ${bad.join('; ')}`)
  return e
}

// canonical sorts keys at every level, so the hash does not depend on the order of a JSON file.
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

export const specHash = (parts: unknown) => sha256(canonical(parts)).slice(0, 10)
