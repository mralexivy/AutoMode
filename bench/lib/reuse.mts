// Dependency-aware reuse: may a finished row stand after a code change, or must it be paid for again? Pure.
//
// A row is the same execution only when every part of its identity matches (lib/identity.mts). One narrow exception
// is allowed, and it must be proven per row:
//   - the only changed behavior files are in LADDER_SCOPE, modules that act on a run only by escalating it
//     (an effort raise, a fork, a consult, a switch) and change nothing else the agent sees; and
//   - the row's own run recorded no ladder action; and
//   - replaying the row's transcript through the new code fires no ladder action either.
// Then the new code would have done exactly what the old code did on that run, and the row is "replay-equivalent".
// Any other change, an escalating row, a missing transcript or missing records means a paid rerun. failures.ts is
// out of the scope: it also rewrites check commands (withPipefail), which the agent sees.
export const LADDER_SCOPE = ['hooks/lib/rescue.ts', 'hooks/lib/handoff.ts', 'hooks/lib/bands.ts']

export interface ReuseInput {
  sameOtherwise: string[]         // identity parts other than code that differ (compareIdentity minus 'code')
  changed: string[]               // behavior files that differ between the row's code and the new code
  recordedEscalations: number | null // ladder actions in the row's plugin records; null when the records are gone
  replayedEscalations: number | null // ladder actions when its transcript replays through the new code; null if no transcript
}
export type ReuseDecision = { reuse: true; how: 'identical' | 'replay-equivalent'; why: string } | { reuse: false; why: string }

export function reuseDecision(i: ReuseInput): ReuseDecision {
  if (i.sameOtherwise.length) return { reuse: false, why: `identity differs in ${i.sameOtherwise.join(', ')}` }
  if (!i.changed.length) return { reuse: true, how: 'identical', why: 'same execution key' }
  const outside = i.changed.filter((f) => !LADDER_SCOPE.includes(f))
  if (outside.length) return { reuse: false, why: `changed outside the ladder scope: ${outside.join(', ')}` }
  if (i.recordedEscalations === null) return { reuse: false, why: 'the run\'s plugin records are gone: its ladder actions cannot be checked' }
  if (i.recordedEscalations > 0) return { reuse: false, why: `the run escalated ${i.recordedEscalations} time(s): the changed ladder code acted on it` }
  if (i.replayedEscalations === null) return { reuse: false, why: 'no transcript to replay' }
  if (i.replayedEscalations > 0) return { reuse: false, why: `the new code would escalate ${i.replayedEscalations} time(s) on this run` }
  return { reuse: true, how: 'replay-equivalent', why: `only ${i.changed.join(', ')} changed; no ladder action recorded or replayed` }
}
