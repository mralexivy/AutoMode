#!/usr/bin/env node
// Calibrate the optimizer's token priors from local transcripts. Read-only on the transcripts; it
// writes one JSON file (default: stdout). No inference, no network, $0.
//
//   node bench/calibrate.mjs [--root ~/.claude/projects] [--root ~/.claude-ectest/projects] [--out file]
//
// It measures, per model family and effort: main requests per person prompt (R), output tokens per
// request, thinking tokens, and the new input each request adds. A prior becomes `calibrated` only with
// at least MIN_N samples; otherwise the file keeps the estimate and says so. The optimizer reads the
// file from the plugin data folder (calibration.json next to decisions.jsonl), so each person's
// calibration comes from their own sessions.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listTranscripts, loadSession, median, quantile } from './lib/transcripts.mjs'
import { EFFORTS } from '../hooks/lib/types.ts'
import { DEFAULT_PRIORS } from '../hooks/lib/optimizer.ts'
import { familyOf } from '../hooks/lib/prices.ts'
import { transitionOf } from '../hooks/lib/transition.ts'
import { isChallenge } from '../hooks/lib/stage.ts'

export const MIN_N = 50

// stageOfText: the stage a prompt's text alone shows. Plan mode, edits and failures are not in a transcript's text, so
// the stages here are the ones text can tell apart. The text is used to classify and never leaves this function.
export function stageOfText(text) {
  const t = String(text ?? '').trim()
  const tr = transitionOf(t, '')
  if (tr.kind === 'repository') return 'repo-op'
  if (tr.kind === 'verification') return 'verify'
  if (tr.kind === 'acknowledgment') return 'complete'
  if (isChallenge(t)) return 'reconsider'
  if (/^(?:please )?(?:run |do |give me )?(?:a |the )?(?:final |code |independent )?review\b/i.test(t)) return 'review'
  if (t.length <= 120 && /^(where|what|which|why|how|explain|show|list|find)\b/i.test(t)) return 'lookup' // a long "find why X fails" is analysis, not a lookup
  if (/\b(analy[sz]e|investigate|root cause|audit|understand)\b/i.test(t)) return 'analyze'
  return 'implement'
}
const args = process.argv.slice(2)
const roots = []
let out = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') roots.push(args[++i].replace(/^~/, os.homedir()))
  else if (args[i] === '--out') out = args[++i]
}
if (!roots.length) roots.push(path.join(os.homedir(), '.claude', 'projects'))

