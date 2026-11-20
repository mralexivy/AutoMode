// What AutoMode has learned about one person, as text for /automode learned. Pure: no `$`, no I/O.
// It says what rests on data and what does not: a number comes with how many observations stand behind it, and a comparison with
// an interval, or "no conclusion yet".
import { MIN_RACE, returnProb, type Habits } from './habits.ts'
import { MIN_ARM, liftOf, opusBuckets, wilson, type Arm, type Learned } from './learn.ts'

const pct = (x: number) => `${Math.round(x * 100)}%`
const armText = (a: Arm) => { if (!a.n) return 'no tasks'; const [lo, hi] = wilson(a.bad, a.n); return `${a.bad} bad of ${a.n} (${pct(lo)} to ${pct(hi)}), $${a.usd.toFixed(2)}` }

export function learnedText(o: { habits: Habits; learned: Learned; now: number; keepWarm: string; learning: boolean; consent: boolean }): string {
  const { habits: h, learned: l, now } = o
  const lines = ['What AutoMode has learned from your own use. It stays on this machine and holds counts, never prompt or reply text.', '']
  if (!o.consent) lines.push('Idle time: your history is not read. Run /automode learned import to let AutoMode count your idle gaps from your own transcripts. Until then keep warm follows the simple rule.')
  else if (!h.sessions) lines.push('Idle time: no history read yet. It reads your past sessions in the background after a session starts.')
  else {
    lines.push(`Idle time: counted from ${h.sessions} of your sessions (scripted runs are left out). After 10 idle minutes, the chance you send another prompt within the hour:`)
    for (const c of ['big', 'mid', 'small'] as const) {
      const r = returnProb(h, c, 10, 60)
      lines.push(`  ${c === 'big' ? 'chats over 150k tokens' : c === 'mid' ? 'chats of 60k to 150k' : 'chats under 60k'}: ${pct(r.p)}${r.seen < 100 ? ` (only ${r.seen} observed, so mostly a starting guess)` : ` (from ${r.seen} observed)`}`)
    }
  }
  const k = h.kw, cc = h.cc
  lines.push('', `Keep warm (${o.keepWarm}${k.optIn ? ', you said yes' : ''}): over recent weeks its pings cost $${k.pingUsd.toFixed(2)} and avoided $${k.savedUsd.toFixed(2)} of rewrites, as measured on your sessions.`)
  if (k.pingUsd >= 1 && k.savedUsd < 0.5 * k.pingUsd) lines.push('  Pings have not paid for you, so they stay off. The record fades over a month.')
  if (o.consent) {
    lines.push(cc.n < MIN_RACE
      ? `Your habits against the simple rule: the race has ${Math.round(cc.n)} of ${MIN_RACE} gaps it needs. The simple rule acts until then.`
      : `Your habits against the simple rule, over ${Math.round(cc.n)} gaps: the habits rule would have netted $${cc.chalNet.toFixed(2)} with ${Math.round(cc.chalPings)} pings, the simple rule $${cc.champNet.toFixed(2)} with ${Math.round(cc.champPings)}. ${cc.active === 'challenger' ? 'The habits rule acts now.' : 'The simple rule acts.'}`)
  }
  lines.push('')
  if (!o.learning) lines.push('Route memory is off (learning in config.json).')
  else {
    const buckets = opusBuckets(l, now)
    lines.push(`Route memory: ${l.tasks.length} tasks in this project.${buckets.length ? ` Starts on Opus for: ${buckets.join(', ')}.` : ' No kind of task needs a stronger start yet.'}`)
    for (const x of liftOf(l, now)) {
      lines.push(x.memory.n >= MIN_ARM && x.control.n >= MIN_ARM
        ? `  ${x.bucket}: followed the memory ${armText(x.memory)}; control (one task in ten, memory ignored) ${armText(x.control)}.`
        : `  ${x.bucket}: no conclusion yet (needs ${MIN_ARM} tasks in each arm; has ${x.memory.n} and ${x.control.n}).`)
    }
  }
  lines.push('', 'Reset it all with /automode learned reset. Reading history is on only after /automode learned import or cacheKeeper.learnFromHistory; route memory is off with learning, in config.json.')
  return lines.join('\n')
}
