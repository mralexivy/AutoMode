// Cache keeper wiring: the cold-send guard, the keepalive and the habits it learns from. It owns every `$` call and the
// module state; the decisions live in lib/coldguard.ts, lib/keepwarm.ts and lib/keepgate.ts, the counts in lib/habits.ts,
// and the measured lifetime in lib/ttl.ts (wired in v4.ts). Every path fails open: an error here sends the prompt as typed
// and never blocks a request.
// The ideas come from the cache-keeper mod (MIT, github.com/nateherkai/claude-code-mods).
import type { EngineInterface } from 'claude-code'
import { v4CacheView, v4Learned, v4NoteCache, v4Rate, v4ResetLearned, v4TaskRaw } from './v4.ts'
import { habitsLoad, habitsSave, scanPass, scanStart } from './habitsio.ts'
import { ckConfig } from './lib/cachecfg.ts'
import { CHOICES, askText, choiceOf, isCold, quote, shouldAsk } from './lib/coldguard.ts'
import { EMPTY_HABITS, noteKeepalive, optIn, type Habits } from './lib/habits.ts'
import { learnedText } from './lib/insight.ts'
import { gate, stateOf } from './lib/keepgate.ts'
import { KEEP_OFF, TICK_MS, afterPing, clampHours, pingCostUsd, rewriteUsd, startKeepWarm, tick, type KeepWarmState } from './lib/keepwarm.ts'
import { familyOf } from './lib/prices.ts'
import { ask, compact, fork, later, toast } from './lib/io.ts'

let kw: KeepWarmState = KEEP_OFF
let H: Habits = EMPTY_HABITS
let busy = false
let pinging = false
let timer = false
let userOff = false
let lastActivityAt: number | null = null
let gapPings = 0
let gapPingUsd = 0
let skipped = ''
let savedAt = 0

async function clockNow($: EngineInterface): Promise<number> { try { return await $.clock.now() } catch { return Date.now() } }
const r4 = (n: number) => Math.round(n * 1e4) / 1e4

// ckPinging: a keepalive ping is in flight. The request it makes is not a task, so the router skips it.
export const ckPinging = () => pinging
export const ckHabits = () => H

export async function ckInit($: EngineInterface) {
  kw = KEEP_OFF; busy = false; pinging = false; timer = false; userOff = false; lastActivityAt = null; gapPings = 0; gapPingUsd = 0; skipped = ''
  try {
    const c = ckConfig(v4CacheView().cfg)
    if (!c.learnFromHistory) { H = EMPTY_HABITS; return }
    H = await habitsLoad($)
    void learn($)
  } catch {}
}

export function ckTurn(e: any, started: boolean) { if (e?.agentId === undefined && !pinging) busy = started }

// learn reads new transcript files a few at a time, then again every three hours, so a long session keeps learning.
async function learn($: EngineInterface) {
  try {
    let st = scanStart(H)
    const step = async () => {
      try {
        st = await scanPass($, st, await clockNow($))
        if (!st.done) { later($, 2_000, step); return }
        H = { ...st.h, kw: H.kw }
        v4NoteCache({ kind: 'habits', at: await clockNow($), event: 'scan', files: st.files, listed: st.seen, sessions: H.sessions, err: st.err })
        await habitsSave($, H)
        later($, 3 * 3_600_000, () => { void learn($) })
      } catch {}
    }
    await step()
  } catch {}
}

async function saveSoon($: EngineInterface, at: number) { if (at - savedAt > 60_000) { savedAt = at; await habitsSave($, H) } }

