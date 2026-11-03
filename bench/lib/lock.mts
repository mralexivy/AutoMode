// One paid experiment at a time, machine-wide. The lock is a file in a folder shared by every worktree; it holds its
// owner's pid, host, experiment and a heartbeat. A second runner refuses to start while the owner lives. A lock whose
// owner is gone, or whose heartbeat is older than STALE_MS, is taken over and the takeover is logged.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pidAlive } from './events.mts'

export const LOCK_DIR = process.env.BENCH_LOCK_DIR ?? path.join(os.homedir(), '.automode-bench')
export const LOCK_FILE = path.join(LOCK_DIR, 'paid.lock')
export const STALE_MS = 5 * 60_000
export interface LockInfo { pid: number; host: string; experiment: string; started: string; heartbeat: string }

export function readLock(file = LOCK_FILE): LockInfo | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

// lockHeld: someone else owns a live lock.
export function lockHeld(info: LockInfo | null, now = Date.now()): boolean {
  if (!info || info.pid === process.pid) return false
  return pidAlive(info.pid, info.host) && now - Date.parse(info.heartbeat) < STALE_MS
}

// acquire takes the lock or says who holds it. The create is exclusive (O_EXCL), so two runners that race both see it.
export function acquire(experiment: string, file = LOCK_FILE): { ok: true; release: () => void; tookOver: LockInfo | null } | { ok: false; holder: LockInfo } {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const mine = (): LockInfo => ({ pid: process.pid, host: os.hostname(), experiment, started: new Date().toISOString(), heartbeat: new Date().toISOString() })
  let tookOver: LockInfo | null = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx')
      fs.writeSync(fd, JSON.stringify(mine()))
      fs.closeSync(fd)
      const beat = setInterval(() => { try { const i = readLock(file); if (i?.pid === process.pid) fs.writeFileSync(file, JSON.stringify({ ...i, heartbeat: new Date().toISOString() })) } catch {} }, 30_000)
      beat.unref()
      const release = () => { clearInterval(beat); try { if (readLock(file)?.pid === process.pid) fs.unlinkSync(file) } catch {} }
      return { ok: true, release, tookOver }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const holder = readLock(file)
      if (holder && lockHeld(holder)) return { ok: false, holder }
      tookOver = holder
      try { fs.unlinkSync(file) } catch {}
    }
  }
  return { ok: false, holder: readLock(file)! }
}
