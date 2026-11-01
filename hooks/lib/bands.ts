// Ordinal bands, kept from policy v4.1 for three uses only: the ORDER of defect-escalation steps (bands.ts
// ladderStep), the challenge floor and the mid-turn comparison (v4.ts), and the demand band in legacy records.
// They never choose an effort: under policy auto the effortless verdict for each model does (lib/auto.ts).
//
// What is known and what is assumed:
//   - The table below is an ASSUMPTION, ordinal, per model: the highest demand band a configuration is
//     judged adequate for. It is anchored on the ladder (T0 Haiku, T1 Sonnet medium, T2 Sonnet high, T3 Opus
//     high, T4 Opus max) and on Anthropic's note that effort levels are calibrated per model. It claims no
//     fixed offset between Sonnet and Opus effort; a cross-model tie is broken by price and by the cache
//     switch check, never by a score. A person's calibration.json can replace it.
//   - Bands remove false precision. They add no outcome data: no per-configuration quality data exists.
import type { Effort, Family, Tier } from './types.ts'
import { EFFORTS } from './types.ts'

export type Band = number

// Highest demand band each configuration is adequate for. Haiku low is -1: adequate for nothing, so a
// lookup runs on Haiku medium, the Anthropic default and the ladder's practical T0 route.
export const BAND_OF: Record<Family, Record<Effort, Band>> = {
  haiku: { low: -1, medium: 0, high: 0, xhigh: 0, max: 0 },
  // Sonnet xhigh is a rung of its own, below Opus high: the ladder tries it before it moves the model. Sonnet max adds none.
  sonnet: { low: 0, medium: 1, high: 2, xhigh: 2.5, max: 2.5 },
  opus: { low: 1, medium: 2, high: 3, xhigh: 4, max: 5 },
}

// The demand band a judged tier asks for. T4 is the last resort (a focused attempt already failed): Opus max.
export const TIER_BAND: Record<Tier, Band> = { T0: 0, T1: 1, T2: 2, T3: 3, T4: 5 }
export const MAX_BAND = 5
// Heuristic for judge contracts that report a number: an uncalibrated confidence below this reads as unsure.
export const UNSURE_BELOW = 0.65

export interface BandDemand { band: Band; unsure: boolean; why: string[] }

// demandBand turns a verdict and the task state into a demand band. Each raise is recorded in `why`:
//   planning plan mode is design work. A plan of anything beyond a lookup runs at Sonnet high at least; a complex
//            plan goes one band higher, up to Opus high, never above. A routine plan therefore stays on Sonnet.
//   unsure   the judge said so: one band up, but only for hard work (band 2 and up) and never into the max band.
//            A wrong tier on cheap work costs a retry; on hard work it costs a wrong design. A terse, ambiguous
//            message on a lookup or a bounded edit therefore stays where it is, and the record says it was unsure.
// Repeated failures are NOT added here: the escalation ladder already turns them into a floor, and the caller applies
// that floor as `minBand`. A second bump would count one fact twice,
// and the audit showed where that leads: a hold carrying 2 failures ran at max effort.
// The quality floor is applied by the caller as `minBand`; it always wins.
export function demandBand(v: { tier: Tier; unsure?: boolean; planning?: boolean; failures?: number; complexity?: string }): BandDemand {
  const why = [`judge ${v.tier}`]
  let band = TIER_BAND[v.tier]
  if (v.planning && band >= 1) {
    if (band < 2) { band = 2; why.push('plan mode') }
    if (v.complexity === 'complex' && band < 3) { band += 1; why.push('plan mode: complex') }
  }
  if (v.unsure) {
    if (band >= 2 && band < 4) { band += 1; why.push('judge unsure') }
    else why.push('judge unsure (no raise below band 2 or in the top bands)')
  }
  return { band, unsure: !!v.unsure, why }
}

// bandOf places a route on the scale, for floors and mid-turn comparisons.
export const bandOf = (family: Family, effort: Effort): Band => BAND_OF[family][effort]

// nextEffort: the next effort on this model that buys a higher band, if there is one.
export const nextEffort = (family: Family, effort: Effort): Effort | undefined => EFFORTS.find((e) => BAND_OF[family][e] > BAND_OF[family][effort])

export interface LadderStep { family: Family; effort: Effort; band: Band; kind: 'effort' | 'model' }
const MODEL_UP: Partial<Record<Family, { family: Family; effort: Effort }>> = { haiku: { family: 'sonnet', effort: 'medium' }, sonnet: { family: 'opus', effort: 'high' } }

// ladderStep turns the strength of the evidence into one step from the running route. Weak evidence raises the effort
// on the running model. Strong evidence moves the model. On Opus, or with the stronger model out, only effort is left.
export function ladderStep(running: { family: Family; effort: Effort }, level: 'weak' | 'strong', allowed: Family[]): LadderStep | null {
  const effort = nextEffort(running.family, running.effort)
  const byEffort: LadderStep | null = effort ? { family: running.family, effort, band: BAND_OF[running.family][effort], kind: 'effort' } : null
  if (level === 'weak') return byEffort
  const up = MODEL_UP[running.family]
  if (up && (!allowed.length || allowed.includes(up.family))) return { ...up, band: BAND_OF[up.family][up.effort], kind: 'model' }
  return byEffort
}
