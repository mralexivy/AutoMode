// What AutoMode has learned about one person, as text for /automode learned. Pure: no `$`, no I/O.
// It says what rests on data and what does not: a number comes with how many observations stand behind it, and a comparison with
// an interval, or "no conclusion yet".
import { MIN_RACE, returnProb, type Habits } from './habits.ts'
import type { Feat } from './model.ts'
import { MIN_ARM, liftOf, opusBuckets, startReport, wilson, type Arm, type Learned } from './learn.ts'

const pct = (x: number) => `${Math.round(x * 100)}%`
const armText = (a: Arm) => { if (!a.n) return 'no tasks'; const [lo, hi] = wilson(a.bad, a.n); return `${a.bad} bad of ${a.n} (${pct(lo)} to ${pct(hi)}), $${a.usd.toFixed(2)}` }

export function learnedText(o: { habits: Habits; learned: Learned; now: number; keepWarm: string; learning: boolean; consent: boolean }): string {
  const { habits: h, learned: l, now } = o
  const lines = ['What AutoMode has learned from your own use. It stays on this machine and holds counts, never prompt or reply text.', '']
  if (!o.consent) lines.push('Reading your past sessions is off. Run /automode learned import to let AutoMode learn from them (counts only). Until then it learns only from sessions it watches live.')
  else if (!h.sessions) lines.push('Past sessions: none read yet. It reads them in the background after a session starts.')
  else lines.push(`Past sessions: counted from ${h.sessions} of yours (scripted runs are left out).`)
  const profiles: [string, Feat][] = [
    ['a small, young chat', { tokens: 30_000, idleMin: 30, ageMin: 20, prompts: 3, turnOut: 800, asked: false }],
    ['a medium chat an hour in', { tokens: 100_000, idleMin: 30, ageMin: 90, prompts: 12, turnOut: 3_000, asked: false }],
    ['a big chat, long session', { tokens: 250_000, idleMin: 30, ageMin: 240, prompts: 30, turnOut: 6_000, asked: false }],
    ['the same, after a question to you', { tokens: 250_000, idleMin: 30, ageMin: 240, prompts: 30, turnOut: 6_000, asked: true }],
  ]
  lines.push(`Return model, from ${h.pts.length} observed points. After 30 idle minutes, the chance you send another prompt within the hour:`)
  for (const [name, f] of profiles) lines.push(`  ${name}: ${pct(returnProb(h, f).p)}`)
  const ev = h.ev
  if (ev.n < 20) lines.push(`  Its report card needs 20 settled points (has ${Math.round(ev.n)}); until then the numbers above are mostly its starting guess.`)
  else {
    const m = ev.bModel / ev.n, pr = ev.bPrior / ev.n, c = ev.bConst / ev.n
    lines.push(`  Report card on your own gaps, each scored before it was learned (prediction error, lower is better): this model ${m.toFixed(3)}, its starting guess ${pr.toFixed(3)}, a flat base rate ${c.toFixed(3)}, over ${Math.round(ev.n)} points. ${m < Math.min(pr, c) * 0.97 ? 'It is predicting you better than either.' : 'It is not yet better than the starting guess.'}`)
  }
  const k = h.kw, cc = h.cc
  lines.push('', `Keep warm (${o.keepWarm}${k.optIn ? ', you said yes' : ''}): over recent weeks its pings cost $${k.pingUsd.toFixed(2)} and avoided $${k.savedUsd.toFixed(2)} of rewrites, as measured on your sessions.`)
  if (k.pingUsd >= 1 && k.savedUsd < 0.5 * k.pingUsd) lines.push('  Pings have not paid for you, so they stay off. The record fades over a month.')
  {
    lines.push(cc.n < MIN_RACE
      ? `The return model against the simple rule: the race has ${Math.round(cc.n)} of ${MIN_RACE} gaps it needs. The simple rule acts until then.`
      : `The return model against the simple rule, over ${Math.round(cc.n)} gaps: the model would have netted $${cc.chalNet.toFixed(2)} with ${Math.round(cc.chalPings)} pings, the simple rule $${cc.champNet.toFixed(2)} with ${Math.round(cc.champPings)}. ${cc.active === 'challenger' ? 'The model acts now.' : 'The simple rule acts.'}`)
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
  if (o.learning) {
    const rows = startReport(l, now).filter((r) => r.n >= 3)
    if (rows.length) {
      lines.push('', 'Model each task started on (this project, last 30 days). The router chose each start from the task, so these rows describe what happened and do not prove that one model is better:')
      for (const r of rows) {
        const checked = r.ok + r.bad
        const [lo, hi] = wilson(r.bad, checked)
        lines.push(`  ${r.tier} on ${r.family}: ${r.n} tasks, $${(r.usd / r.n).toFixed(2)} each; of ${checked} checked, ${r.bad} failed${checked ? ` (${pct(lo)} to ${pct(hi)})` : ''}; ${r.open} had no check.`)
      }
    }
  }
  lines.push('', 'Reset it all with /automode learned reset. Reading history is on only after /automode learned import or cacheKeeper.learnFromHistory; route memory is off with learning, in config.json.')
  return lines.join('\n')
}
