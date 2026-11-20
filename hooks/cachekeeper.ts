// Cache keeper wiring: the cold-send guard, the keepalive, and what it learns from the person's own use. It owns every `$` call and the
// module state; the decisions live in lib/coldguard.ts, lib/keepwarm.ts and lib/keepgate.ts, the counts in lib/habits.ts, and the
// measured lifetime in lib/ttl.ts (wired in v4.ts). Every path fails open: an error here sends the prompt as typed and never blocks a
// request. Several Claude Code processes share habits.json, so a save re-reads the file and adds this process's changes to it.
// The ideas come from the cache-keeper mod (MIT, github.com/nateherkai/claude-code-mods).
import type { EngineInterface } from 'claude-code'
import { v4CacheView, v4Learned, v4NoteCache, v4NotePing, v4Rate, v4ResetLearned, v4TaskRaw } from './v4.ts'
import { habitsLoad, habitsWrite, scanPass, scanStart } from './habitsio.ts'
import { ckConfig } from './lib/cachecfg.ts'
import { CHOICES, askText, choiceOf, quote, shouldAsk } from './lib/coldguard.ts'
import { EMPTY_HABITS, addPoints, decideActive, fadeLedger, noteKeepalive, optIn, raceCost, raceSave, type Habits } from './lib/habits.ts'
import { pointsOf, type Base } from './lib/model.ts'
import { learnedText } from './lib/insight.ts'
import { gate, stateOf } from './lib/keepgate.ts'
import { KEEP_OFF, TICK_MS, afterPing, armKeepWarm, clampHours, marginMs, pingActualUsd, pingCostUsd, rewriteUsd, startKeepWarm, tick, type KeepWarmState } from './lib/keepwarm.ts'
import { familyOf } from './lib/prices.ts'
import { ask, compact, fork, later, toast } from './lib/io.ts'

let kw: KeepWarmState = KEEP_OFF
let H: Habits = EMPTY_HABITS
// What this process changed since the last save. A save adds these to whatever is on disk, so two sessions never overwrite each other.
const zero = () => ({ pingUsd: 0, savedUsd: 0, n: 0, champNet: 0, chalNet: 0, champPings: 0, chalPings: 0 })
let delta = zero()
let scanned = false // this process rewrote the counts, so its copy of them wins on save
let optSet: boolean | null = null
let gen = 0 // bumped on each session start and end: a callback from an older chain does nothing
let busy = false
let ticking = false
let timer = false
let userOff = false
let lastActivityAt: number | null = null // when the last real request or ping went out: the cache lifetime counts from there
let savedAt = 0
// The live feed of the model: how the session has gone so far, and the chat as it stood when the last request ended.
let sessionStartAt: number | null = null
let prompts = 0
let turnOut = 0
let prevActed = false
let lastFeat: Base | null = null
let liveNew: number[][] = [] // points learned live since the last save
let skipped = ''
// One idle gap's ping bookkeeping: what the champion and the challenger would have sent, and what really went out.
interface Gap { champ: number; chal: number; real: number; realUsd: number }
let gap: Gap | null = null

async function clockNow($: EngineInterface): Promise<number> { try { return await $.clock.now() } catch { return Date.now() } }
const r4 = (n: number) => Math.round(n * 1e4) / 1e4

export function ckTurn(e: any, started: boolean) { if (e?.agentId === undefined) busy = started }

export async function ckInit($: EngineInterface) {
  gen += 1
  kw = KEEP_OFF; delta = zero(); scanned = false; optSet = null; busy = false; ticking = false; timer = false; userOff = false; lastActivityAt = null; gap = null; skipped = ''
  sessionStartAt = null; prompts = 0; turnOut = 0; prevActed = false; lastFeat = null; liveNew = []
  try {
    H = await habitsLoad($)
    if (!H.liveFrom) H = { ...H, liveFrom: await clockNow($) } // from here on, gaps are learned live and the scan leaves them alone
    void learn($, gen)
  } catch {}
}

// ckEnd stops this session's timers and saves what it learned.
export async function ckEnd($: EngineInterface) {
  gen += 1
  try { await save($) } catch {}
}

// save adds this process's changes to what is on disk and writes the result through a temporary file. The ledger and the race are
// sums, so they add. The counts are the scan's, so this process's copy wins only if it scanned.
async function save($: EngineInterface) {
  const D = await habitsLoad($)
  const now = await clockNow($)
  const led = fadeLedger(D.kw, now)
  const cc = decideActive({
    n: D.cc.n + delta.n, champNet: D.cc.champNet + delta.champNet, chalNet: D.cc.chalNet + delta.chalNet,
    champPings: D.cc.champPings + delta.champPings, chalPings: D.cc.chalPings + delta.chalPings, active: D.cc.active,
  })
  const base = scanned ? H : addPoints(D, liveNew) // a scan's copy already holds the live points; the file's does not
  const merged: Habits = { ...base, liveFrom: D.liveFrom || H.liveFrom, scan: H.scan || D.scan, kw: { pingUsd: led.pingUsd + delta.pingUsd, savedUsd: led.savedUsd + delta.savedUsd, optIn: optSet ?? D.kw.optIn, at: now }, cc }
  await habitsWrite($, merged)
  H = merged; delta = zero(); scanned = false; optSet = null; liveNew = []; savedAt = now
}
async function saveSoon($: EngineInterface, at: number) { if (at - savedAt > 60_000) await save($) }

