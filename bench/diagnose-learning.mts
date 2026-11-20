#!/usr/bin/env node
// Why a learned keep-warm rule cannot beat the simple one on one person's data. $0, read-only, numbers only.
// Three measurements over this person's interactive sessions (scripted runs left out):
//   1. headroom: what a rule that knew every return in advance (an oracle) would net, and what idle-expiry rewrites cost in all;
//   2. which cheap, privacy-safe features predict a return after a long idle gap (AUC with a resampled interval);
//   3. how few events there are to learn from.
// Usage: node bench/diagnose-learning.mts
// Per-session numbers for the "why is learning no better" analysis. Numbers only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ANTHROPIC, cacheWriteX, familyOf, rateAt } from '../hooks/lib/prices.ts'
export interface Q { at: number; tokens: number; family: string; acted: boolean; ttl: number | null; edit: boolean; bash: boolean; test: boolean; ask: boolean; out: number; tools: number }
export interface S { entry: string | null; prompts: number[]; reqs: Q[] }
const typed = (r: any) => { if (r.type !== 'user' || r.isSidechain || r.isMeta || r.isCompactSummary) return false; const c = r.message?.content
  if (typeof c === 'string') return !c.startsWith('<command-') && !c.startsWith('<local-command') && c.trim().length > 0
  return Array.isArray(c) && c.some((b: any) => b?.type === 'text' && b.text?.trim() && !b.text.startsWith('<command-')) && !c.some((b: any) => b?.type === 'tool_result') }
export function load(days = 120): S[] {
  const root = path.join(os.homedir(), '.claude/projects'); const now = Date.now(); const out: S[] = []
  for (const d of fs.readdirSync(root)) { let fl: string[] = []; try { fl = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl')) } catch { continue }
    for (const f of fl) { const p = path.join(root, d, f); if (now - fs.statSync(p).mtimeMs > days * 86_400_000) continue
      const by = new Map<string, Q>(); const prompts: number[] = []; let entry: string | null = null
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) { if (!line) continue; let r: any; try { r = JSON.parse(line) } catch { continue }
        if (entry === null && typeof r.entrypoint === 'string') entry = r.entrypoint
        if (typed(r)) { prompts.push(Date.parse(r.timestamp)); continue }
        if (r.type !== 'assistant' || r.isSidechain || !r.message?.usage || !r.requestId) continue
        const u = r.message.usage; const fam = familyOf(String(r.message.model ?? '')); if (!fam) continue
        const prev = by.get(r.requestId); const acted = prev?.acted || (Array.isArray(r.message.content) && r.message.content.some((b: any) => b?.type === 'tool_use'))
        const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0, w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? 0
        const blocks: any[] = Array.isArray(r.message.content) ? r.message.content : []
        const tu = blocks.filter((b: any) => b?.type === 'tool_use'); const txt = blocks.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join(' ').trim()
        const edit = prev?.edit || tu.some((b: any) => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name)); const bash = prev?.bash || tu.some((b: any) => b.name === 'Bash'); const test = prev?.test || tu.some((b: any) => b.name === 'Bash' && /\b(test|pytest|jest|vitest|cargo test|go test|npm run check|tsc|build)\b/i.test(String(b.input?.command ?? '')))
        const ask = prev?.ask || (txt.length > 0 && /\?\s*$/.test(txt))
        by.set(r.requestId, { edit, bash, test, ask, out: u.output_tokens ?? 0, tools: (prev?.tools ?? 0) + tu.length, at: prev?.at ?? Date.parse(r.timestamp), tokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), family: fam, acted: !!acted, ttl: w1 > w5 ? 3.6e6 : w5 > 0 ? 3e5 : prev?.ttl ?? null }) }
      const reqs = [...by.values()].filter((q) => Number.isFinite(q.at)).sort((a, b) => a.at - b.at)
      if (reqs.length && prompts.length >= 2 && entry !== 'sdk-cli') out.push({ entry, prompts: prompts.filter(Number.isFinite).sort((a, b) => a - b), reqs }) } }
  return out.sort((a, b) => a.reqs[0].at - b.reqs[0].at)
}