export function calibrate(sessions) {
  const perPrompt = []
  const outBy = {}
  const byStage = {}
  const thinkBy = {}
  const growth = []
  let w1h = 0
  let w5m = 0
  const push = (m, k, v) => { (m[k] ??= []).push(v) }
  // Controlled effort pairs: within one session and one model, adjacent prompts sent at different
  // efforts. Still not causal (the two prompts are different tasks), but the session and model are held.
  const pairs = []
  for (const s of sessions) {
    const ps = s.prompts.filter((p) => p.requests.length)
    for (let i = 1; i < ps.length; i++) {
      const a = ps[i - 1]; const b = ps[i]
      const fa = familyOf(a.requests[0].model ?? ''); const fb = familyOf(b.requests[0].model ?? '')
      const ea = a.requests[0].sentEffort ?? a.requests[0].appEffort; const eb = b.requests[0].sentEffort ?? b.requests[0].appEffort
      if (!fa || fa !== fb || !ea || !eb || ea === eb) continue
      const mean = (p) => p.requests.reduce((x, r) => x + r.tokens.output, 0) / p.requests.length
      pairs.push({ family: fa, from: ea, to: eb, ratio: mean(b) / Math.max(1, mean(a)) })
    }
  }
  for (const s of sessions) {
    for (const p of s.prompts) {
      if (!p.requests.length) continue
      perPrompt.push(p.requests.length)
      if (p.text !== undefined) push(byStage, stageOfText(p.text), p.requests.length)
      for (let i = 0; i < p.requests.length; i++) {
        const r = p.requests[i]
        const fam = familyOf(r.model ?? '')
        if (!fam) continue
        const eff = r.sentEffort ?? r.appEffort ?? 'unknown'
        push(outBy, fam, r.tokens.output)
        push(outBy, `${fam}/${eff}`, r.tokens.output)
        if (r.tokens.thinking !== null) push(thinkBy, `${fam}/${eff}`, r.tokens.thinking)
        w1h += r.tokens.cacheWrite1h
        w5m += r.tokens.cacheWrite5m
        const next = p.requests[i + 1]
        if (next) {
          const prompt = (t) => t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h
          const g = prompt(next.tokens) - prompt(r.tokens) - r.tokens.output
          if (g > 0) growth.push(g)
        }
      }
    }
  }
  const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null)
  const stat = (xs) => ({ n: xs.length, mean: mean(xs), median: median(xs), p75: quantile(xs, 0.75) })
  // Cost is linear in tokens, so the priors use means; medians and p75 are reported beside them.
  const pick = (xs, fallback) => (xs && xs.length >= MIN_N ? { value: mean(xs), basis: 'calibrated', n: xs.length } : { value: fallback, basis: 'estimate', n: xs?.length ?? 0 })
  // Effort output ratios: within a family, mean output at each level over mean output at medium.
  const ratios = {}
  for (const e of EFFORTS) {
    const per = ['haiku', 'sonnet', 'opus'].map((f) => {
      const at = outBy[`${f}/${e}`]
      const mid = outBy[`${f}/medium`]
      return at && mid && at.length >= MIN_N && mid.length >= MIN_N ? { f, r: mean(at) / mean(mid), n: at.length } : null
    }).filter(Boolean)
    ratios[e] = per.length ? { value: Math.round(100 * per.reduce((a, x) => a + x.r * x.n, 0) / per.reduce((a, x) => a + x.n, 0)) / 100, basis: 'calibrated', from: per.map((x) => `${x.f} n=${x.n}`) } : { value: DEFAULT_PRIORS.effortOutput[e], basis: 'estimate', from: [] }
  }
  const R = pick(perPrompt, DEFAULT_PRIORS.remainingRequests)
  // Residual table: requests still to come after k, per prompt. Heavy-tailed, so quantiles only.
  const remaining = [0, 1, 2, 4, 8, 16, 32].map((k) => {
    const r = perPrompt.filter((n) => n > k).map((n) => n - k)
    return { k, n: r.length, p25: quantile(r, 0.25), median: median(r), p75: quantile(r, 0.75) }
  }).filter((row) => row.n >= MIN_N)
  // The same residual table per stage, for the stages with enough prompts. A commit and an implementation do not leave the
  // same work behind, and the cache payback of a switch reads the stage's own table (policy auto; v4.1 introduced it).
  const remainingByStage = Object.fromEntries(Object.entries(byStage).filter(([, xs]) => xs.length >= MIN_N).map(([stage, xs]) => [stage, [0, 1, 2, 4, 8, 16, 32].map((k) => {
    const r = xs.filter((n) => n > k).map((n) => n - k)
    return { k, n: r.length, p25: quantile(r, 0.25), median: median(r), p75: quantile(r, 0.75) }
  }).filter((row) => row.n >= MIN_N)]).filter(([, t]) => t.length))
  const newInput = pick(growth, DEFAULT_PRIORS.newInputPerStep)
  const outFam = Object.fromEntries(['haiku', 'sonnet', 'opus'].map((f) => [f, pick(outBy[f], DEFAULT_PRIORS.outputPerStep[f])]))
  // Effort never lowers output: a level measured below the one under it (task mix differs per level)
  // is lifted to that level, and marked so.
  for (let i = 1; i < EFFORTS.length; i++) {
    const lo = ratios[EFFORTS[i - 1]]
    const hi = ratios[EFFORTS[i]]
    if (hi.value < lo.value) ratios[EFFORTS[i]] = { ...hi, value: lo.value, basis: 'estimate', note: `measured ${hi.value} < ${EFFORTS[i - 1]}; lifted (mixed task sets)` }
  }
  const all = [R, newInput, ...Object.values(outFam)]
  return {
    generatedAt: new Date().toISOString(),
    source: `bench/calibrate.mjs over ${sessions.length} sessions`,
    minSamples: MIN_N,
    priors: {
      remainingRequests: R.value,
      newInputPerStep: newInput.value,
      outputPerStep: Object.fromEntries(Object.entries(outFam).map(([k, v]) => [k, v.value])),
      effortOutput: Object.fromEntries(Object.entries(ratios).map(([k, v]) => [k, v.value])),
      remaining,
      ...(Object.keys(remainingByStage).length ? { remainingByStage } : {}),
      basis: all.every((x) => x.basis === 'calibrated') ? 'calibrated' : 'estimate',
      source: 'calibration.json',
    },
    basis: { remainingRequests: R, newInputPerStep: newInput, outputPerStep: outFam, effortOutput: ratios },
    effortPairs: {
      n: pairs.length,
      note: 'Within-session, same-model adjacent prompts at different efforts. Different tasks, so still not causal; reported, never used as a prior below 50 pairs per direction.',
      byDirection: Object.fromEntries(Object.entries(pairs.reduce((m, x) => { (m[`${x.family} ${x.from}->${x.to}`] ??= []).push(x.ratio); return m }, {})).map(([k, v]) => [k, { n: v.length, median: Math.round(100 * median(v)) / 100 }])),
    },
    observed: {
      requestsPerPrompt: stat(perPrompt),
      requestsPerPromptByStage: Object.fromEntries(Object.entries(byStage).map(([k, v]) => [k, stat(v)])),
      newInputPerRequest: stat(growth),
      outputPerRequest: Object.fromEntries(Object.entries(outBy).map(([k, v]) => [k, stat(v)])),
      thinkingPerRequest: Object.fromEntries(Object.entries(thinkBy).map(([k, v]) => [k, stat(v)])),
      cacheWrites: { oneHourShare: w1h + w5m ? Math.round((1000 * w1h) / (w1h + w5m)) / 1000 : null },
    },
    caveats: [
      'Older model generations in the transcripts are pooled by family (opus-5 with opus-5-5).',
      'R counts main requests per person prompt; subagent requests are not in R.',
      'Effort ratios compare different tasks at each level: uncontrolled, so they stay estimates even with many samples; see effortPairs.',
      'Remaining work is a residual table of quantiles; the mean R is reported but no decision reads it.',
    ],
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sessions = listTranscripts(roots).map((f) => loadSession(f, { withText: true }))
  const result = calibrate(sessions)
  const text = JSON.stringify(result, null, 2)
  if (out) { fs.writeFileSync(out, text + '\n'); console.error(`wrote ${out}`) } else console.log(text)
}
