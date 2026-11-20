// Cache keeper wiring: the cold-send guard. It owns every `$` call; the decisions live in lib/coldguard.ts, and the
// measured lifetime in lib/ttl.ts (wired in v4.ts). Every path fails open: an error here sends the prompt as typed.
// The ideas come from the cache-keeper mod (MIT, github.com/nateherkai/claude-code-mods).
import type { EngineInterface } from 'claude-code'
import { v4CacheView, v4NoteCache, v4Rate } from './v4.ts'
import { ckConfig } from './lib/cachecfg.ts'
import { CHOICES, askText, choiceOf, quote, shouldAsk } from './lib/coldguard.ts'
import { ask, compact, toast } from './lib/io.ts'

async function clockNow($: EngineInterface): Promise<number> { try { return await $.clock.now() } catch { return Date.now() } }

// ckPromptSubmit asks before a person's prompt rewrites a big cold cache.
export async function ckPromptSubmit($: EngineInterface, e: any, next: any) {
  try {
    const v = v4CacheView()
    const c = ckConfig(v.cfg)
    const origin = e.origin?.kind
    const at = await clockNow($)
    if (!v.active || !shouldAsk({ guard: c.guard, fromPerson: origin === 'composer' || origin === 'bridge', midTurn: e.turnId !== undefined, prefixTokens: v.prefixTokens, lastRequestAt: v.lastRequestAt, ttlMs: v.ttlMs, now: at, bigTokens: c.guardTokens })) return next(e)
    const q = quote(v.prefixTokens, at - (v.lastRequestAt ?? at), v.ttlMs, v4Rate(v.model))
    const rec = { kind: 'cold-guard', at, prefixTokens: v.prefixTokens, idleMin: q.idleMin, rewriteUsd: Math.round(q.rewriteUsd * 1e4) / 1e4 }
    let answer: unknown
    try { answer = await ask($, `${askText(q, v.prefixTokens)} What should happen?`, [...CHOICES]) } catch {
      // No dialog (a print-mode run, a dismissed question): the prompt goes as typed, and the record says why.
      v4NoteCache({ ...rec, choice: 'unavailable' })
      return next(e)
    }
    const choice = choiceOf(answer)
    v4NoteCache({ ...rec, choice })
    if (choice === 'cancel') { try { toast($, 'AutoMode: cancelled before a cold cache rewrite.') } catch {} ; return { drop: 'Cancelled by AutoMode before a cold cache rewrite' } }
    if (choice === 'compact') { try { await compact($) } catch {} }
    return next(e)
  } catch { return next(e) }
}
