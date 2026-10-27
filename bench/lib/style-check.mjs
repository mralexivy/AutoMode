// Checks for the output style benchmark (bench/style-check.mjs). Pure functions: no model call, no network.
// Each check takes the reply text and returns { ok, why }. `facts` also returns a recall in 0..1.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function codeBlocks(text) {
  const out = []
  const re = /```([A-Za-z0-9_+-]*)\n([\s\S]*?)```/g
  for (let m; (m = re.exec(text));) out.push({ lang: m[1].toLowerCase(), code: m[2] })
  return out
}

// runJs runs the first JavaScript block under node's permission model: no file reads except the script, no child
// processes, no network. Model-written code never touches the machine.
export function runJs(text, timeoutMs = 5000) {
  const block = codeBlocks(text).find((b) => ['js', 'javascript', 'node', ''].includes(b.lang))
  if (!block) return { ok: false, why: 'no code block', stdout: '' }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'style-js-'))) // the permission model compares real paths
  const file = path.join(dir, 'case.js')
  fs.writeFileSync(file, block.code)
  const r = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${file}`, file], { encoding: 'utf8', timeout: timeoutMs })
  fs.rmSync(dir, { recursive: true, force: true })
  if (r.status !== 0) return { ok: false, why: `exit ${r.status}: ${String(r.stderr).split('\n')[0]}`, stdout: r.stdout ?? '' }
  return { ok: true, why: '', stdout: String(r.stdout).trim() }
}

const re = (p, f = 'i') => new RegExp(p, f)

// runCheck: one check against one reply.
//   has       all: exact substrings, case-sensitive (commands, flags, paths)
//   any       patterns: at least one regex matches
//   facts     patterns: regexes, recall = matched / total, ok when recall >= min (default 1)
//   verbatim  text: the reply contains it character for character
//   absent    pattern: the regex must not match
//   count     pattern, min, max: number of matches
//   runjs     stdout: the first JavaScript block runs and prints exactly this
export function runCheck(check, text) {
  switch (check.type) {
    case 'has': {
      const missing = check.all.filter((s) => !text.includes(s))
      return { ok: !missing.length, why: missing.length ? `missing ${JSON.stringify(missing)}` : '' }
    }
    case 'any': {
      const hit = check.patterns.some((p) => re(p, check.flags).test(text))
      return { ok: hit, why: hit ? '' : `none of ${check.patterns.length} patterns matched` }
    }
    case 'facts': {
      const hits = check.patterns.filter((p) => re(p, check.flags).test(text)).length
      const recall = hits / check.patterns.length
      return { ok: recall >= (check.min ?? 1), recall, why: `recall ${hits}/${check.patterns.length}` }
    }
    case 'verbatim':
      return { ok: text.includes(check.text), why: text.includes(check.text) ? '' : 'text changed' }
    case 'absent': {
      const hit = re(check.pattern, check.flags).test(text)
      return { ok: !hit, why: hit ? `matched ${check.pattern}` : '' }
    }
    case 'count': {
      const n = (text.match(re(check.pattern, check.flags ?? 'gi')) ?? []).length
      const ok = n >= (check.min ?? 0) && n <= (check.max ?? Infinity)
      return { ok, why: `${n} matches` }
    }
    case 'runjs': {
      const r = runJs(text)
      if (!r.ok) return { ok: false, why: r.why }
      return { ok: r.stdout === check.stdout, why: r.stdout === check.stdout ? '' : `printed ${JSON.stringify(r.stdout)}` }
    }
    default:
      throw new Error(`unknown check type ${check.type}`)
  }
}

// scoreCase: every check of the case against one reply. A case passes when all of its checks pass.
export function scoreCase(c, text) {
  const results = c.checks.map((k) => ({ type: k.type, ...runCheck(k, text) }))
  const recalls = results.filter((r) => r.recall !== undefined).map((r) => r.recall)
  return { ok: results.every((r) => r.ok), results, recall: recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null }
}

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  if (!s.length) return null
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// compareArms: rows are { caseId, group, hard, arm, ok, recall, outTokens }. Returns the verdict for the report.
//   regressions: a hard case where the control passed every repeat and the style failed at least one
//   factDrop: mean recall of the soft cases, control minus style
//   tokens: median output tokens per case and the overall ratio
export function compareArms(rows) {
  const by = (arm, id) => rows.filter((r) => r.arm === arm && r.caseId === id)
  const ids = [...new Set(rows.map((r) => r.caseId))]
  const regressions = []
  const tokenRatios = []
  const recallOf = { control: [], style: [] }
  for (const id of ids) {
    const ctl = by('control', id), sty = by('style', id)
    if (!ctl.length || !sty.length) continue
    const hard = ctl[0].hard
    if (hard && ctl.every((r) => r.ok) && sty.some((r) => !r.ok)) {
      regressions.push({ caseId: id, group: ctl[0].group, failed: sty.filter((r) => !r.ok).length, of: sty.length })
    }
    const mc = median(ctl.map((r) => r.outTokens).filter(Number.isFinite)), ms = median(sty.map((r) => r.outTokens).filter(Number.isFinite))
    if (mc && ms) tokenRatios.push({ caseId: id, control: mc, style: ms, ratio: ms / mc })
    if (!hard) {
      recallOf.control.push(...ctl.map((r) => r.recall ?? 0))
      recallOf.style.push(...sty.map((r) => r.recall ?? 0))
    }
  }
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  const factDrop = mean(recallOf.control) !== null ? mean(recallOf.control) - mean(recallOf.style) : null
  const sum = (k) => tokenRatios.reduce((a, r) => a + r[k], 0)
  return {
    regressions,
    factRecall: { control: mean(recallOf.control), style: mean(recallOf.style), drop: factDrop },
    tokens: { cases: tokenRatios, medianRatio: median(tokenRatios.map((r) => r.ratio)), totalRatio: sum('control') ? sum('style') / sum('control') : null },
    safe: regressions.length === 0 && (factDrop === null || factDrop <= 0.1),
  }
}
