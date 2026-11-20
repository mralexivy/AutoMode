// What AutoMode has learned about one person, as text for /automode learned. Pure: no `$`, no I/O.
import { returnProb, type Habits } from './habits.ts'
import { liftOf, opusBuckets, type Learned } from './learn.ts'

const pct = (x: number) => `${Math.round(x * 100)}%`
const share = (c: { n: number; bad: number }) => (c.n ? `${pct(c.bad / c.n)} bad of ${c.n}` : 'no tasks yet')

export function learnedText(o: { habits: Habits; learned: Learned; now: number; keepWarm: string; learning: boolean; learnFromHistory: boolean }): string {
  const { habits: h, learned: l, now } = o
  const lines = ['What AutoMode has learned from your own use. It stays on this machine and holds counts, never prompt or reply text.', '']
  if (!o.learnFromHistory) lines.push('Reading your history is off (cacheKeeper.learnFromHistory in config.json), so nothing is learned about your idle time.')
  else if (!h.sessions) lines.push('No history read yet: it reads your past sessions in the background after a session starts.')
  else {
    lines.push(`Idle time: read ${h.sessions} of your sessions. After 10 idle minutes, the chance you send another prompt within the hour:`)
    for (const c of ['big', 'mid', 'small'] as const) {
      const r = returnProb(h, c, null, null, 10, 60)
      lines.push(`  ${c === 'big' ? 'chats over 150k tokens' : c === 'mid' ? 'chats of 60k to 150k' : 'chats under 60k'}: ${pct(r.p)} (from ${r.seen} observed)`)
    }
  }
  const k = h.kw
  lines.push('', `Keep warm (${o.keepWarm}${k.optIn ? ', you said yes' : ''}): its pings cost $${k.pingUsd.toFixed(2)} and avoided $${k.savedUsd.toFixed(2)} of rewrites, as measured on your sessions.`)
  if (k.pingUsd >= 1 && k.savedUsd < 0.5 * k.pingUsd) lines.push('  Pings have not paid for you, so they stay off until the numbers change.')
  lines.push('')
  if (!o.learning) lines.push('Route memory is off (learning in config.json).')
  else {
    const buckets = opusBuckets(l, now)
    lines.push(`Route memory: ${l.tasks.length} tasks in this project.${buckets.length ? ` Starts on Opus for: ${buckets.join(', ')}.` : ' No kind of task needs a stronger start yet.'}`)
    for (const x of liftOf(l, now)) lines.push(`  ${x.bucket}: started on Opus ${share(x.applied)}; the control group (one task in ten, memory ignored) ${share(x.control)}.`)
  }
  lines.push('', 'Reset it all with /automode learned reset. Turn reading history off with cacheKeeper.learnFromHistory, and route memory with learning, in config.json.')
  return lines.join('\n')
}