// learn reads new transcript files a few at a time, then again every three hours, so a long session keeps learning. It runs only with
// the person's consent, and waits while a turn runs.
async function learn($: EngineInterface, g: number) {
  try {
    const c = ckConfig(v4CacheView().cfg)
    if (!(c.learnFromHistory || H.scan)) return
    let st = scanStart(H)
    const liveAtStart = liveNew.length
    const step = async () => {
      try {
        if (g !== gen) return
        if (busy) { later($, 10_000, step); return }
        st = await scanPass($, st, await clockNow($))
        if (!st.done) { later($, 2_000, step); return }
        H = addPoints({ ...st.h, kw: H.kw, cc: H.cc, scan: H.scan, liveFrom: H.liveFrom }, liveNew.slice(liveAtStart))
        scanned = true
        v4NoteCache({ kind: 'habits', at: await clockNow($), event: 'scan', files: st.files, failed: st.failed, listed: st.seen, sessions: H.sessions, err: st.err })
        await save($)
        later($, 3 * 3_600_000, () => { if (g === gen) void learn($, g) })
      } catch {}
    }
    await step()
  } catch {}
}

function ensureTimer($: EngineInterface) { if (!timer) { timer = true; schedule($, gen) } }
function schedule($: EngineInterface, g: number) {
  try {
    later($, TICK_MS, async () => {
      if (g !== gen) return
      await onTick($, g)
      if (g !== gen) return
      if (kw.on || ckConfig(v4CacheView().cfg).keepWarm !== 'off') schedule($, g); else timer = false
    })
  } catch { timer = false; kw = { ...kw, on: false, stopped: 'no timer in this engine' } }
}

// ckBefore and ckAfter bracket one main request. Before: the cache as it stands, and when the request went out. After: its usage,
// which settles the last idle gap: what its pings cost, and whether they kept the cache warm for the person's return.
export async function ckBefore($: EngineInterface, e: any) { return e?.agentId === undefined ? { view: v4CacheView(), at: await clockNow($) } : null }
export async function ckAfter($: EngineInterface, e: any, before: Awaited<ReturnType<typeof ckBefore>>, res: any) {
  try {
    if (!before || e?.agentId !== undefined || !res?.usage) return
    await settle($, before.at, before.view, Number(res.usage.cache_read_input_tokens ?? 0), Number(res.usage.cache_creation_input_tokens ?? 0))
    // This request is now the one before the next gap: remember the chat as it stands.
    const now = await clockNow($)
    sessionStartAt = sessionStartAt ?? before.at
    turnOut += Number(res.usage.output_tokens ?? 0)
    prevActed = res.stopReason === 'tool_use'
    lastFeat = { tokens: Number(res.usage.input_tokens ?? 0) + Number(res.usage.cache_read_input_tokens ?? 0) + Number(res.usage.cache_creation_input_tokens ?? 0), ageMin: (now - sessionStartAt) / 60_000, prompts, turnOut, asked: /\?\s*$/.test(String(res.answer ?? '').trim()) }
  } catch {}
}

