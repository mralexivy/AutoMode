// The rent rule's accrual, shadow only. Pure: no `$`, no I/O.
//
// Contract: rent is what the running model has cost beyond a cheaper eligible target, counted from real spend. It rises
// only while the target stays eligible, and it starts over on a switch or when the target changes. The switch check
// records a verdict from it beside the live verdict. Nothing reads that verdict to choose a route.
import type { Family, RentVerdict } from './types.ts'
import type { Rate } from './prices.ts'

export interface Rent { from: Family; to: Family; usd: number }

// rentShare is the part of a dollar spent on `from` that `to` would have saved, from input prices. A target that takes
// more steps saves less. A dearer target saves nothing.
export function rentShare(from: Family, to: Family, rates: Record<Family, Rate>, stepRatio = 1): number {
  return Math.max(0, 1 - (rates[to].input / rates[from].input) * stepRatio)
}

export function accrueRent(rent: Rent | null, from: Family, check: RentVerdict | undefined, usd: number, rates: Record<Family, Rate>): Rent | null {
  if (!check || check.to === from) return null
  const so = rent && rent.from === from && rent.to === check.to ? rent.usd : 0
  return { from, to: check.to, usd: so + rentShare(from, check.to, rates, check.stepRatio) * usd }
}
