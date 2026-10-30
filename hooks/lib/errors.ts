// Provider errors, classified. Claude Code names every API failure with one word (the `error` field of its
// StopFailure hook); the mod's turn.step result carries none (stopReason and usage are null). The command hook
// (an external signals writer) writes that word to the signals file, and the router maps it to one action here.
// Pure: no `$`. The principle: only a model that is really unavailable is skipped, and only for a bounded time.

export type ErrorAction =
  | { kind: 'ignore'; why: string }                                              // cancel, output limit: not the model's fault
  | { kind: 'notify'; why: string; toast: string }                              // credentials or billing: the person must act; no other model helps
  | { kind: 'breaker'; why: string; threshold: number; cooldownMs: number }      // count in a row, then skip this model for a while
  | { kind: 'effort-unsupported'; why: string }                                  // the request shape was refused after a rewrite
  | { kind: 'context'; why: string }                                             // the prompt does not fit: recovery, not a model switch

const CONTEXT = /context|too long|too many tokens|prompt is too|exceed/i
const CREDENTIALS = new Set(['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'cloud_credential_error'])

// Claude Code has no word for a timeout or a broken stream: those arrive as `server_error`, `unknown`, or no word at all,
// and are handled as such (a short cooldown, or the unclassified default).
// classifyError maps Claude Code's error word (and its short detail) to an action. An unknown word is treated like
// an unclassified failure: three in a row, five minutes.
export function classifyError(word: string | undefined, detail = ''): ErrorAction {
  const w = String(word ?? '').toLowerCase()
  if (w === 'cancel' || w === 'aborted') return { kind: 'ignore', why: 'the person interrupted' }
  if (w === 'max_output_tokens') return { kind: 'ignore', why: 'the answer hit its output limit' }
  if (CREDENTIALS.has(w)) return { kind: 'notify', why: w, toast: `AutoMode: the provider refused the request (${w.replace(/_/g, ' ')}). Another model will not help: fix the account or the credentials.` }
  if (w === 'invalid_request') return CONTEXT.test(detail) ? { kind: 'context', why: 'the prompt does not fit the context window' } : { kind: 'effort-unsupported', why: 'invalid request after a route rewrite' }
  if (w === 'model_not_found') return { kind: 'breaker', why: w, threshold: 1, cooldownMs: 30 * 60_000 }
  if (w === 'rate_limit' || w === 'overloaded' || w === 'server_error') return { kind: 'breaker', why: w, threshold: 3, cooldownMs: 2 * 60_000 }
  return { kind: 'breaker', why: w || 'unclassified', threshold: 3, cooldownMs: 5 * 60_000 }
}

// The action for a failure the engine gave no word for yet: counted like the unclassified default until a word arrives.
export const UNCLASSIFIED = classifyError(undefined)

// sanitizeDetail keeps a short, harmless slice of the error text for the record (letters, digits and a few marks).
export const sanitizeDetail = (s: unknown) => String(s ?? '').replace(/[^A-Za-z0-9 _.:/-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
