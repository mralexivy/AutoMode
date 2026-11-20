#!/usr/bin/env node
// A leaderboard for the learning loop, at $0. Synthetic people with a hidden truth: for each kind of task (tier and complexity), whether a
// cheaper start does as well, and how often it really fails. Each learner plays the same stream of tasks, and is scored on what it costs
// against always following the shipped rules, how fast it finds what suits the person, and how often it adopts what does not.
//   engine      the experiment engine alone, every kind of task probed at the base share
//   ranked      the engine with the learning pass's focus set by a plain rule: the costliest kinds of task first
//   oracle      the engine with focus on exactly the kinds that suit the person (the best a proposer could do)
//   no-causes   the engine counting every failure against the cheaper start, even those caused by the environment
// Usage: node bench/learner-leaderboard.mts [--episodes 200] [--length 240] [--out FILE]
import fs from 'node:fs'
import { EMPTY_LEARNED, noteTask, type Learned } from '../hooks/lib/learn.ts'
import { assign, bucketOf, statusOf } from '../hooks/lib/experiment.ts'

const args = process.argv.slice(2)
const opt = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const EPISODES = Number(opt('--episodes', '200'))
const LENGTH = Number(opt('--length', '240'))

interface Kind { tier: 'T2' | 'T3'; cx: 'standard' | 'complex'; weight: number; hold: number; suits: boolean; probe: number; fail: number }
// hold: the shipped route's cost per task. probe: the cheaper start's cost per task. fail: how often it truly fails (a failure reruns on the hold).
const PERSONS: Record<string, { kinds: Kind[]; envNoise: number }> = {
  'everything suits': { envNoise: 0, kinds: [
    { tier: 'T2', cx: 'standard', weight: 3, hold: 0.25, suits: true, probe: 0.06, fail: 0.03 }, { tier: 'T2', cx: 'complex', weight: 2, hold: 0.4, suits: true, probe: 0.1, fail: 0.04 },
    { tier: 'T3', cx: 'standard', weight: 3, hold: 0.6, suits: true, probe: 0.15, fail: 0.04 }, { tier: 'T3', cx: 'complex', weight: 2, hold: 1.0, suits: true, probe: 0.3, fail: 0.05 } ] },
  'nothing suits': { envNoise: 0, kinds: [
    { tier: 'T2', cx: 'standard', weight: 3, hold: 0.25, suits: false, probe: 0.1, fail: 0.45 }, { tier: 'T2', cx: 'complex', weight: 2, hold: 0.4, suits: false, probe: 0.15, fail: 0.5 },
    { tier: 'T3', cx: 'standard', weight: 3, hold: 0.6, suits: false, probe: 0.2, fail: 0.4 }, { tier: 'T3', cx: 'complex', weight: 2, hold: 1.0, suits: false, probe: 0.3, fail: 0.55 } ] },
  'the simple half suits': { envNoise: 0, kinds: [
    { tier: 'T2', cx: 'standard', weight: 3, hold: 0.25, suits: true, probe: 0.06, fail: 0.03 }, { tier: 'T2', cx: 'complex', weight: 2, hold: 0.4, suits: false, probe: 0.15, fail: 0.45 },
    { tier: 'T3', cx: 'standard', weight: 3, hold: 0.6, suits: true, probe: 0.15, fail: 0.04 }, { tier: 'T3', cx: 'complex', weight: 2, hold: 1.0, suits: false, probe: 0.3, fail: 0.5 } ] },
  'suits, with a flaky environment': { envNoise: 0.35, kinds: [
    { tier: 'T2', cx: 'standard', weight: 3, hold: 0.25, suits: true, probe: 0.06, fail: 0.03 }, { tier: 'T2', cx: 'complex', weight: 2, hold: 0.4, suits: true, probe: 0.1, fail: 0.04 },
    { tier: 'T3', cx: 'standard', weight: 3, hold: 0.6, suits: true, probe: 0.15, fail: 0.04 }, { tier: 'T3', cx: 'complex', weight: 2, hold: 1.0, suits: true, probe: 0.3, fail: 0.05 } ] },
}
type Learner = 'engine' | 'ranked' | 'oracle' | 'no-causes'
const LEARNERS: Learner[] = ['engine', 'ranked', 'oracle', 'no-causes']

