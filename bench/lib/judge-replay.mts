// Replays the routing decision offline on verdicts from bench/judge-panel.mts. It composes the same pure steps as
// decideAuto in hooks/v4.ts: the shortcut, the consequence floor, fallbacks, the second call and optimizeAuto. The
// session is cold, so the switch check never holds a model. Labels score effort only, so this says nothing about
// task quality.
import { keepsEffort, type Effort } from '../../hooks/lib/effortless.ts'
import { fallbackEffort, fallbackModel, optimizeAuto, secondCall, shortcutApplies, type AutoFloors, type FamilyVerdict } from '../../hooks/lib/auto.ts'
import { attemptCost, DEFAULT_PRIORS, TASK_STEPS } from '../../hooks/lib/optimizer.ts'
import { ANTHROPIC } from '../../hooks/lib/prices.ts'
import { prospectiveRisk } from '../../hooks/lib/risk.ts'
import { transitionOf } from '../../hooks/lib/transition.ts'
import type { Complexity, Family, Risk } from '../../hooks/lib/types.ts'
import { maxRisk } from '../../hooks/lib/types.ts'

export interface PanelRow { pass: number; id: string; slot: string; parsed: boolean; model?: string; effort?: Effort; sure?: number; tier?: string; complexity?: Complexity; risk?: Risk; consequence?: Risk; confidence?: number }
export interface LabeledCase { id: string; kind: string; holdout?: boolean; current: { model: Family; effort: Effort }; context?: string; message: string; ok: Effort[] }
export type Slots = Map<string, PanelRow>
export interface Rule { input: 'closing' | 'plain' | 'plain-then-closing'; effortOf?: (c: LabeledCase, s: Slots, family: Family, verdict: FamilyVerdict) => Effort }
export interface Route { family: Family | null; effort: Effort | null; source: string }

const LOW_CONFIDENCE = 0.3 // v4.ts LOW_CONFIDENCE
const lastReplyOf = (context: string) => (context.split('\nassistant: ').pop() ?? '').replace(/^assistant: /, '')
const COST = { cache: { model: null, effort: null, prefixTokens: 20_000, lastRequestAt: null, ttlMs: 300_000, effortSharesCache: true }, warm: {}, now: 0, prices: ANTHROPIC, priors: DEFAULT_PRIORS, neutral: true }

// upstreamRoute is what upstream answers: a kept pair for a short follow-up, else its one verdict about the running model.
export function upstreamRoute(c: LabeledCase, s: Slots): Route {
  if (keepsEffort(c.message, c.context ?? '')) return { family: c.current.model, effort: c.current.effort, source: 'kept' }
  const v = s.get(`plain:${c.current.model}`)
  return { family: (v?.model as Family) ?? null, effort: v?.effort ?? null, source: v?.parsed ? 'judge' : 'none' }
}

const verdictFor = (s: Slots, family: Family, rule: Rule): FamilyVerdict | null => {
  const read = (slot: string) => { const v = s.get(`${slot}:${family}`); return v?.parsed ? { model: v.model as FamilyVerdict['model'], effort: v.effort!, why: '', sure: v.sure } : null }
  if (rule.input === 'closing') return read('closing')
  if (rule.input === 'plain') return read('plain')
  return read('plain') ?? read('closing')
}

// automodeRoute is what the full pipeline answers for one case on one pass.
export function automodeRoute(c: LabeledCase, s: Slots, rule: Rule): Route {
  const ctx = c.context ?? ''
  const current = { family: c.current.model, effort: c.current.effort }
  const follow = keepsEffort(c.message, ctx)
  const approves = transitionOf(c.message, lastReplyOf(ctx)).kind === 'begin-approved'
  if (shortcutApplies(follow, c.message, { required: false }) && !approves) return { ...current, source: 'kept' }
  const j = s.get('automode')
  const hm = j?.parsed ? { tier: j.tier as 'T0', complexity: j.complexity ?? 'standard' as Complexity } : null
  const risk = prospectiveRisk(c.message, j?.parsed ? { risk: maxRisk(j.risk ?? 'none', j.consequence ?? 'none'), why: '' } : null).level
  const complexity: Complexity = hm?.complexity ?? 'standard'
  const floors: AutoFloors = { effortMin: {}, exclude: {}, because: [] }
  if (risk === 'critical' && complexity !== 'trivial') { floors.exclude!.haiku = 'critical'; floors.effortMin = { sonnet: 'high', opus: 'medium' } }
  const anchor = c.current.model
  let verdicts: Partial<Record<Family, FamilyVerdict | null>> = { [anchor]: verdictFor(s, anchor, rule) }
  let source = 'judge'
  const allowed: Family[] = ['haiku', 'sonnet', 'opus']
  if (!verdicts[anchor]) {
    const fb = fallbackEffort({ sameTask: !!ctx, sameStage: true, riskChanged: false, planBoundary: false, previous: current, previousAdequate: true, appEffort: undefined, escalation: null, effortMin: floors.effortMin?.[anchor] })
    verdicts = { [anchor]: { model: anchor, effort: fb.effort, why: 'fallback' } }
    floors.fixedFamily = anchor
    source = 'fallback'
    if (j?.parsed) {
      const fm = fallbackModel(anchor, { tier: j.tier as 'T0', effort: j.effort, confidence: j.confidence }, allowed, risk, LOW_CONFIDENCE)
      if (fm.family !== anchor) { floors.fixedFamily = fm.family; verdicts[fm.family] = { model: fm.family, effort: fm.effort ?? 'high', why: 'fallback' } }
    }
  } else if (!hm) { floors.fixedFamily = anchor; source = 'fallback' }
  if (hm && (j?.confidence ?? 1) < LOW_CONFIDENCE && !floors.fixedFamily) {
    const rank: Record<Family, number> = { haiku: 0, sonnet: 1, opus: 2 }
    for (const f of allowed) if (rank[f] < rank[anchor]) floors.exclude![f] = 'low confidence'
  }
  const cost = (family: Family, effort: Effort) => attemptCost({ family, effort, cap: { lo: 0, hi: 0 } } as never, { steps: TASK_STEPS[complexity] }, COST as never).usd
  if (source === 'judge') {
    const second = secondCall({ allowed, verdicts, hm, consequence: risk, floors, current: null, cost: () => 0 }, anchor)
    if (second) verdicts[second] = verdictFor(s, second, rule)
  }
  if (rule.effortOf) for (const [f, v] of Object.entries(verdicts)) if (v) verdicts[f as Family] = { ...v, effort: rule.effortOf(c, s, f as Family, v) }
  const choice = optimizeAuto({ allowed, verdicts, hm, consequence: risk, floors, current, cost })
  return { family: choice.best.family, effort: choice.best.effort, source }
}
