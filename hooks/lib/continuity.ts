// Thinking continuity: whether a model reads the thinking its predecessor wrote. Pure: no `$`, no I/O.
//
// Contract: the answer comes from the model pair and the provider alone. The mod cannot see thinking. Messages carry
// role and text, and `input_transformations` needs a beta header Claude Code does not set. The table is the Anthropic
// preserved-thinking page for the 5.5 models:
//   - no model reads thinking from a stronger one, on any provider
//   - Opus reads Sonnet and Haiku, and Sonnet reads Haiku, on the Claude API and Google-managed Google Cloud only
// Elsewhere (Bedrock, Foundry, a gateway) those moves are assumed lost, because the page does not list them. A model
// outside the table is assumed lost too: the flag can hold a switch, and a hold costs less than lost reasoning.
// The API drops the blocks without an error and without a bill, and they stay in the history, so a return reads them
// again. A compaction ends all of this: thinking from before it is not carried forward, so the caller clears the flag.
import type { Family } from './types.ts'

export type Continuity = 'kept' | 'lost'

const MODEL = /(opus|sonnet|haiku)-5-5/i
export const STRENGTH: Record<Family, number> = { haiku: 0, sonnet: 1, opus: 2 }
const READS_WEAKER = ['anthropic', 'vertex']

export function continuity(from: string, to: string, provider: string): Continuity {
  if (from === to) return 'kept'
  const f = MODEL.exec(from)?.[1].toLowerCase() as Family | undefined
  const t = MODEL.exec(to)?.[1].toLowerCase() as Family | undefined
  if (!f || !t) return 'lost'
  if (f === t) return 'kept'
  return STRENGTH[t] > STRENGTH[f] && READS_WEAKER.includes(provider) ? 'kept' : 'lost'
}

// observedDrop reads what a prompt lost on arrival at a new model: the last prefix plus its output, minus the new
// prefix. New input in the same request counts against it, so this is a lower bound.
export function observedDrop(prefix: number, output: number, arrived: number): number {
  return Math.max(0, prefix + output - arrived)
}

// noteDrop keeps the tokens dropped since each family last ran. The family that ran starts over at zero.
export function noteDrop(dropped: Partial<Record<Family, number>>, ran: Family, tokens: number): Partial<Record<Family, number>> {
  const out: Partial<Record<Family, number>> = {}
  for (const f of ['haiku', 'sonnet', 'opus'] as Family[]) {
    const total = f === ran ? 0 : (dropped[f] ?? 0) + tokens
    if (total > 0) out[f] = total
  }
  return out
}

// addedSince is the turns a returning model's cache lacks. The running prefix can be shorter than the held one after a
// drop, so the gap between them hides new turns until the dropped tokens are added back.
export function addedSince(prefix: number, held: number, dropped = 0): number {
  return Math.max(0, prefix + dropped - held)
}