function headroom() {
  const S = load(); const now = Date.now(); const DAY = 86_400_000
const costs = (tokens: number, fam: string, ttl: number) => { const r = rateAt((ANTHROPIC.rates as any)[fam], tokens); return { read: tokens * r.input * r.cacheReadX / 1e6, rewrite: tokens * r.input * cacheWriteX(ttl) / 1e6 } }
let spendRewrite = 0, nRewrite = 0, gapsAll = 0, gaps1h = 0, gaps5m = 0; const byTtl: any = { '1h': { n: 0, rw: 0 }, '5m': { n: 0, rw: 0 } }
const buckets: Record<string, number> = { '<60k': 0, '60-150k': 0, '>150k': 0 }; const sizeRw: Record<string, number> = { '<60k': 0, '60-150k': 0, '>150k': 0 }
let oracle = 0, oraclePings = 0
for (const s of S) { const ttl = s.reqs.find((q) => q.ttl)?.ttl ?? 3.6e6
  for (let i = 1; i < s.reqs.length; i++) { const a = s.reqs[i - 1], b = s.reqs[i]; const g = (b.at - a.at); gapsAll++
    if (g < 3 * 60000 || a.acted) continue
    if (g > ttl && g < DAY && a.tokens > 30000) { const c = costs(a.tokens, a.family, ttl); const k = ttl > 4e5 ? '1h' : '5m'; byTtl[k].n++; byTtl[k].rw += c.rewrite - c.read; nRewrite++; spendRewrite += c.rewrite - c.read
      const sz = a.tokens < 60000 ? '<60k' : a.tokens < 150000 ? '60-150k' : '>150k'; buckets[sz]++; sizeRw[sz] += c.rewrite - c.read
      // oracle: ping through the gap only when the return is within 4h; cost = pings read, saving = rewrite - read
      if (g <= 4 * 3.6e6) { const every = ttl - (ttl >= 3.6e6 ? 480000 : 150000); const n = Math.floor(g / every); const cost = n * c.read; if (c.rewrite - c.read - cost > 0) { oracle += c.rewrite - c.read - cost; oraclePings += n } } } } }
const r = (x: number) => Math.round(x * 100) / 100
console.log('HEADROOM', JSON.stringify({ interactiveSessions: S.length, rewritesWithReturn: nRewrite, totalRewriteWasteUsd: r(spendRewrite), byTtl: { '1h': { n: byTtl['1h'].n, usd: r(byTtl['1h'].rw) }, '5m': { n: byTtl['5m'].n, usd: r(byTtl['5m'].rw) } }, bySize: Object.fromEntries(Object.keys(buckets).map((k) => [k, { n: buckets[k], usd: r(sizeRw[k]) }])), oracleNetUsd: r(oracle), oraclePings, windowDays: r((Math.max(...S.map((s) => s.reqs.at(-1)!.at)) - Math.min(...S.map((s) => s.reqs[0].at))) / DAY) }, null, 1))

}
function features() {
  const S = load(); const now = Date.now(); const DAY = 86_400_000, MIN = 60_000
interface P { y: number; sess: number; f: Record<string, number> }
const pts: P[] = []
S.forEach((s, si) => { const gaps: number[] = []
  for (let i = 0; i < s.reqs.length; i++) { const a = s.reqs[i], b = s.reqs[i + 1]; const g = b ? (b.at - a.at) / MIN : Infinity
    if (!b && now - a.at < 3 * DAY) continue
    // the turn that ended at `a`: requests since the last typed prompt
    const lastPrompt = Math.max(0, ...s.prompts.filter((p) => p <= a.at)); const turn = s.reqs.filter((q) => q.at >= lastPrompt - 1000 && q.at <= a.at)
    if (g >= 3 && g < 1440 || !b) { if (!b || !a.acted) {
      const d = new Date(a.at)
      for (const t of [10, 30, 52]) { if (g < t) continue
        pts.push({ y: g <= t + 60 ? 1 : 0, sess: si, f: {
          size: Math.log(a.tokens), idle: t, hour: d.getHours(), weekday: d.getDay() >= 1 && d.getDay() <= 5 ? 1 : 0, workhours: d.getHours() >= 9 && d.getHours() < 19 ? 1 : 0,
          prompts: s.prompts.filter((p) => p <= a.at).length, age: Math.log1p((a.at - s.reqs[0].at) / MIN), lastGap: gaps.length ? Math.log1p(gaps[gaps.length - 1]) : 0, hasHist: gaps.length ? 1 : 0,
          turnEdited: turn.some((q) => q.edit) ? 1 : 0, turnBash: turn.some((q) => q.bash) ? 1 : 0, turnTest: turn.some((q) => q.test) ? 1 : 0, turnTools: Math.log1p(turn.reduce((x, q) => x + q.tools, 0)), turnReqs: Math.log1p(turn.length),
          askedQuestion: a.ask ? 1 : 0, outTokens: Math.log1p(a.out), turnOut: Math.log1p(turn.reduce((x, q) => x + q.out, 0)), editNoTest: turn.some((q) => q.edit) && !turn.some((q) => q.test) ? 1 : 0 } }) } } }
    if (g >= 3 && g < 1440 && !a.acted) gaps.push(g) } })
const auc = (ps: number[], ys: number[]) => { let n = 0, c = 0; for (let i = 0; i < ps.length; i++) for (let j = 0; j < ps.length; j++) if (ys[i] === 1 && ys[j] === 0) { n++; c += ps[i] > ps[j] ? 1 : ps[i] === ps[j] ? 0.5 : 0 } return n ? c / n : NaN }
const sessIds = [...new Set(pts.map((p) => p.sess))]
const boot = (key: string) => { const out: number[] = []; let s = 11; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 }
  for (let d = 0; d < 300; d++) { const pick = Array.from({ length: sessIds.length }, () => sessIds[Math.floor(rnd() * sessIds.length)]); const sel = pick.flatMap((id) => pts.filter((p) => p.sess === id)); if (sel.filter((p) => p.y).length < 3 || sel.filter((p) => !p.y).length < 3) continue; out.push(auc(sel.map((p) => p.f[key]), sel.map((p) => p.y))) }
  out.sort((a, b) => a - b); return [out[Math.floor(out.length * 0.05)], out[Math.floor(out.length * 0.95)]] }
