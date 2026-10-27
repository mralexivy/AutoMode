// AutoMode's $.state contract: `view`, the read-only picture of the router and the guardian that the status bar draws
// (hooks/ui/publish.ts writes it). The UI keeps no other state: it has no controls.
//
// The contract is self-contained (claude plugin validate): the router's unions are written out here, and hooks/ui/view.ts
// imports its types from this file.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Family = 'haiku' | 'sonnet' | 'opus'
export type Stage = 'lookup' | 'explore' | 'analyze' | 'plan' | 'plan-approved' | 'implement' | 'verify' | 'debug' | 'reconsider' | 'review' | 'repo-op' | 'complete'
export type GuardianMode = 'off' | 'observe' | 'recommend' | 'assist' | 'auto'
export type Level = 'normal' | 'optimize' | 'warning' | 'pause'

export type Mode = 'auto' | 'shadow' | 'off'
export type AgentStatus = 'running' | 'done' | 'failed'

export interface AgentSnap {
  id: string
  type: string                  // the subagent type as spawned: automode:implementer, Explore, general-purpose
  model: string | null          // the model it runs on, after routing
  effort: Effort | null
  routed: boolean               // AutoMode changed its model or type
  explicit: boolean             // the spawn named a model: kept as given
  status: AgentStatus
  result: 'ok' | 'partial' | 'failed' | null // a validated worker report, where there is one
  workflow: { runId: string; index: number } | null
  label: string | null          // the spawn's description, for the workstream
  usd: number | null            // measured: the sum of its priced requests
  startedAt: number
}

export interface Ledger {
  requests: number
  byModel: Record<string, { usd: number; requests: number }>
  cacheRead: number
  cacheWrite: number
  judgeUsd: number
  judgeCalls: number
  subagentUsd: number
}

export interface RouterSnap {
  enabled: boolean              // config.json router v4
  killed: boolean               // AUTOMODE_ROUTER=off
  activation: 'always' | 'picker' // config.json activation: AutoMode starts with the session, or only on the model ID in pickerModel
  active: boolean               // AutoMode is running in this session (always: yes, unless killed; picker: the model ID matches)
  mode: Mode                    // in effect for this session (config, env, provider guard, session selector)
  configMode: Mode              // before the session selector
  sessionMode: Mode | null      // the bar's selector, this session only
  policy: 'auto' | 'legacy'
  providerGuard: boolean
  provider: string
  routeModels: boolean
  subagentsEverySession: boolean
  sessionModel: string | null   // the app's model for this session
  requested: { family: Family; model: string; effort: Effort; owner: string; reason: string; floor: string } | null
  held: { family: Family; effort: Effort } | null
  effective: { model: string | null; effort: Effort | null; at: number | null }
  deferredEffort: Effort | null // sent, but waits for new input before the API applies it
  verdict: { by: string; why: string; confidence: number | null } | null
  judging: boolean
  judgeDown: string[]           // judge kinds whose breaker is open
  breakers: { model: string; until: number; cls: string | null }[]
  inadequate: { shortfall: number; route: string } | null
  stage: Stage
  planMode: boolean
  review: { required: boolean; because: string[] }
  lastCheck: { command: string; passed: boolean } | null
  warm: Partial<Record<Family, { until: number; effort: Effort | null }>>
  ttlMs: number
  candidates: { route: string; eligibility: string; usd: number | null; why: string }[] // the last auto decision's, as recorded
  agents: AgentSnap[]
  ledger: Ledger
}

export interface GuardSnap {
  enabled: boolean
  killed: boolean               // AUTOMODE_GUARDIAN=off
  mode: GuardianMode
  everySession: boolean
  level: Level
  reasons: string[]
  outcomes: number
  sinceOutcome: { requests: number; usd: number }
  gates: { requests: number; usd: number }
  turnUsd: number | null
  checkpoint: { at: number; status: 'open' | 'closed'; sum: string; written: boolean } | null
  offer: { action: 'compact' | 'clear'; at: number; contextTokens: number; saves: string | null } | null
  restored: { from: string; at: number } | null
  paused: { at: number; reasons: string[] } | null
  continued: boolean
  last: { kind: string; at: number; why: string } | null
  hardPause: boolean
  autoCompact: boolean
  reduceOutputs: boolean
}

export interface UsageSnap {
  costUsd: number | null
  contextTokens: number | null
  window: number | null
  percent: number | null
  limits: { name: string; percent: number }[]
}

export type Tone = 'text' | 'dim' | 'route' | 'cyan' | 'effort' | 'guard' | 'warn' | 'error'
export type AlertKind = 'paused' | 'judge' | 'handoff' | 'compact' | 'warning' | 'cold' | 'limit' | 'restored'

export interface Alert {
  kind: AlertKind
  key: string                   // a dismissal is kept per key: the same alert does not come back, a new one does
  tone: Tone
  title: string
  line: string
  actions: ('continue' | 'compact' | 'handoff' | 'details' | 'settings')[]
}

export interface WorkflowStage { name: 'Discover' | 'Plan' | 'Build' | 'Verify' | 'Review'; state: 'done' | 'active' | 'failed' | 'required'; agents: AgentSnap[] }

export interface View {
  at: number
  routing: { label: string; tone: Tone; note: string | null; selectable: boolean }
  model: { name: string; family: Family | null; source: 'effective' | 'next' | 'app' | 'unknown' }
  effort: { name: string; level: Effort | null; source: 'effective' | 'next' | 'app' | 'unknown'; override: boolean }
  pending: string | null
  hold: string | null
  escalation: string | null
  context: { percent: number | null; tokens: number | null; window: number | null; level: 'ok' | 'high' | 'full' }
  cache: { state: 'warm' | 'cold' | 'unknown'; until: number | null; ttlMs: number; family: Family | null }
  cost: { session: number | null; turn: number | null }
  guardian: { glyph: string; tone: Tone; label: string; state: string; on: boolean }
  stage: string | null
  judge: { state: 'idle' | 'routing' | 'down'; line: string | null }
  alert: Alert | null
  why: string | null            // one short reason the route was chosen
  tip: Tip | null               // a hint for this state; publish.ts decides if and for how long it shows
  workflow: WorkflowStage[]
  router: RouterSnap
  guard: GuardSnap
  usage: UsageSnap
}

export interface Segment { key: string; text: string; tone: Tone; bold?: boolean; sep?: string }
export interface Tip { key: string; text: string; until: number }
export interface Facts { outputStyle: string | null }


declare module 'claude-code' {
  interface PluginState {
    automode: { view: View | null }
  }
}
