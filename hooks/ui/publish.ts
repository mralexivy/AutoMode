// The UI's one source: the `automode.view` atom in $.state, written here and read by every drawing. The router and
// the guardian call publish() where their state already changes; publish reads their snapshots and the engine's usage,
// builds the view (view.ts), and writes it only when it differs from the last one, so a publish that changes nothing
// redraws nothing and no update can feed itself. A drawing never calls publish: a ui.render hook may not write.
// publish never throws and never makes a model call.
import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import { buildView, type Facts, type GuardSnap, type RouterSnap, type UsageSnap, type View } from './view.ts'
import { sid, fsRead, sessionModel } from '../lib/io.ts'

export const viewAtom = atom({ plugin: 'automode', key: 'view' } as const, null as View | null)

// Set by register.ts at register: the router's and the guardian's snapshot functions. Kept as functions handed in, so this
// module imports neither (they import it).
type Sources = { router: (sessionModel: string | null, now: number) => RouterSnap; guardian: () => GuardSnap }
let sources: Sources | null = null
export const setSources = (s: Sources) => { sources = s }

// Off with AUTOMODE_UI=off: nothing is written, and the drawings step aside.
let uiOff: boolean | null = null
export async function uiDisabled($: EngineInterface): Promise<boolean> {
  if (uiOff === null) { try { uiOff = ['off', '0', 'false'].includes(String((await $.env.get('AUTOMODE_UI')) ?? '').trim().toLowerCase()) } catch { uiOff = false } }
  return uiOff
}
export const __resetPublish = () => { uiOff = null; last = ''; tipNow = { key: '', until: 0 }; tipCounts = null; facts = { outputStyle: null } }

// What the view cannot read from the router: the person's output style (user settings.json, read once per session start).
let facts: Facts = { outputStyle: null }
export async function loadFacts($: EngineInterface): Promise<void> {
  try {
    const home = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
    const style = JSON.parse(await fsRead($, `${home}/settings.json`))?.outputStyle
    facts = { outputStyle: typeof style === 'string' && style ? style : 'default' }
  } catch { facts = { outputStyle: null } }
}

// Tips are hints, not furniture: each shows for TIP_MS the first time it applies in a session and at most TIP_MAX times on
// this machine (the counts live in $.store). A tip that no longer applies goes at once.
const TIP_MS = 90_000
const TIP_MAX = 3
const TIPS_KEY = 'automode-tips'
let tipNow = { key: '', until: 0 }
let tipCounts: Record<string, number> | null = null
async function gateTip($: EngineInterface, v: View, now: number): Promise<View> {
  const cand = v.tip
  if (!cand) { tipNow = { key: '', until: 0 }; return v }
  if (tipNow.key !== cand.key) {
    if (tipCounts === null) { try { tipCounts = ((await $.store.get(TIPS_KEY)) as Record<string, number>) ?? {} } catch { tipCounts = {} } }
    const n = tipCounts[cand.key] ?? 0
    if (n >= TIP_MAX) tipNow = { key: cand.key, until: 0 }
    else {
      tipNow = { key: cand.key, until: now + TIP_MS }
      tipCounts = { ...tipCounts, [cand.key]: n + 1 }
      try { await $.store.set(TIPS_KEY, tipCounts) } catch {}
    }
  }
  return { ...v, tip: tipNow.until > 0 ? { ...cand, until: tipNow.until } : null }
}

export async function usageSnap($: EngineInterface): Promise<UsageSnap> {
  try {
    const u: any = await $.session.usage()
    const limits = Array.isArray(u?.rateLimits) ? u.rateLimits.filter((r: any) => Number.isFinite(r?.percentUsed)).map((r: any) => ({ name: String(r.window ?? r.name ?? 'usage'), percent: Number(r.percentUsed) })) : []
    return {
      costUsd: typeof u?.cost?.usd === 'number' ? u.cost.usd : null,
      contextTokens: typeof u?.context?.tokens === 'number' ? u.context.tokens : null,
      window: typeof u?.context?.window === 'number' && u.context.window > 0 ? u.context.window : null,
      percent: typeof u?.context?.percent === 'number' ? u.context.percent : null,
      limits,
    }
  } catch { return { costUsd: null, contextTokens: null, window: null, percent: null, limits: [] } }
}

// snapshotView: the view as it stands now, without writing it (the /automode status command prints this).
export async function snapshotView($: EngineInterface): Promise<View | null> {
  if (!sources) return null
  let now = Date.now()
  try { now = await $.clock.now() } catch {}
  let model: string | null = null
  try { model = (await sessionModel($)) ?? null } catch {}
  return gateTip($, buildView(sources.router(model, now), sources.guardian(), await usageSnap($), now, facts), now)
}

let last = ''
// The structural compare leaves out `at` (the time of the build): a view that only got older is the same view. The
// session id is part of the key: two sessions in one process each get their own first write.
const keyOf = (session: string, v: View) => `${session}|${JSON.stringify({ ...v, at: 0 })}`

// Total by construction: every step is inside the try, so a caller never needs its own guard and a UI fault can never
// stop a routing or guardian step that awaits it.
export async function publish($: EngineInterface): Promise<void> {
  try {
    if (await uiDisabled($)) return
    const v = await snapshotView($)
    if (!v) return
    let session = ''
    try { session = await sid($) } catch {}
    const k = keyOf(session, v)
    if (k === last) return
    last = k
    await update($, viewAtom, () => v)
  } catch { /* the UI never interrupts routing or the guardian */ }
}
