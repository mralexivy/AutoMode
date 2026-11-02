// Pure logic for bench/fixture-check.mts. No I/O and no process calls.
// It splits a unified diff into files and hunks, builds the reference patch with one hunk left out, picks which hunks
// to test under a cap, and scores the results. A hunk is "killed" when leaving it out makes accept fail.
// The diff must come from `git diff --no-renames`, so each file section has one path.

export interface Hunk {
  header: string
  lines: string[]
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
}

export interface FileDiff {
  path: string
  head: string[] // the "diff --git" line and the lines up to the first hunk
  hunks: Hunk[]
  isNew: boolean
  isDeleted: boolean
}

export type PathKind = 'hidden' | 'docs' | 'code'

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

// pathOf reads the path from a "diff --git a/P b/P" line. Both halves match without renames, so the split is exact.
export function pathOf(line: string) {
  const rest = line.slice('diff --git '.length)
  const n = (rest.length - 5) / 2
  return rest.slice(2, 2 + n)
}

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = []
  let file: FileDiff | null = null
  let hunk: Hunk | null = null
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      file = { path: pathOf(line), head: [line], hunks: [], isNew: false, isDeleted: false }
      hunk = null
      files.push(file)
      continue
    }
    if (!file) continue
    const m = HUNK.exec(line)
    if (m) {
      hunk = { header: line, lines: [], oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4] }
      file.hunks.push(hunk)
      continue
    }
    if (hunk) { hunk.lines.push(line); continue }
    if (line.startsWith('new file mode')) file.isNew = true
    if (line.startsWith('deleted file mode')) file.isDeleted = true
    file.head.push(line)
  }
  return files
}

const renderHunk = (h: Hunk, shift: number) => {
  const start = h.newStart + shift
  return [h.header.replace(HUNK, `@@ -${h.oldStart},${h.oldLines} +${start},${h.newLines} @@`), ...h.lines]
}

export function renderDiff(files: FileDiff[]) {
  const out: string[] = []
  for (const f of files) {
    out.push(...f.head)
    for (const h of f.hunks) out.push(...renderHunk(h, 0))
  }
  return out.length ? `${out.join('\n')}\n` : ''
}

// withoutHunk returns the patch with one hunk left out. Later hunks of that file shift their new start by the lines the
// hunk added or removed. A new or deleted file has one hunk, so leaving it out drops the whole file section.
export function withoutHunk(files: FileDiff[], fileIndex: number, hunkIndex: number) {
  const out: string[] = []
  files.forEach((f, i) => {
    if (i !== fileIndex) {
      out.push(...f.head)
      for (const h of f.hunks) out.push(...renderHunk(h, 0))
      return
    }
    if (f.hunks.length <= 1) return
    out.push(...f.head)
    const gone = f.hunks[hunkIndex]
    const delta = gone.newLines - gone.oldLines
    f.hunks.forEach((h, j) => {
      if (j === hunkIndex) return
      out.push(...renderHunk(h, j > hunkIndex ? -delta : 0))
    })
  })
  return out.length ? `${out.join('\n')}\n` : ''
}

const DOCS = /(^|\/)(docs?|documentation)\/|\.(md|rst|txt|adoc)$|(^|\/)(CHANGELOG|CHANGES|HISTORY|NEWS|AUTHORS)[^/]*$/i

// kindOf sorts a changed path. A hidden test is never mutated. Docs cannot fail a test, so they stay out of the scores.
export function kindOf(p: string, hidden: string[]): PathKind {
  if (hidden.includes(p)) return 'hidden'
  if (DOCS.test(p)) return 'docs'
  return 'code'
}

export interface HunkRef { file: number; hunk: number; path: string; header: string }

// pickHunks lists the code hunks to test, at most `cap`. It takes one hunk per file in turn, so a cap still spreads the
// test over every file. Files keep diff order, and hunks keep file order.
export function pickHunks(files: FileDiff[], hidden: string[], cap: number) {
  const queues = files
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => kindOf(f.path, hidden) === 'code')
    .map(({ f, i }) => f.hunks.map((h, j): HunkRef => ({ file: i, hunk: j, path: f.path, header: h.header })))
  const total = queues.reduce((n, q) => n + q.length, 0)
  const picked: HunkRef[] = []
  for (let round = 0; picked.length < cap && picked.length < total; round++) {
    for (const q of queues) if (q[round] && picked.length < cap) picked.push(q[round])
  }
  return { picked, total }
}

export type HunkVerdict = 'killed' | 'survived' | 'timeout' | 'apply_failed'
export interface HunkResult extends HunkRef { verdict: HunkVerdict }

// score: kill rate over the hunks that ran to a verdict, and the share of code files with at least one killed hunk.
// A timeout or a patch that does not apply is no verdict. A task with no killed hunk is weak.
export function score(results: HunkResult[], codeFiles: string[]) {
  const ran = results.filter((r) => r.verdict === 'killed' || r.verdict === 'survived')
  const killed = ran.filter((r) => r.verdict === 'killed')
  const hit = new Set(killed.map((r) => r.path))
  const covered = codeFiles.filter((p) => hit.has(p)).length
  return {
    tested: ran.length,
    killed: killed.length,
    kill_rate: ran.length ? +(killed.length / ran.length).toFixed(3) : null,
    coverage: codeFiles.length ? +(covered / codeFiles.length).toFixed(3) : null,
    weak: killed.length === 0,
  }
}
