// The learning pass: what AutoMode does when the person is away. Pure: no `$`, no I/O; the model call is handed in.
//
// During work the mod follows rules and runs experiments (lib/experiment.ts). When the person has been idle for a while, at the end of a
// session, or on request, it runs a short pass over what happened, the way sleep consolidates a day:
//   1. find the gaps: where the money went, which cheaper starts won or lost, where tasks were rescued or could not be checked;
//   2. ask a cheap model (Haiku, about half a cent) to rank the hypotheses worth testing next and say why;
//   3. keep only what passes a whitelist, as a focus for the experiment engine, which tests it on the person's own tasks.
// The model proposes and the data decides: a proposal can only name an experiment the engine already knows, for a kind of task it is
// allowed to touch, and it changes how soon a probe runs, never a safety rule. A proposal the data already reverted is dropped, and the
// mod keeps a score of how many of the model's proposals the person's tasks confirmed, so it can tell whether the model helps.
// Step 1 needs no model, so a pass still gives an account of the gaps when the model is off, out of budget or unavailable.
import type { Learned } from './learn.ts'
import { WARMUP, failed as failedTask, reportOf, statusOf, type ExpKey } from './experiment.ts'

export interface Focus { key: ExpKey; tier: 'T1' | 'T2' | 'T3'; complexity: 'standard' | 'complex'; priority: number; why: string; at: number; plain?: boolean } // plain: the simple rule (costliest untested tiers first) would have picked it too
export interface Split { kept: number; confirmed: number; refuted: number }
export interface Score { proposed: number; confirmed: number; refuted: number; plain?: Split; extra?: Split } // plain: proposals the simple rule agrees with; extra: only the model's
export interface Run { at: number; usd: number; proposals: number; kept: number; model: boolean }
export interface Rulebook {
  v: 1
  focus: Focus[]
  insights: { at: number; text: string }[] // the last few passes, newest last
  runs: Run[] // the last passes with what each cost
  score: Score // how the model's proposals fared against the person's tasks
}
export const EMPTY_RULEBOOK: Rulebook = { v: 1, focus: [], insights: [], runs: [], score: { proposed: 0, confirmed: 0, refuted: 0, plain: { kept: 0, confirmed: 0, refuted: 0 }, extra: { kept: 0, confirmed: 0, refuted: 0 } } }

export const FOCUS_MS = 30 * 86_400_000
export const MAX_PROPOSALS = 3
export const MIN_NEW_TASKS = 3 // a pass waits until this many tasks are new since the last one
export const MIN_GAP_MS = 6 * 3_600_000 // and at least this long after the last pass
export const PASS_CAP_USD = 0.02
export const WEEK_CAP_USD = 0.2
const TIERS = ['T1', 'T2', 'T3']
const KEYS: ExpKey[] = ['haiku', 'effort']

const num = (n: unknown, d = 0) => (typeof n === 'number' && Number.isFinite(n) ? n : d)
export function parseRulebook(text: string): Rulebook {
  try {
    const j = JSON.parse(text) as Partial<Rulebook>
    if (j.v !== 1) return EMPTY_RULEBOOK
    const focus = (Array.isArray(j.focus) ? j.focus : []).filter((f) => f && KEYS.includes(f.key) && TIERS.includes(f.tier) && ['standard', 'complex'].includes(f.complexity) && Number.isFinite(f.at)).map((f) => ({ key: f.key, tier: f.tier, complexity: f.complexity, priority: Math.min(3, Math.max(1, Math.round(num(f.priority, 2)))), why: String(f.why ?? '').slice(0, 160), at: f.at, ...(f.plain === true ? { plain: true } : {}) }))
    const insights = (Array.isArray(j.insights) ? j.insights : []).filter((i) => i && typeof i.text === 'string' && Number.isFinite(i.at)).map((i) => ({ at: i.at, text: i.text.slice(0, 600) })).slice(-5)
    const runs = (Array.isArray(j.runs) ? j.runs : []).filter((r) => r && Number.isFinite(r.at) && Number.isFinite(r.usd)).map((r) => ({ at: r.at, usd: r.usd, proposals: num(r.proposals), kept: num(r.kept), model: r.model === true })).slice(-30)
    const sc = (j.score ?? {}) as Partial<Score>
    const split = (x: Partial<Split> | undefined): Split => ({ kept: num(x?.kept), confirmed: num(x?.confirmed), refuted: num(x?.refuted) })
    return { v: 1, focus: focus.slice(-12), insights, runs, score: { proposed: num(sc.proposed), confirmed: num(sc.confirmed), refuted: num(sc.refuted), plain: split(sc.plain), extra: split(sc.extra) } }
  } catch {
    return EMPTY_RULEBOOK
  }
}

export const focusFor = (rb: Rulebook, key: ExpKey, tier: string, complexity: string | undefined, now: number): boolean =>
  rb.focus.some((f) => f.key === key && f.tier === tier && f.complexity === (complexity === 'complex' ? 'complex' : 'standard') && now - f.at <= FOCUS_MS)

// ---------- step 1: the gaps, without a model ----------

export interface Finding { id: string; text: string; usd: number }
const usd2 = (x: number) => `$${x.toFixed(2)}`

export function findings(l: Learned, now: number, extra: { pingUsd: number; savedUsd: number; chal: 'champion' | 'challenger'; opusShare?: number | null } = { pingUsd: 0, savedUsd: 0, chal: 'champion' }): Finding[] {
  const out: Finding[] = []
  const recent = l.tasks.filter((t) => now - t.at <= 30 * 86_400_000 && !t.pinned)
  const spend = recent.reduce((a, t) => a + (t.usd ?? 0), 0)
  // Where the money went, by tier and starting model.
  const g = new Map<string, { n: number; usd: number; esc: number; open: number }>()
  for (const t of recent) {
    const k = `${t.bucket.split('/')[0]} on ${t.family}`
    const r = g.get(k) ?? { n: 0, usd: 0, esc: 0, open: 0 }
    r.n += 1; r.usd += t.usd ?? 0; r.esc += t.esc ? 1 : 0; r.open += t.outcome === 'open' ? 1 : 0
    g.set(k, r)
  }
  for (const [k, r] of [...g].sort((a, b) => b[1].usd - a[1].usd).slice(0, 5)) {
    if (r.n >= 3) out.push({ id: `spend:${k}`, usd: r.usd, text: `${k}: ${r.n} tasks, ${usd2(r.usd / r.n)} each, ${usd2(r.usd)} in all (${spend ? Math.round((100 * r.usd) / spend) : 0}% of ${usd2(spend)}); ${r.esc} rescued, ${r.open} unchecked` })
  }
  // By what the task changed, and why failures happened: a failure caused by the environment or a flaky test says nothing about the model.
  const byKind = new Map<string, { n: number; usd: number; failed: number }>()
  for (const t of recent) { if (!t.kind || t.kind === 'none') continue; const r = byKind.get(t.kind) ?? { n: 0, usd: 0, failed: 0 }; r.n += 1; r.usd += t.usd ?? 0; r.failed += failedTask(t) ? 1 : 0; byKind.set(t.kind, r) }
  for (const [k, r] of [...byKind].sort((a, b) => b[1].usd - a[1].usd)) if (r.n >= 3) out.push({ id: `kind:${k}`, usd: r.usd, text: `${k} tasks: ${r.n}, ${usd2(r.usd / r.n)} each, ${r.failed} failed because of the work` })
  const noise = recent.filter((t) => (t.esc || t.outcome === 'bad') && (t.cause === 'environment' || t.cause === 'flaky')).length
  if (noise) out.push({ id: 'noise', usd: 0, text: `${noise} rescued or failed tasks were caused by the environment or a flaky test, and do not count against any model` })
  // What the experiments found.
  for (const s of reportOf(l, now)) out.push({ id: `exp:${s.key}:${s.bucket}`, usd: 0, text: `${s.bucket} ${s.key} experiment: ${s.state} (${s.why}); probe ${s.probe.n} tasks ${usd2(s.probe.n ? s.probe.usd / s.probe.n : 0)} each ${s.probe.failed} failed, hold ${s.hold.n} tasks ${usd2(s.hold.n ? s.hold.usd / s.hold.n : 0)} each ${s.hold.failed} failed` })
  // Kinds of task with no experiment yet, and where failures would go unseen.
  for (const tier of TIERS) {
    const ts = recent.filter((t) => t.bucket.startsWith(tier + '/'))
    if (!ts.length) continue
    const checked = ts.filter((t) => t.outcome !== 'open' || t.esc).length
    const tested = reportOf(l, now).some((s) => s.bucket.startsWith(tier + '/'))
    if (ts.length >= WARMUP && checked / ts.length < 0.5) out.push({ id: `blind:${tier}`, usd: 0, text: `${tier}: ${ts.length} tasks but only ${checked} ran a check, so no cheaper start can be tried there` })
    else if (ts.length >= WARMUP && !tested) out.push({ id: `untested:${tier}`, usd: ts.reduce((a, t) => a + (t.usd ?? 0), 0), text: `${tier}: ${ts.length} tasks, ${usd2(ts.reduce((a, t) => a + (t.usd ?? 0), 0) / ts.length)} each, no cheaper start tried yet` })
  }
  if (extra.pingUsd > 0 || extra.savedUsd > 0) out.push({ id: 'cache', usd: extra.pingUsd, text: `keep warm: pings cost ${usd2(extra.pingUsd)} and avoided ${usd2(extra.savedUsd)} of rewrites; the ${extra.chal === 'challenger' ? 'return model' : 'simple rule'} acts` })
  return out
}

export const digestOf = (fs: Finding[]) => fs.slice(0, 12).map((f, i) => `${i + 1}. ${f.text}`).join('\n').slice(0, 2_400)

// ---------- step 2: the model ----------

export const REFLECT_SYSTEM = `You help a coding-assistant mod learn which cheaper model start works for one person. You get numbers only, no task text. Reply with one JSON object and nothing else:
{"insight":"<at most 280 characters: where the money goes and what is worth testing next>","proposals":[{"key":"haiku"|"effort","tier":"T1"|"T2"|"T3","complexity":"standard"|"complex","priority":1|2|3,"why":"<at most 120 characters>"}]}
"haiku" tests a Haiku start where the rules start higher. "effort" tests Sonnet at medium effort where the rules start at high. At most 3 proposals, the most expensive kinds of task first. Propose nothing for a kind of task that is unchecked, already adopted, or reverted. Never propose T0 or T4.`

export interface Reflection { insight: string; proposals: Focus[] }
export function parseReflection(text: string, now: number): Reflection | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  let j: any
  try { j = JSON.parse(m[0]) } catch { return null }
  if (typeof j?.insight !== 'string') return null
  const seen = new Set<string>()
  const proposals: Focus[] = []
  for (const p of Array.isArray(j.proposals) ? j.proposals : []) {
    if (!p || !KEYS.includes(p.key) || !TIERS.includes(p.tier) || !['standard', 'complex'].includes(p.complexity)) continue
    const id = `${p.key}|${p.tier}|${p.complexity}`
    if (seen.has(id)) continue
    seen.add(id)
    proposals.push({ key: p.key, tier: p.tier, complexity: p.complexity, priority: Math.min(3, Math.max(1, Math.round(num(p.priority, 2)))), why: String(p.why ?? '').replace(/\s+/g, ' ').slice(0, 140), at: now })
    if (proposals.length >= MAX_PROPOSALS) break
  }
  return { insight: j.insight.replace(/\s+/g, ' ').slice(0, 300), proposals }
}

// ---------- step 3: what to keep ----------

// vet drops proposals the person's own tasks rule out: a kind of task with no history, one the data already adopted or reverted.
export function vet(l: Learned, ps: Focus[], now: number): { kept: Focus[]; dropped: number } {
  const kept: Focus[] = []
  for (const p of ps) {
    const bucket = `${p.tier}/${p.complexity}`
    const tier = l.tasks.filter((t) => t.bucket.startsWith(p.tier + '/') && now - t.at <= 60 * 86_400_000 && !t.pinned)
    if (tier.length < WARMUP) continue
    const st = statusOf(l, p.key, bucket, now)
    if (st.state === 'adopted' || st.state === 'reverted') continue
    kept.push(p)
  }
  return { kept, dropped: ps.length - kept.length }
}

// scoreOf: how the model's earlier proposals fared. A proposal is confirmed when its experiment was adopted, refuted when it was reverted.
export function scoreOf(rb: Rulebook, l: Learned, now: number): Score {
  const tally = { plain: { confirmed: 0, refuted: 0 }, extra: { confirmed: 0, refuted: 0 } }
  for (const f of rb.focus) {
    const st = statusOf(l, f.key, `${f.tier}/${f.complexity}`, now).state
    const side = f.plain ? tally.plain : tally.extra
    if (st === 'adopted') side.confirmed += 1
    else if (st === 'reverted') side.refuted += 1
  }
  const keep = (a: number, b: number) => Math.max(a, b)
  const p = rb.score.plain ?? { kept: 0, confirmed: 0, refuted: 0 }, x = rb.score.extra ?? { kept: 0, confirmed: 0, refuted: 0 }
  const plain = { kept: p.kept, confirmed: keep(p.confirmed, tally.plain.confirmed), refuted: keep(p.refuted, tally.plain.refuted) }
  const extra = { kept: x.kept, confirmed: keep(x.confirmed, tally.extra.confirmed), refuted: keep(x.refuted, tally.extra.refuted) }
  return { proposed: rb.score.proposed, confirmed: plain.confirmed + extra.confirmed, refuted: plain.refuted + extra.refuted, plain, extra }
}

// plainPicks: what the simple rule would test next, the three costliest tiers with no cheaper start tried yet.
export const plainPicks = (fs: Finding[]) => fs.filter((f) => f.id.startsWith('untested:')).sort((a, b) => b.usd - a.usd).slice(0, MAX_PROPOSALS).map((f) => f.id.slice('untested:'.length))

// ---------- when a pass runs ----------

export interface Due { run: boolean; why: string }
export function due(o: { mode: 'auto' | 'manual' | 'off'; now: number; idleMs: number; idleMinMs: number; busy: boolean; rb: Rulebook; l: Learned; manual: boolean }): Due {
  if (o.mode === 'off' && !o.manual) return { run: false, why: 'learning passes are off' }
  if (o.manual) return { run: true, why: 'asked for' }
  if (o.mode !== 'auto') return { run: false, why: 'learning passes run only on request' }
  if (o.busy) return { run: false, why: 'a turn is running' }
  if (o.idleMs < o.idleMinMs) return { run: false, why: 'the person is still here' }
  const last = o.rb.runs[o.rb.runs.length - 1]
  if (last && o.now - last.at < MIN_GAP_MS) return { run: false, why: 'a pass ran recently' }
  const since = last ? o.l.tasks.filter((t) => t.at > last.at).length : o.l.tasks.length
  if (since < MIN_NEW_TASKS) return { run: false, why: 'too few new tasks' }
  return { run: true, why: 'idle, with new tasks to learn from' }
}
export const weekSpend = (rb: Rulebook, now: number) => rb.runs.filter((r) => now - r.at <= 7 * 86_400_000).reduce((a, r) => a + r.usd, 0)

export interface PassResult { rb: Rulebook; insight: string; usd: number; used: boolean; skipped: string | null }

// runPass: the whole pass. `complete` asks the model with the digest and returns its text and cost, or null.
export async function runPass(o: { l: Learned; rb: Rulebook; now: number; extra?: Parameters<typeof findings>[2]; model: boolean; complete: (system: string, digest: string) => Promise<{ text: string; usd: number } | null> }): Promise<PassResult> {
  const fs = findings(o.l, o.now, o.extra)
  const local = fs.length ? fs.slice(0, 3).map((f) => f.text).join('. ') : 'Not enough tasks yet to see where the money goes.'
  let reflection: Reflection | null = null, usd = 0, skipped: string | null = null
  const budgetLeft = WEEK_CAP_USD - weekSpend(o.rb, o.now)
  if (!o.model) skipped = 'the model step is off'
  else if (!fs.length) skipped = 'nothing to ask yet'
  else if (budgetLeft <= 0.002) skipped = 'the weekly learning budget is spent'
  else {
    const r = await o.complete(REFLECT_SYSTEM, digestOf(fs)).catch(() => null)
    if (!r) skipped = 'the model gave no answer'
    else { usd = Math.min(r.usd, PASS_CAP_USD); reflection = parseReflection(r.text, o.now); if (!reflection) skipped = 'the answer could not be read' }
  }
  const { kept, dropped } = reflection ? vet(o.l, reflection.proposals, o.now) : { kept: [], dropped: 0 }
  const live = o.rb.focus.filter((f) => o.now - f.at <= FOCUS_MS && !kept.some((k) => k.key === f.key && k.tier === f.tier && k.complexity === f.complexity))
  const text = reflection ? `${reflection.insight}${kept.length ? ` Next to test: ${kept.map((k) => `${k.tier}/${k.complexity} ${k.key}`).join(', ')}.` : ''}` : local
  const base = plainPicks(fs)
  const marked = kept.map((k) => ({ ...k, plain: base.includes(k.tier) }))
  const nPlain = marked.filter((k) => k.plain).length
  const rb: Rulebook = {
    v: 1, focus: [...live, ...marked].slice(-12), insights: [...o.rb.insights, { at: o.now, text }].slice(-5),
    runs: [...o.rb.runs, { at: o.now, usd, proposals: reflection?.proposals.length ?? 0, kept: kept.length, model: !!reflection }].slice(-30),
    score: { ...o.rb.score, proposed: o.rb.score.proposed + kept.length, plain: { ...(o.rb.score.plain ?? { kept: 0, confirmed: 0, refuted: 0 }), kept: (o.rb.score.plain?.kept ?? 0) + nPlain }, extra: { ...(o.rb.score.extra ?? { kept: 0, confirmed: 0, refuted: 0 }), kept: (o.rb.score.extra?.kept ?? 0) + kept.length - nPlain } },
  }
  rb.score = scoreOf(rb, o.l, o.now)
  void dropped
  return { rb, insight: text, usd, used: !!reflection, skipped }
}
