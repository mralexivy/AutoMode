// Pacing for a subscription plan, which limits use over a 5-hour window and publishes no number. The window here is
// rolling and counts list-price-equivalent spend from the ledger, from every bench script. Pure: the caller passes the
// clock and does the waiting.
export const WINDOW_MS = 5 * 60 * 60 * 1000

interface Spend { at: string; usd: number }

export const windowSpend = (entries: Spend[], now: number, windowMs = WINDOW_MS) =>
  entries.filter((e) => now - Date.parse(e.at) < windowMs).reduce((a, e) => a + (Number(e.usd) || 0), 0)

// waitMs says how long to wait before the next run. It is 0 when spend in the window is under the cap. Otherwise it is
// the time until enough of the oldest spend leaves the window.
export function waitMs(entries: Spend[], now: number, capUsd: number | null, windowMs = WINDOW_MS) {
  if (!capUsd) return 0
  const inWindow = entries.filter((e) => now - Date.parse(e.at) < windowMs).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  let spent = inWindow.reduce((a, e) => a + (Number(e.usd) || 0), 0)
  if (spent < capUsd) return 0
  for (const e of inWindow) {
    spent -= Number(e.usd) || 0
    if (spent < capUsd) return Math.max(0, Date.parse(e.at) + windowMs - now)
  }
  return 0
}

// A RunQueue hands out work. A usage limit puts the run back at the front and pauses every worker.
export class RunQueue<T> {
  private items: T[]
  private maxRetries: number
  private retries = 0
  pausedUntil = 0
  constructor(items: T[], maxRetries: number) { this.items = [...items]; this.maxRetries = maxRetries }
  get size() { return this.items.length }
  take() { return this.items.shift() }
  // limitHit returns false when the retries are used up: the plan is out of usage, so the study stops for now.
  limitHit(item: T, now: number, waitForMs: number) {
    this.items.unshift(item)
    this.pausedUntil = Math.max(this.pausedUntil, now + waitForMs)
    return ++this.retries <= this.maxRetries
  }
}