// ckBefore and ckAfter bracket one main request. Before: the cache as it stands. After: the request's usage, which settles
// the last idle gap (what its pings cost, and whether they kept the cache warm for the person's return).
export function ckBefore(e: any) { return e?.agentId === undefined ? v4CacheView() : null }
export interface RequestObs { at: number; prevAt: number | null; prevTokens: number; prevModel: string | null; ttlMs: number; cacheRead: number; cacheWrite: number }
export async function ckAfter($: EngineInterface, e: any, before: ReturnType<typeof v4CacheView> | null, res: any) {
  try {
    if (!before || e?.agentId !== undefined || pinging || !res?.usage) return
    onRequest($, { at: await clockNow($), prevAt: before.lastRequestAt, prevTokens: before.prefixTokens, prevModel: before.model, ttlMs: v4CacheView().ttlMs, cacheRead: Number(res.usage.cache_read_input_tokens ?? 0), cacheWrite: Number(res.usage.cache_creation_input_tokens ?? 0) })
  } catch {}
}
function onRequest($: EngineInterface, o: RequestObs) {
  lastActivityAt = o.at
  try {
    if (o.prevAt !== null && gapPings > 0) {
      const gap = o.at - o.prevAt
      const warm = o.cacheWrite < 0.2 * Math.max(1, o.cacheRead + o.cacheWrite)
      let saved = 0
      if (gap > o.ttlMs && warm && o.prevModel) {
        const rate = v4Rate(o.prevModel)
        saved = Math.max(0, rewriteUsd(o.prevTokens, rate, o.ttlMs) - pingCostUsd(o.prevTokens, rate) + 5 * rate.output / 1e6)
      }
      H = noteKeepalive(H, gapPingUsd, saved)
      v4NoteCache({ kind: 'keepwarm', at: o.at, event: 'settle', gapMin: Math.round(gap / 60_000), pings: gapPings, pingUsd: r4(gapPingUsd), savedUsd: r4(saved), warm })
      void saveSoon($, o.at)
    }
    gapPings = 0; gapPingUsd = 0; skipped = ''
    const v = v4CacheView()
    const c = ckConfig(v.cfg)
    if (!kw.on && !userOff && v.active && (c.keepWarm === 'auto' || (c.keepWarm === 'ask' && H.kw.optIn))) {
      kw = startKeepWarm(o.at, c.keepWarmHours)
      if (!timer) { timer = true; schedule($) }
    }
  } catch {}
}

// ckPromptSubmit asks before a person's prompt rewrites a big cold cache.
export async function ckPromptSubmit($: EngineInterface, e: any, next: any) {
  try {
    const v = v4CacheView()
    const c = ckConfig(v.cfg)
    const origin = e.origin?.kind
    const at = await clockNow($)
    if (!v.active || !shouldAsk({ guard: c.guard, fromPerson: origin === 'composer' || origin === 'bridge', midTurn: e.turnId !== undefined, prefixTokens: v.prefixTokens, lastRequestAt: v.lastRequestAt, ttlMs: v.ttlMs, now: at, bigTokens: c.guardTokens })) return next(e)
    const q = quote(v.prefixTokens, at - (v.lastRequestAt ?? at), v.ttlMs, v4Rate(v.model))
    const rec = { kind: 'cold-guard', at, prefixTokens: v.prefixTokens, idleMin: q.idleMin, rewriteUsd: r4(q.rewriteUsd) }
    // The fourth choice is offered only where keep warm could run: it is how a person says yes to it.
    const options = c.keepWarm === 'ask' && !H.kw.optIn ? [...CHOICES] : CHOICES.slice(0, 3)
    let answer: unknown
    try { answer = await ask($, `${askText(q, v.prefixTokens)} What should happen?`, options) } catch {
      // No dialog (a print-mode run, a dismissed question): the prompt goes as typed, and the record says why.
      v4NoteCache({ ...rec, choice: 'unavailable' })
      return next(e)
    }
    const choice = choiceOf(answer)
    v4NoteCache({ ...rec, choice })
    if (choice === 'cancel') { try { toast($, 'AutoMode: cancelled before a cold cache rewrite.') } catch {} ; return { drop: 'Cancelled by AutoMode before a cold cache rewrite' } }
    if (choice === 'compact') { try { await compact($) } catch {} }
    if (choice === 'keep') {
      H = optIn(H, true)
      await habitsSave($, H)
      userOff = false
      try { toast($, 'AutoMode: it will keep big chats warm when that pays. /automode keepwarm off turns it off.') } catch {}
    }
    return next(e)
  } catch { return next(e) }
}

// learnedCommand serves `/automode learned [reset]`.
export async function learnedCommand($: EngineInterface, rest: string): Promise<string> {
  const c = ckConfig(v4CacheView().cfg)
  if (rest.trim().toLowerCase() === 'reset') {
    kw = KEEP_OFF; userOff = false
    H = EMPTY_HABITS
    await habitsSave($, H)
    await v4ResetLearned($)
    return 'Everything AutoMode learned about your use is reset: idle-time counts, the keep-warm ledger and the route memory. It starts learning again from your history at the next session.'
  }
  const { learned, learning } = v4Learned()
  return learnedText({ habits: H, learned, now: await clockNow($), keepWarm: c.keepWarm, learning, learnFromHistory: c.learnFromHistory })
}

