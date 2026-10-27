// Effort mechanics. The effortless rules (HeyCubit, MIT License, https://github.com/HeyCubit/effortless)
// come from the verbatim port in effortless.ts: isFollowUp, endsOnQuestion and keepsEffort, redo detection
// with its stay-up window, and the medium floor for subagent effort. The mid-turn note below is the legacy
// policy's wording; policy `auto` uses upstream's withMidTurn.
// Differences from effortless, on purpose:
//   - Haiku 5.5 takes effort: Anthropic's effort docs (2026-10) list all five levels for Haiku,
//     Sonnet and Opus 5.5, and the A5/S3 transcripts show `output_config.effort: "low"` sent to Haiku.
//   - Effort is sent even when the app's request names none (`e.effort === undefined`), for 5.5 models.
//   - The provider rule decides whether an effort change keeps the cache (mode.ts), not the model name.
import type { Effort, Family, Owner } from './types.ts'
import { EFFORTS } from './types.ts'
import { endsOnQuestion as elEndsOnQuestion, isFollowUp } from './effortless.ts'

export const effortRank = (e: Effort) => EFFORTS.indexOf(e)
export const maxEffort = (a: Effort, b: Effort): Effort => (effortRank(a) >= effortRank(b) ? a : b)

// The upstream functions come from the verbatim port (effortless.ts); only the call shape differs here.
// isFollowUp, looksLikeRedo and REDO_STAY_PROMPTS are upstream's own. endsOnQuestion here takes the last reply,
// where upstream takes its context string ("user: ...\nassistant: ..."); it is upstream's check on that string.
export { isFollowUp, looksLikeRedo, REDO_STAY_PROMPTS } from './effortless.ts'
export const endsOnQuestion = (lastReply: string) => elEndsOnQuestion(`assistant: ${lastReply}`)

// keepsRoute: a follow-up that steers the running task keeps its route without a judge call (legacy policy).
export function keepsRoute(text: string, lastReply: string, followUpPattern: RegExp): boolean {
  const t = text.trim()
  return (isFollowUp(t) || followUpPattern.test(t)) && !endsOnQuestion(lastReply)
}

// effortless withMidTurn: a message typed while a turn runs usually steers it.
export function midTurnNote(effort: Effort): string {
  return `[Sent while the assistant was still working at ${effort} effort. If it adds to, corrects or steers that task, keep ${effort}; judge it on its own only if it is a separate new request.]`
}

// effortless helperFloor: a subagent's answer goes back unchecked, so it never runs below medium.
export const HELPER_FLOOR: Effort = 'medium'
export function helperEffort(turnEffort: Effort | undefined, appEffort: Effort | undefined): Effort {
  return maxEffort(turnEffort ?? appEffort ?? HELPER_FLOOR, HELPER_FLOOR)
}

// Models whose requests take an effort level. Older models without effort are left alone.
export const takesEffort = (model: string) => /(haiku|sonnet|opus)-5-5/.test(model)

export interface EffortInput {
  model: string               // the model this request goes to
  appEffort: Effort | number | undefined // what the app set (absent when it set none)
  routeEffort: Effort         // what the route chose
  owner: Owner
  effortShared: boolean       // effort changes keep the cache with this provider
  cacheEffort: Effort | null  // the effort the warm cache on this model was written at
  resetPending: boolean       // low-switch-penalty point: nothing warm to lose
  warm: boolean
  off?: string                // effort changes are off for this request (a refused rewrite, or a thinking mode that rejects them): why
}
export interface EffortChoice { sent: Effort | number | undefined; applied: boolean; why: string }

// effortFor decides the effort one request carries. The route's effort applies whenever the provider
// keeps the cache across efforts, at a low-switch-penalty point, or when quality or the person demands it.
// On Vertex, Bedrock and gateways a warm cache keeps its effort until then (the provider rule).
export function effortFor(i: EffortInput): EffortChoice {
  if (!takesEffort(i.model)) return { sent: i.appEffort, applied: false, why: 'model takes no effort' }
  if (i.off) return { sent: i.appEffort, applied: false, why: i.off }
  if (i.appEffort === i.routeEffort) return { sent: i.routeEffort, applied: true, why: 'app already at the route effort' }
  const must = i.owner === 'quality-escalation' || i.owner === 'user-override'
  if (i.effortShared || i.resetPending || !i.warm || i.cacheEffort === null || i.cacheEffort === i.routeEffort || must)
    return { sent: i.routeEffort, applied: true, why: i.effortShared ? 'effort shares the cache' : must ? `${i.owner} demands it` : 'no warm cache at another effort' }
  return { sent: i.cacheEffort, applied: false, why: 'provider splits the cache by effort: keep the warm effort until a low-penalty point' }
}

// thinkingOf reads the thinking share of output when the usage carries it (transcripts do; hook usage
// may not). It is indirect evidence of the effort the model actually used, never proof of it.
export function thinkingOf(usage: unknown): number | null {
  const d = (usage as { output_tokens_details?: { thinking_tokens?: unknown } } | null)?.output_tokens_details
  return typeof d?.thinking_tokens === 'number' ? d.thinking_tokens : null
}

export const familyEffortKey = (f: Family, e: Effort | number | undefined) => `${f}/${e ?? '-'}`
