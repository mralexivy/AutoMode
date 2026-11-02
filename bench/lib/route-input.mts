// A route input for a synthetic session: the bench tools that start from partial facts (a judge panel row, a decision
// record without a route input) build one here and run the router's own routeAuto on it. A recorded `auto.replay`
// input is exact and never goes through this file. Every default below is a stated assumption of the tool that uses it.
import { AUTO_ROUTE_SCHEMA, LOW_CONFIDENCE, type AutoRouteInput, type Verdicts } from '../../hooks/lib/auto-route.ts'
import { DEFAULT_LADDER } from '../../hooks/lib/authority.ts'
import type { Stage } from '../../hooks/lib/stage.ts'
import { attemptCost, DEFAULT_PRIORS, TASK_STEPS, tierOf } from '../../hooks/lib/optimizer.ts'
import { ANTHROPIC } from '../../hooks/lib/prices.ts'
import type { SwitchInput } from '../../hooks/lib/policy.ts'
import { EFFORTS, type Complexity, type Effort, type Family, type Risk, type Tier } from '../../hooks/lib/types.ts'

const FAMILIES: Family[] = ['haiku', 'sonnet', 'opus']

export interface SessionFacts {
  judge: { tier: Tier; complexity: Complexity; effort?: Effort; confidence?: number } | null
  verdicts: Verdicts
  second?: Family
  complexity?: Complexity
  risk?: Risk
  current?: { family: Family; effort: Effort } | null
  hold?: boolean                // false: the switch check sees no running route, so it never holds a model
  warm?: boolean                // the running model's cache is warm
  prefix?: number               // prompt tokens the cache holds and attempts are priced on
  at?: number
  ttlMs?: number
  boundary?: boolean
  stage?: Stage
  allowed?: Family[]
  appFamily?: Family
  fixedFamily?: Family
  fixedEffort?: Effort
  command?: string
  votes?: number
  requestsSinceSwitch?: number
  remainingTable?: SwitchInput['remainingTable']
}

// attemptTable prices one attempt per configuration, cache-neutral, as hooks/v4.ts attemptTable does.
export function attemptTable(complexity: Complexity, prefix: number): AutoRouteInput['economics']['attempt'] {
  const x = { cache: { model: null, effort: null, prefixTokens: prefix, lastRequestAt: null, ttlMs: 300_000, effortSharesCache: true }, warm: {}, now: 0, prices: ANTHROPIC, priors: DEFAULT_PRIORS, neutral: true }
  const cell = (family: Family, effort: Effort) => { const usd = attemptCost({ family, effort, cap: { lo: 0, hi: 0 } } as never, { steps: TASK_STEPS[complexity] }, x as never).usd; return Number.isFinite(usd) ? usd : null }
  return Object.fromEntries(FAMILIES.map((f) => [f, Object.fromEntries(EFFORTS.map((e) => [e, cell(f, e)]))])) as AutoRouteInput['economics']['attempt']
}

export function synthInput(f: SessionFacts): AutoRouteInput {
  const complexity = f.complexity ?? f.judge?.complexity ?? 'standard'
  const at = f.at ?? 0
  const ttl = f.ttlMs ?? 300_000
  const prefix = f.prefix ?? 20_000
  const cur = f.current ? { tier: tierOf(f.current.family, f.current.effort), family: f.current.family, model: DEFAULT_LADDER.models[f.current.family], effort: f.current.effort } : null
  const cache = { model: cur?.model ?? null, effort: cur?.effort ?? null, prefixTokens: cur ? prefix : 0, lastRequestAt: cur && f.warm ? at : null, ttlMs: ttl, effortSharesCache: true }
  return {
    schemaVersion: AUTO_ROUTE_SCHEMA, now: at, allowed: f.allowed ?? FAMILIES, appFamily: f.appFamily ?? cur?.family ?? 'sonnet',
    ...(f.fixedFamily ? { fixedFamily: f.fixedFamily } : {}), ...(f.fixedEffort ? { fixedEffort: f.fixedEffort } : {}),
    ...(f.command ? { command: { label: f.command } } : {}),
    shortcut: false, kept: null,
    judge: f.judge ? { tier: f.judge.tier, complexity, effort: f.judge.effort ?? 'medium', confidence: f.judge.confidence ?? 0.9, why: '' } : null,
    judgeCached: false, anchor: 'sonnet', verdicts: f.verdicts, ...(f.second ? { second: f.second } : {}),
    complexity, stage: f.stage ?? 'implement', previousStage: f.stage ?? 'implement', boundary: f.boundary ?? !cur, riskChanged: false, planBoundary: false, planExited: false,
    floor: { taskId: 'synthetic', risk: f.risk ?? 'none', riskReasons: [], ladderFloor: null, taskDecision: null, stayUp: 0, currentFamily: cur?.family ?? null },
    current: cur ? { route: cur, running: cur.effort } : null, usable: f.hold === false ? null : cur,
    executor: { on: false, taskRoute: null },
    learned: { on: false, opusBuckets: [] },
    votes: { tier: 'T0', n: f.votes ?? 0 },
    switching: {
      cache, reset: false, requestsSinceSwitch: f.requestsSinceSwitch ?? 5, verifiedSinceSwitch: false, switchesThisTask: 0, remainingTable: f.remainingTable,
      warm: { haiku: false, sonnet: false, opus: false }, warmPrefix: {},
      continuity: { provider: ANTHROPIC.provider, compacted: false, dropped: {}, rent: null },
    },
    economics: { attempt: attemptTable(complexity, prefix), outputPerStep: DEFAULT_PRIORS.outputPerStep, effortOutput: DEFAULT_PRIORS.effortOutput, effortSteps: DEFAULT_PRIORS.effortSteps, prices: ANTHROPIC, calibrated: false },
    consult: { consulted: [], packetTokens: 0, ttlMs: ttl },
    policy: { lowConfidence: LOW_CONFIDENCE },
  }
}
