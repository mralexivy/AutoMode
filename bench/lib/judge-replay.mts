// Replays the routing decision offline on verdicts from bench/judge-panel.mts. The shortcut runs as in decideAuto;
// everything after it is the router's own routeAuto (hooks/lib/auto-route.ts) on a synthetic session from
// bench/lib/route-input.mts. The session is cold, so the switch check never holds a model. Labels score effort only,
// so this says nothing about task quality.
import { keepsEffort, type Effort } from '../../hooks/lib/effortless.ts'
import { shortcutApplies, type FamilyVerdict } from '../../hooks/lib/auto.ts'
import { planAuto, routeAuto } from '../../hooks/lib/auto-route.ts'
import { synthInput } from './route-input.mts'
import { prospectiveRisk } from '../../hooks/lib/risk.ts'
import { transitionOf } from '../../hooks/lib/transition.ts'
import type { Complexity, Family, Risk, Tier } from '../../hooks/lib/types.ts'
import { maxRisk } from '../../hooks/lib/types.ts'

export interface PanelRow { pass: number; id: string; slot: string; parsed: boolean; model?: string; effort?: Effort; sure?: number; tier?: string; complexity?: Complexity; risk?: Risk; consequence?: Risk; confidence?: number }
export interface LabeledCase { id: string; kind: string; holdout?: boolean; current: { model: Family; effort: Effort }; context?: string; message: string; ok: Effort[] }
export type Slots = Map<string, PanelRow>
export interface Rule { input: 'closing' | 'plain' | 'plain-then-closing'; effortOf?: (c: LabeledCase, s: Slots, family: Family, verdict: FamilyVerdict) => Effort }
export interface Route { family: Family | null; effort: Effort | null; source: string }

const lastReplyOf = (context: string) => (context.split('\nassistant: ').pop() ?? '').replace(/^assistant: /, '')

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
  const judge = j?.parsed ? { tier: j.tier as Tier, complexity: j.complexity ?? 'standard' as Complexity, effort: j.effort, confidence: j.confidence } : null
  const assessed = prospectiveRisk(c.message, j?.parsed ? { risk: maxRisk(j.risk ?? 'none', j.consequence ?? 'none'), why: '' } : null)
  const risk = assessed.routing ?? assessed.level
  // As the router: call 1 asks the fixed Sonnet anchor (A9) and the running model.
  const adjust = (f: Family, v: FamilyVerdict | null) => (v && rule.effortOf ? { ...v, effort: rule.effortOf(c, s, f, v) } : v)
  const verdicts: Partial<Record<Family, FamilyVerdict | null>> = {}
  for (const f of new Set<Family>(['sonnet', c.current.model])) verdicts[f] = adjust(f, verdictFor(s, f, rule))
  const facts = { judge, verdicts, risk, current, hold: false, boundary: !ctx, appFamily: c.current.model }
  const second = planAuto(synthInput(facts)).secondJudge
  if (second) verdicts[second] = adjust(second, verdictFor(s, second, rule))
  const r = routeAuto(synthInput({ ...facts, verdicts, ...(second ? { second } : {}) }))
  return { family: r.route.family, effort: r.route.effort, source: r.fallback ? 'fallback' : 'judge' }
}