console.log('points', pts.length, 'positives', pts.filter((p) => p.y).length, 'sessions', sessIds.length)
const keys = Object.keys(pts[0].f); const rows = keys.map((k) => { const a = auc(pts.map((p) => p.f[k]), pts.map((p) => p.y)); const [lo, hi] = boot(k); return { k, auc: +a.toFixed(3), lo: +lo.toFixed(2), hi: +hi.toFixed(2) } }).sort((a, b) => Math.abs(b.auc - 0.5) - Math.abs(a.auc - 0.5))
for (const r of rows) console.log(r.k.padEnd(12), 'AUC', r.auc, `[${r.lo}, ${r.hi}]`, r.auc > 0.5 ? 'higher => returns' : 'higher => stays away')
// mean return rate by binary features
for (const k of ['turnEdited', 'turnTest', 'editNoTest', 'askedQuestion', 'turnBash', 'workhours', 'weekday']) { const a = pts.filter((p) => p.f[k] === 1), b = pts.filter((p) => p.f[k] === 0); console.log(k.padEnd(11), 'with: n', a.length, 'return', +(a.filter((p) => p.y).length / Math.max(1, a.length)).toFixed(2), '| without: n', b.length, 'return', +(b.filter((p) => p.y).length / Math.max(1, b.length)).toFixed(2)) }

}
headroom()
features()
