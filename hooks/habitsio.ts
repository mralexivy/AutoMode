// Habits on disk: load and save habits.json, and read the person's own transcripts into it. It owns the `$` calls; the
// counting is in lib/habits.ts and lib/scan.ts. The scan is local, incremental and time-boxed: each pass reads a few files,
// and the next pass starts where it stopped. Nothing leaves the machine, and no text is kept (lib/scan.ts returns numbers).
import type { EngineInterface } from 'claude-code'
import { cfgDir, v4DataDir } from './v4.ts'
import { EMPTY_HABITS, parseHabits, type Habits } from './lib/habits.ts'
import { finishScan, foldTranscript, observeFolded } from './lib/scan.ts'
import { fsRead, fsWrite, lsdir } from './lib/io.ts'

const DAY = 86_400_000
const WINDOW_DAYS = 90
const PASS_MS = 1_500

export async function habitsLoad($: EngineInterface): Promise<Habits> {
  try { return parseHabits(await fsRead($, `${await v4DataDir($)}/habits.json`)) } catch { return EMPTY_HABITS }
}
export async function habitsSave($: EngineInterface, h: Habits) {
  try { await fsWrite($, `${await v4DataDir($)}/habits.json`, JSON.stringify(h)) } catch {}
}

export interface ScanState { h: Habits; todo: string[] | null; newest: number; done: boolean; files: number }
export const scanStart = (h: Habits): ScanState => ({ h, todo: null, newest: 0, done: false, files: 0 })

// scanPass reads files until the pass budget is spent. It lists the transcripts once, oldest first, and skips files not
// touched since the last full scan.
export async function scanPass($: EngineInterface, st: ScanState, now: number): Promise<ScanState> {
  const t0 = Date.now()
  try {
    if (!st.todo) {
      const root = `${await cfgDir($)}/projects`
      const found: { path: string; at: number }[] = []
      for (const d of await lsdir($, root)) {
        if (d.kind !== 'directory') continue
        let files: any[] = []
        try { files = await lsdir($, `${root}/${d.name}`) } catch { continue }
        for (const f of files) if (f.kind === 'file' && String(f.name).endsWith('.jsonl') && f.mtimeMs && f.mtimeMs > st.h.watermark && now - f.mtimeMs < WINDOW_DAYS * DAY) found.push({ path: `${root}/${d.name}/${f.name}`, at: f.mtimeMs })
      }
      st = { ...st, todo: found.sort((a, b) => a.at - b.at).map((f) => f.path) }
    }
    const todo = st.todo!.slice()
    let h = st.h, newest = st.newest, files = st.files
    while (todo.length && Date.now() - t0 < PASS_MS) {
      const path = todo.shift()!
      try {
        const f = foldTranscript(await fsRead($, path))
        h = observeFolded(h, f, now)
        if (f.reqs.length) newest = Math.max(newest, f.reqs[f.reqs.length - 1].at)
        files += 1
      } catch {}
    }
    if (!todo.length) return { h: finishScan(h, newest, now), todo, newest, done: true, files }
    return { h, todo, newest, done: false, files }
  } catch {
    return { ...st, done: true }
  }
}