let seed = 11
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
const draw = (ks: Kind[]) => { let r = rnd() * ks.reduce((a, k) => a + k.weight, 0); for (const k of ks) { r -= k.weight; if (r <= 0) return k } return ks[ks.length - 1] }

function episode(person: { kinds: Kind[]; envNoise: number }, who: Learner) {
  let l: Learned = EMPTY_LEARNED
  for (const k of person.kinds) for (let i = 0; i < 8; i++) l = noteTask(l, { id: `w${k.tier}${k.cx}${i}`, bucket: `${k.tier}/sonnet`, family: 'sonnet', outcome: 'ok', at: i, usd: k.hold })
  const costRank = [...person.kinds].sort((a, b) => b.hold * b.weight - a.hold * a.weight)
  const focusSet = new Set<string>(who === 'oracle' ? person.kinds.filter((k) => k.suits).map((k) => bucketOf(k.tier, k.cx)) : who === 'ranked' ? costRank.slice(0, 3).map((k) => bucketOf(k.tier, k.cx)) : [])
  let cost = 0, hold = 0, wrongAdopt = 0, firstFound: Record<string, number> = {}
  for (let i = 0; i < LENGTH; i++) {
    const k = draw(person.kinds), B = bucketOf(k.tier, k.cx), at = 100 + i * 3_600_000
    const a = assign(l, 'haiku', B, `id${seed}-${i}`, at, true, focusSet.has(B))
    const probe = a?.arm === 'probe'
    const realFail = probe && rnd() < k.fail
    const envFail = probe && !realFail && rnd() < person.envNoise // the environment fails a task whatever the model did
    const failed = realFail || envFail
    const usd = probe ? (failed ? k.probe + k.hold : k.probe) : k.hold
    cost += usd; hold += k.hold
    if (a) l = noteTask(l, { id: `id${seed}-${i}`, bucket: `${k.tier}/sonnet`, family: probe ? 'haiku' : 'sonnet', outcome: failed ? 'bad' : 'ok', at, usd, esc: probe && failed, ...(who === 'no-causes' ? {} : envFail ? { cause: 'environment' as const } : realFail ? { cause: 'defect' as const } : {}), exp: { k: 'haiku', a: a.arm, b: B } })
    if (!(B in firstFound) && k.suits && statusOf(l, 'haiku', B, at).state === 'adopted') firstFound[B] = i
  }
  for (const k of person.kinds) if (!k.suits && statusOf(l, 'haiku', bucketOf(k.tier, k.cx), 100 + LENGTH * 3_600_000).state === 'adopted') wrongAdopt += 1
  const suited = person.kinds.filter((k) => k.suits).length
  return { cost, hold, found: Object.keys(firstFound).length / Math.max(1, suited), foundAt: Object.values(firstFound), wrongAdopt: wrongAdopt / Math.max(1, person.kinds.length - suited) }
}

const r2 = (x: number) => Math.round(x * 100) / 100
const med = (xs: number[]) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null)
const report: any[] = []
for (const [name, person] of Object.entries(PERSONS)) {
  const row: any = { person: name }
  for (const who of LEARNERS) {
    const eps = Array.from({ length: EPISODES }, () => episode(person, who))
    row[who] = { costVsShipped: r2(eps.reduce((a, e) => a + e.cost, 0) / eps.reduce((a, e) => a + e.hold, 0)), suitedFound: r2(eps.reduce((a, e) => a + e.found, 0) / EPISODES), medianFoundAtTask: med(eps.flatMap((e) => e.foundAt)), wrongAdopted: r2(eps.reduce((a, e) => a + e.wrongAdopt, 0) / EPISODES) }
  }
  report.push(row)
}
const out = { basis: 'synthetic people with a hidden truth; the real experiment engine; $0', episodes: EPISODES, length: LENGTH, report }
const o = opt('--out')
if (o) fs.writeFileSync(o, JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify(out, null, 2))