async function settle($: EngineInterface, at: number, v: ReturnType<typeof v4CacheView>, cacheRead: number, cacheWrite: number) {
  const prevEnd = v.lastRequestAt
  lastActivityAt = at
  // The gap that just ended is a training point for the model, unless the request before it ran a tool (tool time, not the person).
  if (prevEnd !== null && lastFeat && !prevActed && H.liveFrom > 0 && at >= H.liveFrom && at - prevEnd >= 180_000) {
    const p = pointsOf(lastFeat, (at - prevEnd) / 60_000)
    H = addPoints(H, p); liveNew.push(...p)
  }
  if (gap && prevEnd !== null && v.model) {
    const g = gap
    gap = null
    const gapMs = at - prevEnd
    const rate = v4Rate(v.model), ttl = v.ttlMs
    const read = pingCostUsd(v.prefixTokens, rate), rw = rewriteUsd(v.prefixTokens, rate, ttl)
    const every = ttl - marginMs(ttl)
    const kept = (n: number) => (n > 0 && gapMs > ttl && n * every + ttl >= gapMs ? Math.max(0, rw - read) : 0)
    if (g.real > 0) {
      const warm = cacheWrite < 0.2 * Math.max(1, cacheRead + cacheWrite)
      const saved = gapMs > ttl && warm ? Math.max(0, rw - read) : 0
      H = noteKeepalive(H, g.realUsd, saved); delta.pingUsd += g.realUsd; delta.savedUsd += saved
      v4NoteCache({ kind: 'keepwarm', at, event: 'settle', gapMin: Math.round(gapMs / 60_000), pings: g.real, pingUsd: r4(g.realUsd), savedUsd: r4(saved), warm })
    }
    if (g.champ || g.chal) {
      const cs = kept(g.champ), hs = kept(g.chal)
      H = raceSave(H, cs, hs); delta.champNet += cs; delta.chalNet += hs
      v4NoteCache({ kind: 'keepwarm', at, event: 'race', gapMin: Math.round(gapMs / 60_000), champPings: g.champ, chalPings: g.chal, champSavedUsd: r4(cs), chalSavedUsd: r4(hs), active: H.cc.active })
    }
    await saveSoon($, at)
  }
  skipped = ''
  const c = ckConfig(v.cfg)
  if (v.active && !userOff && !kw.on && (c.keepWarm === 'auto' || (c.keepWarm === 'ask' && H.kw.optIn))) kw = armKeepWarm(kw, at, c.keepWarmHours)
  if (kw.on || c.keepWarm !== 'off') ensureTimer($)
}

// ckPromptSubmit asks before a person's prompt rewrites a big cold cache.
export async function ckPromptSubmit($: EngineInterface, e: any, next: any) {
  try {
    const v = v4CacheView()
    const c = ckConfig(v.cfg)
    const origin = e.origin?.kind
    const at = await clockNow($)
    if (e.turnId === undefined && (origin === 'composer' || origin === 'bridge' || origin === 'sdk')) { prompts += 1; turnOut = 0 } // a new prompt from the person
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
      H = optIn(H, true); optSet = true
      await save($)
      userOff = false
      try { toast($, 'AutoMode: it will keep big chats warm when that pays. /automode keepwarm off turns it off.') } catch {}
    }
    return next(e)
  } catch { return next(e) }
}

// learnedCommand serves `/automode learned [import|reset]`.
export async function learnedCommand($: EngineInterface, rest: string): Promise<string> {
  const c = ckConfig(v4CacheView().cfg)
  const arg = rest.trim().toLowerCase()
  if (arg === 'reset') {
    gen += 1; kw = KEEP_OFF; userOff = false; delta = zero(); scanned = false; optSet = null; gap = null
    H = EMPTY_HABITS
    await habitsWrite($, H)
    await v4ResetLearned($)
    return 'Everything AutoMode learned about your use is reset: idle-time counts, the keep-warm ledger and the route memory. Reading your history is off again until you run /automode learned import.'
  }
  if (arg === 'import') {
    H = { ...H, scan: true }; scanned = true
    await save($)
    void learn($, gen)
    return 'AutoMode will now read your own Claude Code transcripts (~/.claude/projects, every project) in the background, a few files at a time. It keeps counts only: request times, sizes, the model family, whether a request called a tool, and how many prompts you typed. It never stores or sends text. /automode learned shows the result, and /automode learned reset turns this off and clears it.'
  }
  const { learned, learning } = v4Learned()
  return learnedText({ habits: H, learned, now: await clockNow($), keepWarm: c.keepWarm, learning, consent: c.learnFromHistory || H.scan })
}

// keepWarmCommand serves `/automode keepwarm [hours|off|status]`.
export async function keepWarmCommand($: EngineInterface, rest: string): Promise<string> {
  const arg = rest.trim().toLowerCase()
  const v = v4CacheView()
  const led = H.kw
  const learned = `So far pings cost you $${led.pingUsd.toFixed(2)} and avoided $${led.savedUsd.toFixed(2)} of rewrites.`
  if (arg === 'off') { userOff = true; kw = { ...kw, on: false, stopped: 'turned off' }; H = optIn(H, false); optSet = false; await save($); return 'Keep warm is off, and it will not start by itself.' }
  if (arg === '' || arg === 'status') {
    if (!kw.on) return `Keep warm is off${kw.stopped ? ` (${kw.stopped})` : ''}. Turn it on with /automode keepwarm 2 (hours, up to 24). It sends a small ping before the cache expires and costs about $${(pingCostUsd(v.prefixTokens, v4Rate(v.model))).toFixed(2)} each at this context. ${learned}`
    return `Keep warm is on for ${Math.max(0, Math.round((kw.untilMs - (await clockNow($))) / 60_000))} more minutes: ${kw.pings} pings, $${kw.pingUsd.toFixed(2)} spent this session. ${learned}`
  }
  const hours = clampHours(Number(arg))
  if (!hours) return 'Use /automode keepwarm <hours> (up to 24), off, or status.'
  if (!v.active) return 'Keep warm needs AutoMode routing on for this session.'
  userOff = false
  kw = startKeepWarm(await clockNow($), hours, kw)
  ensureTimer($)
  return `Keep warm is on for ${hours} h. A ping goes out only while a cold start is dear and the work does not look finished. It stops at the time limit, at the session budget, when pings cost more than a rewrite, or if a ping fails.`
}

// onTick runs every 15 s while the timer lives: ping, wait or stop. The lock is taken before the first await, so two chains never ping together.
async function onTick($: EngineInterface, g: number) {
  if (ticking) return
  ticking = true
  try {
    const v = v4CacheView()
    if (!v.active) return
    const at = await clockNow($)
    if (g !== gen) return
    const rate = v4Rate(v.model)
    const real = kw.on
    // Without keep warm on, the same timing runs only to keep the race's books (below): nothing is sent.
    const probe: KeepWarmState = real ? kw : { ...KEEP_OFF, on: true, untilMs: at + 3_600_000 }
    const act = lastActivityAt ?? v.lastRequestAt
    const d = tick(probe, { mainRequests: v.mainRequests, now: at, lastActivityAt: act, ttlMs: v.ttlMs, busy, prefixTokens: v.prefixTokens, rate })
    if (d.action === 'wait') return
    if (d.action === 'stop') {
      if (!real) return
      kw = { ...kw, on: false, stopped: d.reason, halted: d.halt ? d.reason : kw.halted }
      v4NoteCache({ kind: 'keepwarm', at, event: 'stop', reason: d.reason, pings: kw.pings, pingUsd: r4(kw.pingUsd) })
      if (!/expired|time ran out/.test(d.reason)) { try { toast($, `AutoMode: keep warm stopped: ${d.reason}.`) } catch {} }
      return
    }
    const c = ckConfig(v.cfg)
    const gt = gate({ habits: H, state: stateOf(v4TaskRaw()), feat: { tokens: v.prefixTokens, idleMin: (at - (act ?? at)) / 60_000, ageMin: sessionStartAt === null ? 0 : (at - sessionStartAt) / 60_000, prompts, turnOut, asked: v.asked }, ttlMs: v.ttlMs, rate, minRewriteUsd: c.minRewriteUsd, sessionPingUsd: kw.pingUsd, budgetUsd: c.budgetUsd, capMin: c.keepWarmHours * 60, stale: v.stale })
    // The race's books: what each rule would send is booked at once at its cost, and its saving when the person returns.
    if (gt.champion.allow || gt.challenger.allow) {
      const read = pingCostUsd(v.prefixTokens, rate)
      const a = gt.champion.allow ? 1 : 0, b = gt.challenger.allow ? 1 : 0
      gap = gap ?? { champ: 0, chal: 0, real: 0, realUsd: 0 }
      H = raceCost(H, { champPings: a, chalPings: b, champUsd: a * read, chalUsd: b * read, newGap: gap.champ + gap.chal === 0 })
      delta.n += gap.champ + gap.chal === 0 ? 1 : 0; delta.champPings += a; delta.chalPings += b; delta.champNet -= a * read; delta.chalNet -= b * read
      gap.champ += a; gap.chal += b
    }
    if (!real) return
    if (!gt.use.allow) {
      const key = `${gt.use.why}|${act}`
      if (key !== skipped) { skipped = key; v4NoteCache({ kind: 'keepwarm', at, event: 'skip', why: gt.use.why, rule: gt.active, net: gt.use.net === null ? null : r4(gt.use.net) }) }
      return
    }
    let r: any = null
    try { r = await fork($, { prompt: 'AutoMode keep-alive ping. Reply with only: ok' }) } catch { r = null }
    if (g !== gen) return
    const u = r?.usage ? { cacheRead: Number(r.usage.cache_read_input_tokens ?? 0), cacheWrite: Number(r.usage.cache_creation_input_tokens ?? 0) } : null
    const usd = u ? pingActualUsd(u, rate, v.ttlMs) : 0
    kw = afterPing(kw, at, usd, u)
    lastActivityAt = at
    v4NotePing(at)
    gap = gap ?? { champ: 0, chal: 0, real: 0, realUsd: 0 }
    gap.real += 1; gap.realUsd += usd
    v4NoteCache({ kind: 'keepwarm', at, event: 'ping', cacheRead: u?.cacheRead ?? null, cacheWrite: u?.cacheWrite ?? null, usd: r4(usd), why: gt.use.why, rule: gt.active, stopped: kw.stopped })
    if (kw.stopped) { try { toast($, `AutoMode: keep warm stopped: ${kw.stopped}.`) } catch {} }
  } catch {} finally { ticking = false }
}
