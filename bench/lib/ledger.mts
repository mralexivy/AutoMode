// Spend ledger for paid validation. Every paid call of every bench script adds one line; every script checks the
// ledger and its own estimate before it starts a call, so one approved cap covers all scripts and all runs.
//
//   file   bench/results/ledger.jsonl (append-only JSON lines)
//   cap    LEDGER_CAP_USD (environment) or the approval the caller passes; a call is refused when the total so far
//          plus the call's estimate would pass the cap.
// A call's cost is the CLI's own total_cost_usd for that call. Calls the plugin makes inside a session (the judges)
// are added from the plugin's records by addRecorded(), in case the CLI total leaves them out: this may count a call
// twice, which errs on the safe side of the cap.
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..')
export const LEDGER = process.env.LEDGER_FILE ?? path.join(REPO, 'bench', 'results', 'ledger.jsonl')

export function entries(file = LEDGER) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
}
export const total = (file = LEDGER, since) => entries(file).filter((e) => !since || e.batch === since).reduce((a, e) => a + (Number(e.usd) || 0), 0)

// ensure throws before a call that could pass the cap. `batch` scopes the cap to one approval (e.g. "2026-10-25").
export function ensure(estimateUsd, capUsd, batch, file = LEDGER) {
  const spent = total(file, batch)
  if (!(capUsd > 0)) throw new Error('no approved amount: pass --approve-usd')
  if (spent + estimateUsd > capUsd) throw new Error(`ledger: $${spent.toFixed(4)} spent in batch ${batch}; the next call (estimate $${estimateUsd.toFixed(4)}) could pass the approved $${capUsd}`)
  return spent
}

export function add(entry, file = LEDGER) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
}

// addRecorded adds the plugin's own model calls (judges, compaction) of one session, from its records.
export function addRecorded(records, sessionId, batch, what, file = LEDGER) {
  const usd = records.filter((r) => r.sessionId === sessionId && r.kind === 'model-call' && r.usd?.value).reduce((a, r) => a + r.usd.value, 0)
  if (usd > 0) add({ batch, what: `${what}: plugin model calls`, session: sessionId, usd: Math.round(usd * 1e6) / 1e6, source: 'plugin records' }, file)
  return usd
}
