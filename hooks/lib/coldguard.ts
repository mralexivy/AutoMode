// Cold-send guard. Pure: no `$`, no I/O.
// A prompt sent after the cache expired rewrites the whole context at 1.25x or 2x input. On a big chat that is dollars.
// The guard says when to ask, prices the rewrite, and prices the alternative of compacting first.
// The idea comes from the cache-keeper mod (MIT, github.com/nateherkai/claude-code-mods).
import { cacheWriteX, rateAt, type Rate } from './prices.ts'

export const GUARD_TOKENS = 150_000

export interface ColdInput {
  guard: boolean; fromPerson: boolean; midTurn: boolean
  prefixTokens: number; lastRequestAt: number | null; ttlMs: number; now: number; bigTokens: number
}

// isCold: the cache lifetime ran out since the last main request.
export const isCold = (lastRequestAt: number | null, ttlMs: number, now: number) => lastRequestAt !== null && now - lastRequestAt > ttlMs

// shouldAsk: ask only a person's own prompt, on a big context whose cache is gone.
export const shouldAsk = (i: ColdInput) => i.guard && i.fromPerson && !i.midTurn && i.prefixTokens >= i.bigTokens && isCold(i.lastRequestAt, i.ttlMs, i.now)

export interface ColdQuote { rewriteUsd: number; idleMin: number }

// quote prices the rewrite a send now pays. A compaction first is not priced as a saving: it sends the cold prefix
// once to summarise it, so it pays back only when the chat runs on for many more requests.
export function quote(prefixTokens: number, idleMs: number, ttlMs: number, rate: Rate): ColdQuote {
  // rateAt applies the long-context price (Haiku costs 5x above 100k tokens).
  return { rewriteUsd: (prefixTokens * rateAt(rate, prefixTokens).input * cacheWriteX(ttlMs)) / 1e6, idleMin: Math.round(idleMs / 60_000) }
}

export type ColdChoice = 'send' | 'compact' | 'cancel'
export const CHOICES = ['Send anyway', 'Compact first, then send', 'Cancel'] as const
export const choiceOf = (answer: unknown): ColdChoice => (answer === CHOICES[0] ? 'send' : answer === CHOICES[1] ? 'compact' : 'cancel')

export const askText = (q: ColdQuote, prefixTokens: number) =>
  `The cache went cold ${q.idleMin} min ago. Sending now rewrites about ${Math.round(prefixTokens / 1000)}k tokens of context, about $${q.rewriteUsd.toFixed(2)}.`