// keepWarmCommand serves `/automode keepwarm [hours|off|status]`.
export async function keepWarmCommand($: EngineInterface, rest: string): Promise<string> {
  const arg = rest.trim().toLowerCase()
  const v = v4CacheView()
  const led = H.kw
  const learned = `So far pings cost you $${led.pingUsd.toFixed(2)} and avoided $${led.savedUsd.toFixed(2)} of rewrites.`
  if (arg === 'off') { userOff = true; kw = { ...kw, on: false, stopped: 'turned off' }; H = optIn(H, false); await habitsSave($, H); return 'Keep warm is off, and it will not start by itself.' }
  if (arg === '' || arg === 'status') {
    if (!kw.on) return `Keep warm is off${kw.stopped ? ` (${kw.stopped})` : ''}. Turn it on with /automode keepwarm 4 (hours, up to 24). It sends a small ping before the cache expires and costs about $${(pingCostUsd(v.prefixTokens, v4Rate(v.model))).toFixed(2)} each at this context. ${learned}`
    return `Keep warm is on for ${Math.max(0, Math.round((kw.untilMs - (await clockNow($))) / 60_000))} more minutes: ${kw.pings} pings, $${kw.pingUsd.toFixed(2)} spent this session. ${learned}`
  }
  const hours = clampHours(Number(arg))
  if (!hours) return 'Use /automode keepwarm <hours> (up to 24), off, or status.'
  if (!v.active) return 'Keep warm needs AutoMode routing on for this session.'
  userOff = false
  kw = startKeepWarm(await clockNow($), hours)
  if (!timer) { timer = true; schedule($) }
  return `Keep warm is on for ${hours} h. A ping goes out only while the work looks unfinished and a return is likely. It stops at the time limit, at the session budget, when pings cost more than a rewrite, or if a ping fails.`
}

// schedule re-arms one 30-second timer for as long as keep warm is on.
function schedule($: EngineInterface) {
  try { later($, TICK_MS, async () => { await onTick($); if (kw.on) schedule($); else timer = false }) } catch { timer = false; kw = { ...kw, on: false, stopped: 'no timer in this engine' } }
}

// onTick runs every 30 s while the timer lives: ping, wait or stop.
async function onTick($: EngineInterface) {
  try {
    if (!kw.on || pinging) return
    const v = v4CacheView()
    if (!v.active) return
    const at = await clockNow($)
    const rate = v4Rate(v.model)
    const d = tick(kw, { mainRequests: v.mainRequests, now: at, lastActivityAt: Math.max(lastActivityAt ?? 0, v.lastRequestAt ?? 0) || null, ttlMs: v.ttlMs, busy, prefixTokens: v.prefixTokens, rate })
    if (d.action === 'wait') return
    if (d.action === 'stop') {
      kw = { ...kw, on: false, stopped: d.reason }
      v4NoteCache({ kind: 'keepwarm', at, event: 'stop', reason: d.reason, pings: kw.pings, pingUsd: r4(kw.pingUsd) })
      if (!/expired|time ran out/.test(d.reason)) { try { toast($, `AutoMode: keep warm stopped: ${d.reason}.`) } catch {} }
      return
    }
    const c = ckConfig(v.cfg)
    const g = gate({ habits: H, state: stateOf(v4TaskRaw()), prefixTokens: v.prefixTokens, family: familyOf(v.model ?? '') ?? 'sonnet', ttlMs: v.ttlMs, idleMin: (at - (v.lastRequestAt ?? at)) / 60_000, rate, minRewriteUsd: c.minRewriteUsd, sessionPingUsd: kw.pingUsd, budgetUsd: c.budgetUsd, capMin: c.keepWarmHours * 60 })
    if (!g.allow) {
      const key = `${g.why}|${v.lastRequestAt}`
      if (key !== skipped) { skipped = key; v4NoteCache({ kind: 'keepwarm', at, event: 'skip', why: g.why, net: g.net === null ? null : r4(g.net) }) }
      return
    }
    pinging = true
    let r: any = null
    try { r = await fork($, { prompt: 'AutoMode keep-alive ping. Reply with only: ok' }) } catch { r = null } finally { pinging = false }
    const u = r?.usage ? { cacheRead: Number(r.usage.cache_read_input_tokens ?? 0), cacheWrite: Number(r.usage.cache_creation_input_tokens ?? 0) } : null
    const usd = pingCostUsd(u ? u.cacheRead + u.cacheWrite : v.prefixTokens, rate)
    kw = afterPing(kw, at, usd, u)
    lastActivityAt = at
    gapPings += 1; gapPingUsd += usd
    v4NoteCache({ kind: 'keepwarm', at, event: 'ping', cacheRead: u?.cacheRead ?? null, cacheWrite: u?.cacheWrite ?? null, usd: r4(usd), why: g.why, stopped: kw.stopped })
    if (kw.stopped) { try { toast($, `AutoMode: keep warm stopped: ${kw.stopped}.`) } catch {} }
  } catch { pinging = false }
}

export { isCold }
