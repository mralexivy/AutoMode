// The golden-case builder for the pure policy-auto route: a full AutoRouteInput from a short description of the
// session. tests/auto-route.test.mts reads the cases from tests/golden/decisions.json `auto`.
import { AUTO_ROUTE_SCHEMA, LOW_CONFIDENCE, routeAuto, type AutoRouteInput, type Verdicts } from '../hooks/lib/auto-route.ts'
import { BAND_OF } from '../hooks/lib/bands.ts'
import { attemptCost, DEFAULT_PRIORS, TASK_STEPS, tierOf } from '../hooks/lib/optimizer.ts'
import { ANTHROPIC } from '../hooks/lib/prices.ts'
import { DEFAULT_LADDER } from '../hooks/lib/authority.ts'
import { EFFORTS, type Complexity, type Effort, type Family, type Risk, type Tier } from '../hooks/lib/types.ts'
import type { Stage } from '../hooks/lib/stage.ts'

const FAMILIES: Family[] = ['haiku', 'sonnet', 'opus']
const TTL = 300_000
const NOW = 1_000_000

export type Given = {
  judge?: { tier: Tier; complexity: Complexity; confidence?: number } | null
  verdicts?: Record<string, [string, Effort] | null>
  second?: Family
  current?: string
  prefix?: number
  allowed?: Family[]
  risk?: Risk
  stage?: Stage
  boundary?: boolean
  fixedFamily?: Family
  fixedEffort?: Effort
  command?: string
  shortcut?: string
  ladder?: string
  stayUp?: number
  executor?: boolean
  taskDecision?: string
  learned?: string[]
  votes?: number
}
const split = (s: string) => s.split('/') as [Family, Effort]
const route = (s: string) => { const [family, effort] = split(s); return { tier: tierOf(family, effort), family, model: DEFAULT_LADDER.models[family], effort } }

// input: a full route input from a golden case's shorthand. A running route has a warm cache of `prefix` tokens.
export function input(g: Given): AutoRouteInput {
  const complexity = g.judge?.complexity ?? 'standard'
  const cur = g.current ? route(g.current) : null
  const prefix = g.prefix ?? 30_000
  const verdicts: Verdicts = Object.fromEntries(Object.entries(g.verdicts ?? {}).map(([f, v]) => [f, v ? { model: v[0] as Family, effort: v[1], why: 'golden' } : null]))
  const cache = { model: cur?.model ?? null, effort: cur?.effort ?? null, prefixTokens: cur ? prefix : 0, lastRequestAt: cur ? NOW - 10_000 : null, ttlMs: TTL, effortSharesCache: true }
  const x = { cache: { ...cache, prefixTokens: prefix }, warm: {}, now: NOW, prices: ANTHROPIC, priors: DEFAULT_PRIORS, neutral: true }
  const attempt = Object.fromEntries(FAMILIES.map((f) => [f, Object.fromEntries(EFFORTS.map((e) => { const usd = attemptCost({ family: f, effort: e, cap: { lo: 0, hi: 0 } }, { steps: TASK_STEPS[complexity] }, x).usd; return [e, Number.isFinite(usd) ? usd : null] }))])) as AutoRouteInput['economics']['attempt']
  const ladder = g.ladder ? split(g.ladder) : null
  const td = g.taskDecision ? split(g.taskDecision) : null
  const kept = g.shortcut ? split(g.shortcut) : null
  const judge = g.judge === null ? null : { tier: g.judge?.tier ?? 'T1', complexity, effort: 'medium' as Effort, confidence: g.judge?.confidence ?? 0.9, why: 'golden' }
  return {
    schemaVersion: AUTO_ROUTE_SCHEMA, now: NOW, allowed: g.allowed ?? FAMILIES, appFamily: 'sonnet',
    ...(g.fixedFamily ? { fixedFamily: g.fixedFamily } : {}), ...(g.fixedEffort ? { fixedEffort: g.fixedEffort } : {}),
    ...(g.command ? { command: { label: g.command } } : {}),
    shortcut: !!kept, kept: kept ? { family: kept[0], effort: kept[1] } : null,
    judge, judgeCached: false, anchor: 'sonnet', verdicts, ...(g.second ? { second: g.second } : {}),
    complexity, stage: g.stage ?? 'implement', previousStage: 'implement', boundary: g.boundary ?? !cur, riskChanged: false, planBoundary: false, planExited: false,
    floor: { taskId: 'task-1', risk: g.risk ?? 'none', riskReasons: g.risk === 'critical' ? ['payment path'] : [], ladderFloor: ladder ? { family: ladder[0], effort: ladder[1], band: BAND_OF[ladder[0]][ladder[1]], because: 'the same check failed after an edit' } : null, taskDecision: td ? { taskId: 'task-1', family: td[0], effort: td[1] } : null, stayUp: g.stayUp ?? 0, currentFamily: cur?.family ?? null },
    current: cur ? { route: cur, running: cur.effort } : null, usable: cur,
    executor: { on: !!g.executor, taskRoute: null },
    learned: { on: !!g.learned, opusBuckets: g.learned ?? [] },
    votes: { tier: 'T0', n: g.votes ?? 0 },
    switching: {
      cache, reset: false, requestsSinceSwitch: 5, verifiedSinceSwitch: false, switchesThisTask: 0, remainingTable: undefined,
      warm: { haiku: false, sonnet: false, opus: false }, warmPrefix: {},
      continuity: { provider: 'anthropic', compacted: false, dropped: {}, rent: null },
    },
    economics: { attempt, outputPerStep: DEFAULT_PRIORS.outputPerStep, effortOutput: DEFAULT_PRIORS.effortOutput, effortSteps: DEFAULT_PRIORS.effortSteps, prices: ANTHROPIC, calibrated: false },
    consult: { consulted: [], packetTokens: 600, ttlMs: TTL },
    policy: { lowConfidence: LOW_CONFIDENCE },
  }
}

export const outcome = (i: AutoRouteInput) => {
  const r = routeAuto(i)
  return { route: `${r.route.family}/${r.route.effort}`, owner: r.route.owner, ...(r.resolved.check?.gate ? { gate: r.resolved.check.gate } : {}), ...(r.consult ? { consult: r.consult.choice } : {}), ...(r.fallback ? { fallback: true } : {}) }
}
