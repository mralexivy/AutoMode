// Cache keeper wiring: the cold-send guard and the opt-in keepalive. It owns every `$` call and the module state;
// the decisions live in lib/coldguard.ts and lib/keepwarm.ts, and the measured lifetime in lib/ttl.ts (wired in v4.ts).
// Every path fails open: an error here sends the prompt as typed and never blocks a request.
// The ideas come from the cache-keeper mod (MIT, github.com/nateherkai/claude-code-mods).
import type { EngineInterface } from 'claude-code'
import { v4CacheView, v4NoteCache, v4Rate } from './v4.ts'
import { ckConfig } from './lib/cachecfg.ts'
import { CHOICES, askText, choiceOf, isCold, quote, shouldAsk } from './lib/coldguard.ts'
import { KEEP_OFF, TICK_MS, afterPing, clampHours, pingCostUsd, startKeepWarm, tick, type KeepWarmState } from './lib/keepwarm.ts'
import { ask, compact, fork, toast } from './lib/io.ts'

let kw: KeepWarmState = KEEP_OFF
let busy = false
let pinging = false
let timer = false
let lastActivityAt: number | null = null

async function clockNow($: EngineInterface): Promise<number> { try { return await $.clock.now() } catch { return Date.now() } }

// ckPinging: a keepalive ping is in flight. The request it makes is not a task, so the router skips it.
export const ckPinging = () => pinging
export const ckState = () => kw

export function ckReset() { kw = KEEP_OFF; busy = false; pinging = false; lastActivityAt = null }
export function ckTurn(e: any, started: boolean) { if (e?.agentId === undefined && !pinging) busy = started }
export function ckActivity(at: number) { lastActivityAt = at }

// ckPromptSubmit asks before a person's prompt rewrites a big cold cache.
export async function ckPromptSubmit($: EngineInterface, e: any, next: any) {
  try {
    const v = v4CacheView()
    const c = ckConfig(v.cfg)
    const origin = e.origin?.kind
    const at = await clockNow($)
    if (!v.active || !shouldAsk({ guard: c.guard, fromPerson: origin === 'composer' || origin === 'bridge', midTurn: e.turnId !== undefined, prefixTokens: v.prefixTokens, lastRequestAt: v.lastRequestAt, ttlMs: v.ttlMs, now: at, bigTokens: c.guardTokens })) return next(e)
    const q = quote(v.prefixTokens, at - (v.lastRequestAt ?? at), v.ttlMs, v4Rate(v.model))
    let answer: unknown
    try { answer = await ask($, `${askText(q, v.prefixTokens)} What should happen?`, [...CHOICES]) } catch {
      // No dialog (a print-mode run, a dismissed question): the prompt goes as typed, and the record says why.
      v4NoteCache({ kind: 'cold-guard', at, choice: 'unavailable', prefixTokens: v.prefixTokens, idleMin: q.idleMin, rewriteUsd: Math.round(q.rewriteUsd * 1e4) / 1e4 })
      return next(e)
    }
    const choice = choiceOf(answer)
    v4NoteCache({ kind: 'cold-guard', at, choice, prefixTokens: v.prefixTokens, idleMin: q.idleMin, rewriteUsd: Math.round(q.rewriteUsd * 1e4) / 1e4 })
    if (choice === 'cancel') { try { toast($, 'AutoMode: cancelled before a cold cache rewrite.') } catch {} ; return { drop: 'Cancelled by AutoMode before a cold cache rewrite' } }
    if (choice === 'compact') { try { await compact($) } catch {} }
    return next(e)
  } catch { return next(e) }
}

// keepWarmCommand serves `/automode keepwarm [hours|off]`.
export async function keepWarmCommand($: EngineInterface, rest: string): Promise<string> {
  const arg = rest.trim().toLowerCase()
  const v = v4CacheView()
  if (arg === 'off') { kw = { ...kw, on: false, stopped: 'turned off' }; return 'Keep warm is off.' }
  if (arg === '' || arg === 'status') {
    if (!kw.on) return `Keep warm is off${kw.stopped ? ` (${kw.stopped})` : ''}. Turn it on with /automode keepwarm 4 (hours, up to 24). It sends a small ping before the cache expires and costs about $${(pingCostUsd(v.prefixTokens, v4Rate(v.model))).toFixed(2)} each at this context.`
    return `Keep warm is on for ${Math.max(0, Math.round((kw.untilMs - (await clockNow($))) / 60_000))} more minutes: ${kw.pings} pings, $${kw.pingUsd.toFixed(2)} spent.`
  }
  const hours = clampHours(Number(arg))
  if (!hours) return 'Use /automode keepwarm <hours> (up to 24) or /automode keepwarm off.'
  if (!v.active) return 'Keep warm needs AutoMode routing on for this session.'
  kw = startKeepWarm(await clockNow($), hours)
  if (!timer) { timer = true; schedule($) }
  return `Keep warm is on for ${hours} h. Each ping reads the cached context and restarts its lifetime. It stops at the time limit, when pings cost more than a rewrite, or if a ping fails.`
}

// schedule re-arms one 30-second timer for as long as keep warm is on.
function schedule($: EngineInterface) {
  try { $.clock.after(TICK_MS, async () => { await onTick($); if (kw.on) schedule($); else timer = false }) } catch { timer = false; kw = { ...kw, on: false, stopped: 'no timer in this engine' } }
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
      v4NoteCache({ kind: 'keepwarm', at, event: 'stop', reason: d.reason, pings: kw.pings, pingUsd: Math.round(kw.pingUsd * 1e4) / 1e4 })
      try { toast($, `AutoMode: keep warm stopped: ${d.reason}.`) } catch {}
      return
    }
    pinging = true
    let r: any = null
    try { r = await fork($, { prompt: 'AutoMode keep-alive ping. Reply with only: ok' }) } catch { r = null } finally { pinging = false }
    const u = r?.usage ? { cacheRead: Number(r.usage.cache_read_input_tokens ?? 0), cacheWrite: Number(r.usage.cache_creation_input_tokens ?? 0) } : null
    const usd = pingCostUsd(u ? u.cacheRead + u.cacheWrite : v.prefixTokens, rate)
    kw = afterPing(kw, at, usd, u)
    lastActivityAt = at
    v4NoteCache({ kind: 'keepwarm', at, event: 'ping', cacheRead: u?.cacheRead ?? null, cacheWrite: u?.cacheWrite ?? null, usd: Math.round(usd * 1e4) / 1e4, stopped: kw.stopped })
    if (kw.stopped) { try { toast($, `AutoMode: keep warm stopped: ${kw.stopped}.`) } catch {} }
  } catch { pinging = false }
}

export { isCold }
