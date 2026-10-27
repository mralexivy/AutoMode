// Shared types for the AutoMode V4 router. Every module in hooks/lib is pure: no `$`, no I/O.
// register.ts owns all engine calls and passes plain values in.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// T0 lookup on Haiku, T1 bounded and T2 hard-bounded on Sonnet, T3 complex and T4 last resort on Opus.
export type Tier = 'T0' | 'T1' | 'T2' | 'T3' | 'T4'
export const TIERS: readonly Tier[] = ['T0', 'T1', 'T2', 'T3', 'T4']
export const tierRank = (t: Tier) => TIERS.indexOf(t)
export const maxTier = (a: Tier, b: Tier): Tier => (tierRank(a) >= tierRank(b) ? a : b)

export type Family = 'haiku' | 'sonnet' | 'opus'
export type Risk = 'none' | 'elevated' | 'critical'
export const RISKS: readonly Risk[] = ['none', 'elevated', 'critical']
export const maxRisk = (a: Risk, b: Risk): Risk => (RISKS.indexOf(a) >= RISKS.indexOf(b) ? a : b)

export type Complexity = 'trivial' | 'standard' | 'complex'
export type Strategy = 'direct' | 'isolated-worker' | 'engineering-workflow'
export type Owner = 'user-override' | 'workflow-role' | 'quality-escalation' | 'cache-policy' | 'judge' | 'continuation' | 'rules' | 'fallback'
export type Mode = 'off' | 'shadow' | 'auto'
export type Basis = 'measured' | 'calibrated' | 'estimate'

export interface Route { tier: Tier; family: Family; model: string; effort: Effort }

export interface Candidate { tier: Tier; source: 'judge' | 'continuation' | 'rules' | 'fallback'; confidence: number; reason: string }
export interface Floor { tier: Tier; band?: number; effort?: Effort; because: string[] } // band and effort: an escalation step finer than the tier (Opus xhigh is band 4 inside T3)
export interface Economics {
  current: string | null          // model/effort now
  candidate: string               // model/effort proposed
  prefixTokens: number
  writePenaltyUsd: number         // the cache rewrite a model change costs now
  ttlMs: number
  effortSharesCache: boolean      // provider rule
  remaining: { k: number; p25: number; median: number; p75: number; n: number }
  savingUsd: { p25: number; median: number; p75: number } // from per-request saving x remaining quantiles
  reworkUsd?: number              // expected rework the candidate avoids or adds, when known
  basis: Basis
}
export interface SwitchCheck {
  verdict: 'switch' | 'hold'
  gate?: 'votes' | 'quality' | 'dwell' | 'payback' | 'context' | 'provider-effort' | 'oscillation'
  estUsd: number
  basis: Basis
  lowPenaltyPoint: boolean
  reason?: string
  economics?: Economics
}

export interface EffectiveRoute extends Route {
  owner: Owner
  reason: string
  floor: Floor
  candidate?: Candidate
  check?: SwitchCheck
  overridden: { owner: Owner; reason: string }[]
}

export interface RiskAssessment { level: Risk; reasons: string[]; source: 'judge' | 'rules' | 'plan' | 'diff' | 'user' }

export interface Acceptance { text: string; source: 'user' | 'plan' | 'model' }

export interface FailureRecord {
  fingerprint: string
  class: 'defect' | 'environment' | 'flaky' | 'unknown'
  command: string
  exitCode: number | null
  at: number
  editedSince: boolean
  evidence: string // the normalized tail, at most 1,500 chars
}

export interface DiscoveryRecord {
  scope: string
  paths: string[]
  complete: boolean
  omitted: string[]
  head: string | null
  hashes: Record<string, string>
  at: number
  agentId?: string
}

export interface TaskEnvelope {
  taskId: string
  revision: number
  createdAt: number
  promptIds: string[]
  spec: { promptId: string; text: string } // authoritative, never truncated, never injected whole
  summary: string // bounded routing summary for display and injection
  acceptance: Acceptance[]
  complexity: Complexity
  risk: { prospective: RiskAssessment; observed: RiskAssessment | null; effective: Risk }
  reviewRequired: { value: boolean; because: string[] }
  verified: boolean
  workflow: { runId?: string; stage?: 'discover' | 'plan' | 'build' | 'verify' | 'review' | 'done' }
  discovery: DiscoveryRecord[]
  failures: FailureRecord[]
  escalations: number
  editedPaths: string[]
  changedLines?: number // lines added or replaced by Edit, MultiEdit and Write in this task
  interfacesChanged?: number // exported declarations changed by edits in this task
  status: 'open' | 'done' | 'abandoned' | 'superseded'
  injectedRevision: number // the revision whose summary the model last saw
}

export interface CacheState {
  model: string | null
  effort: Effort | null
  prefixTokens: number
  lastRequestAt: number | null
  ttlMs: number
  effortSharesCache: boolean
}

export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }
