// The UI's view model: pure. The router (v4.ts) and the guardian (guardian.ts) hand over plain snapshots of state they
// already keep (RouterSnap, GuardSnap); the engine's own usage is UsageSnap. buildView turns them into what the drawings
// show, and barSegments fits the bar to a width. Nothing here computes a route, an effort, a price or a level: those are
// read. A value nobody measured yet is null and shows as "—"; the view never makes one up.
import type { AgentSnap, Alert, Effort, Facts, Family, GuardSnap, RouterSnap, Segment, Stage, Tip, Tone, UsageSnap, View, WorkflowStage } from '../../types/index.d.ts'

export type { AgentSnap, Alert, AlertKind, Effort, Facts, Family, Tip, GuardSnap, Ledger, Mode, RouterSnap, Segment, Tone, UsageSnap, View, WorkflowStage } from '../../types/index.d.ts'

// ---------------------------------------------------------------- words

const FAMILY_NAME: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' }
// modelName: "claude-sonnet-5-5[1m]" is "Sonnet 5.5", "claude-haiku-4-5@20251001" is "Haiku 4.5".
export function modelName(model: string | null | undefined): string {
  if (!model) return '—'
  const m = /(haiku|sonnet|opus|fable)[-_ ]?(\d+)(?:[-.](\d+))?/i.exec(model)
  if (!m) return model.replace(/^claude-/, '').slice(0, 18)
  return `${FAMILY_NAME[m[1].toLowerCase()]} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}
export function familyOfModel(model: string | null | undefined): Family | null {
  const m = /(haiku|sonnet|opus)/i.exec(model ?? '')
  return m ? (m[1].toLowerCase() as Family) : null
}
const EFFORT_NAME: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-High', max: 'Max' }
export const effortName = (e: Effort | null | undefined) => (e ? EFFORT_NAME[e] : '—')

export function usdText(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  if (v < 0.005) return '$0.00'
  if (v < 10) return `$${v.toFixed(2)}`
  if (v < 100) return `$${v.toFixed(1)}`
  return `$${Math.round(v)}`
}
export function tokensText(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
// cacheText: whole minutes left, rounded up, as effortless's cacheLabel does: "42m", "<1m", "cold".
export function cacheText(until: number | null, now: number): string {
  if (until === null) return '—'
  const ms = until - now
  if (ms <= 0) return 'cold'
  const min = Math.ceil(ms / 60_000)
  return min <= 1 ? '<1m' : `${min - 1}m`
}
// The ring's glyph for a share of the window: empty, quarter, half, three quarters, full.
export function ringGlyph(percent: number | null): string {
  if (percent === null) return '○'
  return percent < 12.5 ? '○' : percent < 37.5 ? '◔' : percent < 62.5 ? '◑' : percent < 87.5 ? '◕' : '●'
}

// ---------------------------------------------------------------- the view

const CONTEXT_HIGH = 60
const CONTEXT_FULL = 85
const COLD_MIN_TOKENS = 60_000 // the classic router's heavyChatTokens: below it a cold cache costs too little to say so
const LIMIT_ALERT = 90

const ROLE_STAGE: Record<string, WorkflowStage['name']> = {
  'automode:explorer': 'Discover', Explore: 'Discover', 'automode:architect': 'Plan', 'automode:planner': 'Plan', Plan: 'Plan',
  'automode:implementer': 'Build', 'automode:verifier': 'Verify', 'automode:diagnoser': 'Verify', 'automode:reviewer': 'Review',
}
const MAIN_STAGE: Partial<Record<Stage, WorkflowStage['name']>> = {
  lookup: 'Discover', explore: 'Discover', analyze: 'Discover', plan: 'Plan', 'plan-approved': 'Plan', implement: 'Build',
  verify: 'Verify', debug: 'Verify', reconsider: 'Plan', review: 'Review',
}
const STAGE_ORDER: WorkflowStage['name'][] = ['Discover', 'Plan', 'Build', 'Verify', 'Review']
export const stageOfRole = (type: string): WorkflowStage['name'] | null => ROLE_STAGE[type] ?? null

// workflowOf: the stages that ran, from the agents that ran them (the latest workflow run, else the main thread's
// agents and stage). A stage is shown only when something happened in it; mandatory review shows as required.
export function workflowOf(r: RouterSnap): WorkflowStage[] {
  const runs = r.agents.filter((a) => a.workflow)
  const lastRun = runs.length ? runs[runs.length - 1].workflow!.runId : null
  const agents = lastRun ? r.agents.filter((a) => a.workflow?.runId === lastRun) : r.agents.filter((a) => stageOfRole(a.type))
  const byStage = new Map<WorkflowStage['name'], AgentSnap[]>()
  for (const a of agents) { const s = stageOfRole(a.type); if (s) byStage.set(s, [...(byStage.get(s) ?? []), a]) }
  // The main thread's ordinary stages (a lookup, plain implementation, a repo operation) are not a workflow worth a track.
  const quiet = !byStage.size && ['lookup', 'implement', 'repo-op', 'complete'].includes(r.stage)
  const main = lastRun || quiet ? null : MAIN_STAGE[r.stage] ?? null
  if (!byStage.size && !main && !r.review.required) return []
  const out: WorkflowStage[] = []
  for (const name of STAGE_ORDER) {
    const list = byStage.get(name) ?? []
    let state: WorkflowStage['state'] | null = null
    if (list.some((a) => a.status === 'running')) state = 'active'
    else if (list.some((a) => a.status === 'failed' || a.result === 'failed')) state = 'failed'
    else if (list.length) state = 'done'
    if (name === main) state = state === 'failed' ? 'failed' : 'active'
    if (name === 'Verify' && !list.length && r.lastCheck && main !== 'Verify' && STAGE_ORDER.indexOf(main ?? 'Discover') >= STAGE_ORDER.indexOf('Verify')) state = r.lastCheck.passed ? 'done' : 'failed'
    if (name === 'Review' && !state && r.review.required) state = 'required'
    if (state) out.push({ name, state, agents: list })
  }
  return out
}

function routingOf(r: RouterSnap): View['routing'] {
  if (r.killed) return { label: 'ROUTER OFF', tone: 'dim', note: 'AUTOMODE_ROUTER=off', selectable: false }
  if (!r.enabled) return { label: 'ROUTER OFF', tone: 'dim', note: 'config.json router is not v4', selectable: false }
  if (!r.active) return { label: 'NOT ROUTING', tone: 'dim', note: `your model runs every prompt${r.subagentsEverySession ? '; subagents are still routed' : ''}`, selectable: false }
  if (r.mode === 'off') return { label: 'OFF', tone: 'dim', note: r.sessionMode === 'off' ? 'off for this session' : 'mode off in settings', selectable: true }
  if (r.mode === 'shadow') return { label: 'SHADOW', tone: 'dim', note: r.providerGuard ? `observing only: auto is unverified on ${r.provider}` : r.sessionMode === 'shadow' ? 'records only, this session' : 'records only', selectable: true }
  return { label: r.policy === 'legacy' ? 'AUTO · LEGACY' : 'AUTO', tone: 'route', note: r.sessionMode === 'auto' && r.configMode !== 'auto' ? 'auto for this session' : null, selectable: true }
}

function guardianOf(g: GuardSnap): View['guardian'] {
  if (g.killed) return { glyph: '–', tone: 'dim', label: 'Guardian off', state: 'off (AUTOMODE_GUARDIAN=off)', on: false }
  if (!g.enabled) return { glyph: '–', tone: 'dim', label: 'Guardian off', state: g.mode === 'off' ? 'off' : 'not in this session', on: false }
  if (g.paused && !g.continued) return { glyph: '■', tone: 'warn', label: 'Paused', state: 'paused', on: true }
  if (g.continued) return { glyph: '▶', tone: 'guard', label: 'Continuing', state: 'continue approved', on: true }
  if (g.level === 'pause' || g.level === 'warning') return { glyph: '▲', tone: 'warn', label: 'Guardian', state: g.level === 'pause' ? 'not converging' : 'cost without progress', on: true }
  if (g.level === 'optimize') return { glyph: '◐', tone: 'warn', label: 'Guardian', state: 'watch cost', on: true }
  if (g.offer) return { glyph: '▲', tone: 'warn', label: 'Guardian', state: g.offer.action === 'clear' ? 'handoff advised' : 'compact advised', on: true }
  return { glyph: '✓', tone: 'guard', label: 'Guardian', state: g.outcomes ? `healthy · ${g.outcomes} outcome${g.outcomes === 1 ? '' : 's'}` : 'healthy', on: true }
}

function alertOf(r: RouterSnap, g: GuardSnap, u: UsageSnap, cache: View['cache'], now: number): Alert | null {
  if (g.enabled && g.paused && !g.continued) {
    return { kind: 'paused', key: `paused:${g.paused.at}`, tone: 'warn', title: 'Guardian paused the turn', line: `${g.paused.reasons.join('; ') || 'not converging'}. ${g.outcomes} outcome${g.outcomes === 1 ? '' : 's'} recorded; the checkpoint is saved.`, actions: ['continue', 'compact', 'handoff'] }
  }
  if (r.active && r.mode === 'auto' && r.judgeDown.length && r.judgeDown.length >= 2) {
    return { kind: 'judge', key: `judge:${r.judgeDown.join(',')}`, tone: 'error', title: 'Judges not answering', line: 'Routing holds the last route and the effort fallback. No verdict is shown until a judge answers.', actions: ['details'] }
  }
  const open = r.breakers.filter((b) => b.until > now)
  if (r.active && r.mode === 'auto' && open.length) {
    const b = open[0]
    return { kind: 'judge', key: `breaker:${b.model}:${b.until}`, tone: 'error', title: `${modelName(b.model)} not answering`, line: `Routing without it for ${Math.max(1, Math.ceil((b.until - now) / 60_000))} min${b.cls ? ` (${b.cls})` : ''}.`, actions: ['details'] }
  }
  if (g.enabled && g.offer) {
    const k = Math.round(g.offer.contextTokens / 1000)
    return g.offer.action === 'clear'
      ? { kind: 'handoff', key: `offer:clear:${g.offer.at}`, tone: 'warn', title: 'Handoff advised', line: `Task looks done at ${k}k tokens.${g.offer.saves ? ` A fresh session saves ${g.offer.saves}.` : ''} The checkpoint carries the task over.`, actions: ['handoff', 'compact'] }
      : { kind: 'compact', key: `offer:compact:${g.offer.at}`, tone: 'warn', title: 'Compact advised', line: `Most of the ${k}k context is older than this task.${g.offer.saves ? ` Compacting saves ${g.offer.saves}.` : ''}`, actions: ['compact', 'handoff'] }
  }
  if (g.enabled && (g.level === 'warning' || g.level === 'pause')) {
    return { kind: 'warning', key: `level:${g.level}:${g.outcomes}`, tone: 'warn', title: g.level === 'pause' ? 'Not converging' : 'Cost without progress', line: `${g.sinceOutcome.requests} requests and ${usdText(g.sinceOutcome.usd)} since the last outcome (gate ${g.gates.requests} / ${usdText(g.gates.usd)}).${g.reasons.length ? ` ${g.reasons[0]}.` : ''}`, actions: ['details', 'compact'] }
  }
  if (g.restored) return { kind: 'restored', key: `restored:${g.restored.at}`, tone: 'guard', title: 'Checkpoint restored', line: `The task from session ${g.restored.from.slice(0, 8)} carries on here.`, actions: ['details'] }
  if (cache.state === 'cold' && (u.contextTokens ?? 0) >= COLD_MIN_TOKENS) {
    return { kind: 'cold', key: `cold:${cache.until}`, tone: 'cyan', title: 'Cache went cold', line: `The next message rereads ${tokensText(u.contextTokens)} tokens at full price. Compact or hand off first if the task is done.`, actions: ['compact', 'handoff'] }
  }
  const limit = u.limits.filter((l) => l.percent >= LIMIT_ALERT).sort((a, b) => b.percent - a.percent)[0]
  if (limit) return { kind: 'limit', key: `limit:${limit.name}:${Math.floor(limit.percent)}`, tone: 'warn', title: 'Usage limit close', line: `${Math.floor(limit.percent)}% of the ${limit.name.replace('_', '-')} limit is used.`, actions: ['details'] }
  return null
}

export function buildView(r: RouterSnap, g: GuardSnap, u: UsageSnap, now: number, facts: Facts = { outputStyle: null }): View {
  const routing = routingOf(r)
  const routes = r.active && r.mode === 'auto' && !r.killed && r.enabled
  // The model and effort that ran: the last answered request. Before the first one, the route the next request takes.
  let model: View['model']
  let effort: View['effort']
  if (routes && r.effective.model) model = { name: modelName(r.effective.model), family: familyOfModel(r.effective.model), source: 'effective' }
  else if (routes && r.requested) model = { name: modelName(r.requested.model), family: r.requested.family, source: 'next' }
  else if (r.effective.model) model = { name: modelName(r.effective.model), family: familyOfModel(r.effective.model), source: 'effective' }
  else model = r.sessionModel ? { name: modelName(r.sessionModel), family: familyOfModel(r.sessionModel), source: 'app' } : { name: '—', family: null, source: 'unknown' }
  const override = !!r.requested && r.requested.owner === 'user-override'
  if (routes && r.effective.effort) effort = { name: effortName(r.effective.effort), level: r.effective.effort, source: 'effective', override }
  else if (routes && r.requested) effort = { name: effortName(r.requested.effort), level: r.requested.effort, source: 'next', override }
  else effort = r.effective.effort ? { name: effortName(r.effective.effort), level: r.effective.effort, source: 'effective', override: false } : { name: '—', level: null, source: 'unknown', override: false }

  let pending: string | null = null
  if (routes && r.requested && model.source === 'effective') {
    if (r.requested.family !== model.family) pending = `→ ${FAMILY_NAME[r.requested.family]} next`
    else if (r.requested.effort !== effort.level) pending = `→ ${effortName(r.requested.effort)} next`
  }
  if (routes && r.held) pending = `→ ${FAMILY_NAME[r.held.family]} ${effortName(r.held.effort)} next turn`
  if (routes && !pending && r.deferredEffort && r.deferredEffort !== effort.level) pending = `→ ${effortName(r.deferredEffort)} at next input`

  const owner = r.requested?.owner ?? ''
  const hold = routes && /cache/.test(owner + ' ' + (r.requested?.reason ?? '')) && !/escalat/.test(owner) ? 'held: cache warm' : null
  const escalation = routes && /quality-escalation|escalat/.test(owner) ? `↑ ${r.requested?.reason || 'quality floor'}` : routes && r.inadequate ? `↑ needs more than ${r.inadequate.route}` : null

  const percent = u.percent ?? (u.contextTokens !== null && u.window ? Math.round((u.contextTokens / u.window) * 100) : null)
  const context: View['context'] = { percent, tokens: u.contextTokens, window: u.window, level: percent === null ? 'ok' : percent >= CONTEXT_FULL ? 'full' : percent >= CONTEXT_HIGH ? 'high' : 'ok' }
  const fam = model.family
  const w = fam ? r.warm[fam] : undefined
  const cache: View['cache'] = { state: !w ? 'unknown' : w.until > now ? 'warm' : 'cold', until: w?.until ?? null, ttlMs: r.ttlMs, family: fam }
  const verdictLine = r.verdict ? `${r.verdict.by === 'user' || r.verdict.by === 'named' ? 'You' : r.verdict.by}: ${r.verdict.why}` : null
  const judge: View['judge'] = r.judging ? { state: 'routing', line: 'Routing…' } : r.judgeDown.length ? { state: 'down', line: `${r.judgeDown.join(' and ')} judge paused` } : { state: 'idle', line: verdictLine }
  const workflow = workflowOf(r)
  const active = workflow.find((s) => s.state === 'active')
  return {
    at: now, routing, model, effort, pending, hold, escalation, context, cache,
    cost: { session: u.costUsd, turn: g.turnUsd },
    guardian: guardianOf(g),
    stage: r.planMode ? 'Plan mode' : active ? active.name : null,
    judge,
    alert: alertOf(r, g, u, cache, now),
    why: whyOf(r, routes, judge),
    tip: tipOf(r, g, context, facts),
    workflow, router: r, guard: g, usage: u,
  }
}

// whyOf: one short reason for the route, from what the router recorded. Nothing is made up: no record, no reason.
function whyOf(r: RouterSnap, routes: boolean, judge: View['judge']): string | null {
  if (!routes) return null
  if (judge.state === 'down') return 'judges paused, fallback route'
  const o = r.requested?.owner ?? ''
  let w = ''
  if (o === 'user-override') w = 'your choice'
  else if (/quality-escalation/.test(o)) w = r.requested?.reason || 'quality floor'
  else if (/cache/.test(o + ' ' + (r.requested?.reason ?? ''))) w = 'cache is warm, no switch'
  else w = r.verdict?.why || r.requested?.reason || ''
  w = w.replace(/\s+/g, ' ').trim()
  return w ? (w.length > 52 ? `${w.slice(0, 51)}…` : w) : null
}

// tipOf: the one hint that fits this state, most useful first. publish.ts decides whether it shows and for how long.
const STYLE = 'automode:Concise'
function tipOf(r: RouterSnap, g: GuardSnap, ctx: View['context'], facts: Facts): Tip | null {
  const t = (key: string, text: string): Tip => ({ key, text, until: 0 })
  if (r.enabled && !r.killed && !r.active) return t('unrouted', 'Pick AutoMode in /model to route model and effort automatically.')
  if (r.requested?.owner === 'user-override') return t('override', 'Your choice is fixed. am:reset returns to automatic.')
  if (ctx.percent !== null && ctx.percent >= 70) return t('ctx', 'Context is filling. /compact keeps the task and cuts cost.')
  if (r.active && r.ledger.requests === 0 && !r.verdict) return t('first', 'AutoMode picks the model and effort for each prompt. /automode help lists commands.')
  if (facts.outputStyle !== null && !new RegExp(`${STYLE}|^Concise$`).test(facts.outputStyle)) return t('style', `Shorter replies: /output-style ${STYLE}`)
  if (r.active && r.ledger.requests >= 3) return t('hm', 'am:opus, am:high, am:direct set the route for one prompt. /automode help')
  void g
  return null
}

// ---------------------------------------------------------------- fitting the bar

export type Metric = 'context' | 'cache' | 'cost' | 'guardian' | 'stage' | 'pending'
export const METRICS: readonly Metric[] = ['pending', 'context', 'cache', 'cost', 'guardian', 'stage']

// barSegments: the bar's words, minimal and most needed first, fitted to `columns` cells. Auto is the normal state and says
// nothing; another mode names itself. A healthy guardian is silent. The reason goes last and is the first to drop, then the
// stage, the cost and the cache. `shown` is the person's metrics setting.
export function barSegments(v: View, columns: number, now: number, shown: readonly Metric[] = METRICS): Segment[] {
  const has = (m: Metric) => shown.includes(m)
  const all: (Segment & { drop: number })[] = []
  if (v.routing.label !== 'AUTO') all.push({ key: 'mode', text: v.routing.label.toLowerCase().replace(' · ', ' '), tone: v.routing.tone, drop: 99 })
  all.push({ key: 'model', text: `✦ ${v.model.name}`, tone: v.model.source === 'effective' ? 'text' : 'dim', bold: v.model.source === 'effective', drop: 99 })
  all.push({ key: 'effort', text: v.effort.override ? `${v.effort.name} (yours)` : v.effort.name, tone: v.effort.source === 'effective' ? 'text' : 'dim', drop: 99 })
  // The reason (why) carries a hold or an escalation's cause; the bar keeps only the arrow of a pending change and a bare ↑.
  if (has('pending') && (v.pending || v.escalation)) all.push({ key: 'pending', text: v.pending ?? '↑', tone: v.pending ? 'dim' : 'warn', drop: 5 })
  if (has('context')) all.push({ key: 'context', text: v.context.percent === null ? '—' : `${Math.round(v.context.percent)}%`, tone: v.context.level === 'ok' ? 'text' : 'warn', drop: 4 })
  if (has('cache') && v.cache.state !== 'unknown') all.push({ key: 'cache', text: cacheText(v.cache.until, now), tone: v.cache.state === 'cold' ? 'dim' : 'dim', drop: 3 })
  if (has('cost')) all.push({ key: 'cost', text: usdText(v.cost.session), tone: v.cost.session === null ? 'dim' : 'text', drop: 2 })
  if (has('guardian') && v.guardian.on && v.guardian.tone === 'warn') all.push({ key: 'guardian', text: `${v.guardian.glyph} ${v.guardian.state}`, tone: 'warn', drop: 98 })
  if (has('stage') && v.stage) all.push({ key: 'stage', text: v.stage, tone: 'dim', drop: 1 })
  if (v.why) all.push({ key: 'why', text: v.why, tone: 'dim', sep: ' — ', drop: 0 })
  const width = (list: Segment[]) => list.reduce((n, s, i) => n + [...s.text].length + (i ? [...(s.sep ?? ' · ')].length : 0), 0)
  let list = all
  const steps: ((l: typeof all) => typeof all)[] = [
    (l) => l.filter((s) => s.drop !== 0),
    (l) => l.filter((s) => s.drop !== 1),
    (l) => l.filter((s) => s.drop !== 2),
    (l) => l.filter((s) => s.drop !== 3),
    (l) => l.map((s) => (s.key === 'pending' ? { ...s, text: s.text.replace(/ (next turn|next|at next input)$/, '') } : s)),
    (l) => l.filter((s) => s.drop !== 5),
    (l) => l.filter((s) => s.drop !== 4),
  ]
  for (const step of steps) { if (width(list) <= columns) break; list = step(list) }
  return list.map(({ drop: _d, ...s }) => s)
}

// barText: the bar as one line, the way a terminal reads it and the way /automode status prints it.
export const barText = (segs: Segment[]) => segs.map((s, i) => (i ? (s.sep ?? ' · ') : '') + s.text).join('')
