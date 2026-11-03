// The run ledger: one append-only JSON line per state change of a slot, beside its results file. Folding the lines
// gives each slot's state. The results file stays the source of truth for a finished row; the ledger adds what the
// results file cannot hold: a run in flight, an interruption, a pause, and who owned the run.
//
// States: PLANNED -> RUNNING -> COMPLETED | FAILED | QUOTA_PAUSED | INVALID. A RUNNING slot whose owner is gone is
// UNKNOWN: the provider may have started and billed it, and no durable result exists. UNKNOWN never reruns on its
// own; `--retry-unknown` authorizes it. Nothing here promises a run happened once: it records what is known.
import fs from 'node:fs'
import os from 'node:os'

export type SlotState = 'PLANNED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'QUOTA_PAUSED' | 'INTERRUPTED' | 'UNKNOWN' | 'INVALID'
export interface SlotEvent { at: string; run_id: string; state: SlotState; attempt?: string; pid?: number; host?: string; reason?: string; cost_usd?: number | null; reset_at?: string | null; session_id?: string | null }

export const eventsFile = (resultsFile: string) => resultsFile.replace(/\.jsonl$/, '') + '.events.jsonl'

// appendEvent writes one line and syncs it, so a crash right after leaves the line on disk.
export function appendEvent(file: string, e: Omit<SlotEvent, 'at' | 'pid' | 'host'> & { at?: string }) {
  const line = JSON.stringify({ at: e.at ?? new Date().toISOString(), pid: process.pid, host: os.hostname(), ...e }) + '\n'
  const fd = fs.openSync(file, 'a')
  try { fs.writeSync(fd, line); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

export function readEvents(file: string): SlotEvent[] {
  if (!fs.existsSync(file)) return []
  // A line cut by a crash fails to parse and is skipped: the state it would have set stays unknown.
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

export const pidAlive = (pid: number | undefined, host?: string) => {
  if (!pid || (host && host !== os.hostname())) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

// foldEvents gives each slot's last state. A RUNNING slot whose owner process is gone becomes UNKNOWN.
export function foldEvents(events: SlotEvent[], alive: (e: SlotEvent) => boolean = (e) => pidAlive(e.pid, e.host)): Map<string, SlotEvent> {
  const last = new Map<string, SlotEvent>()
  for (const e of events) last.set(e.run_id, e)
  for (const [id, e] of last) if (e.state === 'RUNNING' && !alive(e)) last.set(id, { ...e, state: 'UNKNOWN', reason: `owner ${e.pid}@${e.host} is gone with no result` })
  return last
}
