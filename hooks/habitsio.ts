// Habits on disk: load and save habits.json, and read the person's own transcripts into it. It owns the `$` calls; the counting
// is in lib/habits.ts and lib/scan.ts. The scan runs only with the person's consent (cacheKeeper.learnFromHistory, or
// /automode learned import). It is local, incremental and time-boxed: each pass reads a few files, and the next pass starts where
// it stopped. Nothing leaves the machine, and no text is kept (lib/scan.ts returns numbers).
import type { EngineInterface } from 'claude-code'
import { cfgDir, v4DataDir } from './v4.ts'
import { EMPTY_HABITS, parseHabits, settlePend, type Habits } from './lib/habits.ts'
import { compactOf, finishScan, foldTranscript, observeCompact, type Compact } from './lib/scan.ts'
import { fsRead, fsWrite, lsdir, proc } from './lib/io.ts'

const DAY = 86_400_000
const WINDOW_DAYS = 90
const PASS_MS = 1_500
// A long session's transcript can run to hundreds of megabytes, and a file read cuts it short. Past BIG, the file streams through
// scripts/habits-fold.mjs in the person's node. Without node, the last TAIL bytes are read with `tail`.
export const BIG = 1_000_000
export const TAIL = 900_000

export async function habitsLoad($: EngineInterface): Promise<Habits> {
  try { return parseHabits(await fsRead($, `${await v4DataDir($)}/habits.json`)) } catch { return EMPTY_HABITS }
}
// habitsWrite saves through a temporary file and a rename, so a crash never leaves half a file for the next session to read.
export async function habitsWrite($: EngineInterface, h: Habits) {
  try {
    const file = `${await v4DataDir($)}/habits.json`
    await fsWrite($, `${file}.tmp`, JSON.stringify(h))
    await proc($, ['mv', '-f', '--', `${file}.tmp`, file], { timeoutMs: 5_000 })
  } catch {}
}

const fid = (path: string) => { let h = 2166136261; for (let i = 0; i < path.length; i++) { h ^= path.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 } return h.toString(36) }

// compactFile reads one transcript.
async function compactFile($: EngineInterface, path: string, size: number): Promise<Compact> {
  if (size <= BIG) return compactOf(foldTranscript(await fsRead($, path)))
  const script = `${$.plugin.root}/scripts/habits-fold.mjs`
  for (const argv of [['nice', '-n', '19', 'node', script, path], ['node', script, path]]) {
    try {
      const r = await proc($, argv, { timeoutMs: 60_000 })
      if (r.exitCode === 0) return JSON.parse(String(r.stdout)) as Compact
    } catch {}
  }
  return compactOf(foldTranscript(String((await proc($, ['tail', '-c', String(TAIL), '--', path], { timeoutMs: 10_000 })).stdout ?? '')))
}

// seen and err are counts and an error name, for a record that says why a scan found nothing. They never hold a path.
export interface ScanState { h: Habits; todo: string[] | null; newest: number; done: boolean; files: number; failed: number; seen: number; err: string | null }
export const scanStart = (h: Habits): ScanState => ({ h, todo: null, newest: 0, done: false, files: 0, failed: 0, seen: 0, err: null })

// scanPass reads files until the pass budget is spent. It lists the transcripts once, oldest first, and skips files not touched since
// the last full scan.
export async function scanPass($: EngineInterface, st: ScanState, now: number): Promise<ScanState> {
  const t0 = Date.now()
  try {
    if (!st.todo) {
      const root = `${await cfgDir($)}/projects`
      const found: { path: string; at: number; size: number }[] = []
      const top = await lsdir($, root)
      st = { ...st, seen: top.length, h: settlePend(st.h, now) }
      for (const d of top) {
        if (d.kind !== 'dir' && d.kind !== 'directory') continue
        let files: any[] = []
        try { files = await lsdir($, `${root}/${d.name}`) } catch { continue }
        for (const f of files) if (f.kind === 'file' && !f.isLink && String(f.name).endsWith('.jsonl') && f.mtimeMs && f.mtimeMs > st.h.watermark && now - f.mtimeMs < WINDOW_DAYS * DAY) found.push({ path: `${root}/${d.name}/${f.name}`, at: f.mtimeMs, size: Number(f.size) || 0 })
      }
      st = { ...st, todo: found.sort((a, b) => a.at - b.at).map((f) => `${f.size}|${f.path}`) }
    }
    const todo = st.todo!.slice()
    let { h, newest, files, failed } = st
    while (todo.length && Date.now() - t0 < PASS_MS) {
      const item = todo.shift()!
      const cut = item.indexOf('|')
      const size = Number(item.slice(0, cut)), path = item.slice(cut + 1)
      try {
        const c = await compactFile($, path, size)
        h = observeCompact(h, c, now, fid(path))
        if (c.last) newest = Math.max(newest, c.last.at)
        files += 1
      } catch { failed += 1 }
    }
    if (!todo.length) return { ...st, h: finishScan(h, newest, failed), todo, newest, done: true, files, failed }
    return { ...st, h, todo, newest, done: false, files, failed }
  } catch (err) {
    return { ...st, done: true, err: String((err as Error)?.name ?? 'Error').slice(0, 40) }
  }
}
