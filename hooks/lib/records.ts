// Decision and outcome records: one JSON line each, in the plugin data folder, rotated at a size cap.
// No prompt text: ids, labels, numbers, and the cost basis of every value.
import type { CacheState, EffectiveRoute, Mode, TokenUsage } from './types.ts'
import type { StrategyChoice } from './strategy.ts'

export const RECORD_VERSION = 1
export const MAX_BYTES = 10 * 1024 * 1024

export interface DecisionRecord {
  v: number; kind: 'decision'; at: number; sessionId: string; promptId?: string; turnId?: string; taskId: string
  point: 'start' | 'prompt' | 'step' | 'spawn' | 'compact' | 'escalation' | 'trigger'
  mode: Mode; applied: boolean
  method: string
  effective: Pick<EffectiveRoute, 'tier' | 'model' | 'effort' | 'owner' | 'reason'> & { floor: string; check?: EffectiveRoute['check']; overridden: EffectiveRoute['overridden'] }
  candidate?: { tier: string; source: string; confidence: number }
  risk?: { prospective: string; effective: string; reviewRequired: boolean }
  strategy?: Pick<StrategyChoice, 'chosen' | 'reason' | 'confidence' | 'basis'> & { estimates: { strategy: string; p50: number; p75: number }[] }
  optimizer?: {
    required: number; acceptable: string[]; basis: string; capabilitySource: string; best: string
    demand: { difficulty: number; reasoning: number; steps: number; consequence: string; verification: string; confidence: number; planning: boolean; failures: number; band?: number; unsure?: boolean; bandWhy?: string[] } | null
    policy?: string; inadequate?: boolean; shortfall?: number
    top: { route: string; adequacy: string; retry: { lo: number; hi: number }; usd: number; usdRange: { lo: number; hi: number }; feasible: boolean }[]
  }
  trigger?: { event: string; reason: string; mandatory: boolean }
  // The active policy (legacy or auto), what the other one would have chosen (shadow, never applied), the override a
  // person's command set, the transition a short message was read as, and the limit when nothing available fits.
  policy?: string
  compare?: { policy: string; route: string; inadequate?: boolean; band?: number }
  override?: { source: string; scope: string }
  transition?: string
  stage?: string
  costTotal?: { mainUsd: number; switchUsd: number; judgeUsd: number; reviewRequired: boolean; consult: boolean; basis: string; excluded: string }
  firstRequest?: { tokens: number; source: string }
  inadequate?: { need: number; shortfall: number; route: string }
  routing?: { cheapestAdequate: string; chosen: string; overRouted: string | null; underRouted: string | null }
  judge?: { called: boolean; ms?: number; ok?: boolean; usd?: number; basis?: 'measured' }
  cache: Pick<CacheState, 'model' | 'effort' | 'prefixTokens' | 'effortSharesCache'> & { warm: boolean }
  actual?: { model: string; effort?: string } // what really ran, in shadow mode
  // Policy auto: every judge verdict, every candidate, the resolution steps that fired, any fallback, and the need.
  auto?: unknown
}

// The fixed-anchor effortless answer that decided eligibility. `verdict` is null when that call failed.
export interface NeedRecord { anchor: string; verdict: string | null }
export const needRecord = (anchor: string, need: { model: string; effort: string } | null | undefined): NeedRecord => ({ anchor, verdict: need ? `${need.model}/${need.effort}` : null })

export interface OutcomeRecord {
  v: number; kind: 'outcome'; at: number; sessionId: string; turnId: string; taskId: string
  reason: string; requests: number
  durationMs?: number // the turn's wall-clock time, for latency
  usage: Record<string, TokenUsage>
  usd: { value: number; basis: 'measured'; source: string }
  checks: { pass: number; fail: number }
  route?: string // the family and effort the turn ended on
  tier?: string  // the AutoMode judge's tier for the task, not the route's
  next?: 'moved-on' | 'corrected' | 'retried' // filled on the next prompt
}

// One main or worker request: what the app asked for, what the router sent, and what came back.
// `sent` is what this hook passed on; the transcript's api-request record is the API-side proof.
export interface RequestRecord {
  v: number; kind: 'request'; at: number; sessionId: string; turnId: string; index: number; agentId?: string; taskId: string
  app: { model: string; effort: string | number | null }
  sent: { model: string; effort: string | number | null }
  owner: string; effortApplied: boolean; effortWhy: string
  answered: { model: string | null; thinking: number | null }
  usage: TokenUsage | null
  usd: { value: number; basis: 'measured'; source: string } | null
  // Policy auto: the effort requested, the effort in effect at the API, and the rule that allowed it.
  application?: { requested: string | null; effective: string; legalAt: string; deferred: boolean }
}

export function requestRecord(r: Omit<RequestRecord, 'v' | 'kind'>): RequestRecord {
  return { v: RECORD_VERSION, kind: 'request', ...r }
}

export function decisionRecord(r: Omit<DecisionRecord, 'v' | 'kind'>): DecisionRecord {
  return { v: RECORD_VERSION, kind: 'decision', ...r }
}

export function outcomeRecord(r: Omit<OutcomeRecord, 'v' | 'kind'>): OutcomeRecord {
  return { v: RECORD_VERSION, kind: 'outcome', ...r }
}

// nextSignal reads the person's next prompt as Cursor's satisfaction proxy: a correction or a retry
// counts against the previous route; anything else counts as moving on.
export function nextSignal(text: string): 'moved-on' | 'corrected' | 'retried' {
  const t = text.trim().toLowerCase()
  if (/^(try again|again|retry|redo|do it again)\b/.test(t)) return 'retried'
  if (/^(no\b|nope|wrong|that'?s (wrong|not)|it (still )?(doesn'?t|does not|fails?|broke)|still (fail|broken|not)|you (broke|missed|forgot)|revert|undo|that didn'?t work|this is wrong)/.test(t)) return 'corrected'
  return 'moved-on'
}

export const shouldRotate = (bytes: number) => bytes >= MAX_BYTES
