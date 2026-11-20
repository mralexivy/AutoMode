// Habits on disk: load and save habits.json, and read the person's own transcripts into it. It owns the `$` calls; the
// counting is in lib/habits.ts and lib/scan.ts. The scan is local, incremental and time-boxed: each pass reads a few files,
// and the next pass starts where it stopped. Nothing leaves the machine, and no text is kept (lib/scan.ts returns numbers).
import type { EngineInterface } from 'claude-code'
import { cfgDir, v4DataDir } from './v4.ts'
import { EMPTY_HABITS, parseHabits, type Habits } from './lib/habits.ts'
import { compactOf, finishScan, foldTranscript, observeCompact, type Compact } from './lib/scan.ts'
import { fsRead, fsWrite, lsdir, proc } from './lib/io.ts'

const DAY = 86_400_000
const WINDOW_DAYS = 90
const PASS_MS = 1_500
// A long session's transcript can run to hundreds of megabytes, and a file read cuts it short. Past BIG, only the last TAIL bytes are
// read, with `tail`: the end of a session is what shows it ended, and the recent gaps are the ones that still describe the person.
export const BIG = 1_000_000
export const TAIL = 900_000

// compactFile reads one transcript. A big one goes through scripts/habits-fold.mjs in the person's node, which streams it. Without
// node, the last TAIL bytes are read instead.
async function compactFile($: EngineInterface, path: string, size: number): Promise<Compact> {
  if (size <= BIG) return compactOf(foldTranscript(await fsRead($, path)))
  try {
    const r = await proc($, ['node', `${$.plugin.root}/scripts/habits-fold.mjs`, path], { timeoutMs: 60_000 })
    if (r.exitCode === 0) return JSON.parse(String(r.stdout)) as Compact
  } catch {}
  return compactOf(foldTranscript(String((await proc($, ['tail', '-c', String(TAIL), '--', path], { timeoutMs: 10_000 })).stdout ?? '')))
}

export async function habitsLoad($: EngineInterface): Promise<Habits> {
  try { return parseHabits(await fsRead($, `${await v4DataDir($)}/habits.json`)) } catch { return EMPTY_HABITS }
}
export async function habitsSave($: EngineInterface, h: Habits) {
  try { await fsWrite($, `${await v4DataDir($)}/habits.json`, JSON.stringify(h)) } catch {}
}

// seen and err are counts and an error name, for a record that says why a scan found nothing. They never hold a path.
export interface ScanState { h: Habits; todo: string[] | null; newest: number; done: boolean; files: number; seen: number; err: string | null }
export const scanStart = (h: Habits): ScanState => ({ h, todo: null, newest: 0, done: false, files: 0, seen: 0, err: null })

// scanPass reads files until the pass budget is spent. It lists the transcripts once, oldest first, and skips files not
// touched since the last full scan.
export async function scanPass($: EngineInterface, st: ScanState, now: number): Promise<ScanState> {
  const t0 = Date.now()
  try {
    if (!st.todo) {
      const root = `${await cfgDir($)}/projects`
      const found: { path: string; at: number; size: number }[] = []
      const top = await lsdir($, root)
      st = { ...st, seen: top.length }
      for (const d of top) {
        if (d.kind !== 'dir' && d.kind !== 'directory') continue
        let files: any[] = []
        try { files = await lsdir($, `${root}/${d.name}`) } catch { continue }
        for (const f of files) if (f.kind === 'file' && !f.isLink && String(f.name).endsWith('.jsonl') && f.mtimeMs && f.mtimeMs > st.h.watermark && now - f.mtimeMs < WINDOW_DAYS * DAY) found.push({ path: `${root}/${d.name}/${f.name}`, at: f.mtimeMs, size: Number(f.size) || 0 })
      }
      st = { ...st, todo: found.sort((a, b) => a.at - b.at).map((f) => `${f.size}|${f.path}`) }
    }
    const todo = st.todo!.slice()
    let h = st.h, newest = st.newest, files = st.files
    while (todo.length && Date.now() - t0 < PASS_MS) {
      const item = todo.shift()!
      const cut = item.indexOf('|')
      const size = Number(item.slice(0, cut)), path = item.slice(cut + 1)
      try {
        const c = await compactFile($, path, size)
        h = observeCompact(h, c, now)
        if (c.last) newest = Math.max(newest, c.last.at)
        files += 1
      } catch {}
    }
    if (!todo.length) return { ...st, h: finishScan(h, newest, now), todo, newest, done: true, files }
    return { ...st, h, todo, newest, done: false, files }
  } catch (err) {
    return { ...st, done: true, err: String((err as Error)?.message ?? err).replace(/\/[^\s'"]*/g, '<path>').slice(0, 120) }
  }
}
