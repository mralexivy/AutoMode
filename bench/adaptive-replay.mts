#!/usr/bin/env node
// Replay adaptive routing on the recorded benchmark outcomes. $0: it reads committed rows and runs no model.
// The benchmarks hold the same tasks run under different starts (rows under bench/results/*.jsonl: arm, task, cost, accepted by hidden tests).
// A simulated person works through a stream of tasks drawn from that pool. The mod starts with the shipped route for every task (the hold),
// and the real engine (hooks/lib/experiment.ts) tries a cheaper start on some of them, reads what really happened on that task under that
// start (its recorded cost and whether the hidden tests passed), and adopts or reverts. A failed probe pays for itself and then reruns on the
// shipped route, as the escalation ladder would. Compared with always following the shipped rules, always going cheaper, and an oracle that
// picks the better start for each task, over many random streams; and on tasks held out from the stream, to see whether what it learned
// carries over. Usage: node bench/adaptive-replay.mts [--episodes 300] [--length 150] [--out FILE]
import fs from 'node:fs'
import path from 'node:path'
import { EMPTY_LEARNED, noteTask, type Learned } from '../hooks/lib/learn.ts'
import { PROMISING_SHARE, assign, bucketOf, statusOf, type ExpKey } from '../hooks/lib/experiment.ts'

const args = process.argv.slice(2)
const opt = (k: string, d?: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const EPISODES = Number(opt('--episodes', '300'))
const LENGTH = Number(opt('--length', '150'))
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'results')

// task -> arm -> recorded runs
type Run = { cost: number; ok: boolean }
const rows = new Map<string, Map<string, Run[]>>()
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl') && !/events|grades|judge/.test(x))) {
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!line) continue
    let o: any
    try { o = JSON.parse(line) } catch { continue }
    if (!o.arm || !o.task_id || typeof o.accepted !== 'boolean') continue
    const t = rows.get(o.task_id) ?? new Map<string, Run[]>()
    const a = t.get(o.arm) ?? []
    a.push({ cost: o.cost_usd_api_equiv ?? 0, ok: o.accepted })
    t.set(o.arm, a)
    rows.set(o.task_id, t)
  }
}
const mean = (xs: Run[]) => xs.reduce((a, r) => a + r.cost, 0) / xs.length
const accepted = (xs: Run[]) => xs.filter((r) => r.ok).length / xs.length

interface Scenario { name: string; key: ExpKey; hold: string[]; probe: string; probeRerun: boolean; why: string }
// hold: the shipped start (first arm recorded for the task wins). probe: the cheaper start. probeRerun: a failed probe reruns on the hold,
// as the ladder does (for the arms that ran without a rescue).
const SCENARIOS: Scenario[] = [
  { name: 'Haiku start, with the shipped rescue (v6d)', key: 'haiku', hold: ['sonnet-high'], probe: 'v6d-opus', probeRerun: false, why: 'the probe is the recorded Haiku-first path with its own recovery; its cost already includes the rescue' },
  { name: 'Haiku alone, no rescue', key: 'haiku', hold: ['sonnet-high'], probe: 'haiku', probeRerun: true, why: 'a harsher test: plain Haiku, and a miss reruns on Sonnet high' },
  { name: 'Sonnet at medium instead of high', key: 'effort', hold: ['sonnet-high'], probe: 'sonnet-medium', probeRerun: true, why: 'the effort floor' },
]

interface Task { id: string; hold: Run[]; probe: Run[] }
function pool(s: Scenario): Task[] {
  const out: Task[] = []
  for (const [id, arms] of rows) {
    const hold = s.hold.map((a) => arms.get(a)).find((x) => x?.length)
    const probe = arms.get(s.probe)
    if (hold && probe) out.push({ id, hold, probe })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

let seed = 1
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
const pick = <T,>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]

interface Outcome { cost: number; failed: boolean }
function run(t: Task, arm: 'hold' | 'probe', s: Scenario): Outcome {
  const h = pick(t.hold)
  if (arm === 'hold') return { cost: h.cost, failed: !h.ok }
  const p = pick(t.probe)
  return p.ok || !s.probeRerun ? { cost: p.cost, failed: !p.ok } : { cost: p.cost + h.cost, failed: true } // a miss reruns on the shipped route
}

const WINDOW = 50
const B = bucketOf('T3', 'standard')
const DAY = 86_400_000
function episode(tasks: Task[], s: Scenario, length: number) {
  let l: Learned = EMPTY_LEARNED
  for (let i = 0; i < 8; i++) l = noteTask(l, { id: `w${i}`, bucket: 'T3/sonnet', family: 'sonnet', outcome: 'ok', at: i, usd: mean(pick(tasks).hold) }) // eight checked tasks of history
  let learned = 0, oracle = 0, hold = 0, probeAll = 0, fails = 0, failsHold = 0, adoptedAt = -1, probes = 0
  const win: { l: number; h: number; f: number }[] = Array.from({ length: Math.ceil(length / WINDOW) }, () => ({ l: 0, h: 0, f: 0 }))
  for (let i = 0; i < length; i++) {
    const t = pick(tasks)
    const at = 100 + i * 3_600_000
    const a = assign(l, s.key, B, `e${seed}-${i}`, at, true)
    const o = run(t, a?.arm ?? 'hold', s)
    learned += o.cost; fails += o.failed ? 1 : 0; probes += a?.arm === 'probe' ? 1 : 0
    const w = win[Math.floor(i / WINDOW)]; w.l += o.cost; w.f += o.failed ? 1 : 0; w.h += run(t, 'hold', s).cost
    // what the same task costs on each route, for the baselines
    const h = run(t, 'hold', s), p = run(t, 'probe', s)
    hold += h.cost; failsHold += h.failed ? 1 : 0; probeAll += p.cost; oracle += Math.min(h.cost, p.cost)
    if (a) l = noteTask(l, { id: `e${seed}-${i}`, bucket: 'T3/sonnet', family: a.arm === 'probe' ? 'haiku' : 'sonnet', outcome: o.failed ? 'bad' : 'ok', at, usd: o.cost, esc: a.arm === 'probe' && o.failed, exp: { k: s.key, a: a.arm, b: B } })
    if (adoptedAt < 0 && statusOf(l, s.key, B, at).state === 'adopted') adoptedAt = i
  }
  return { win, learned, hold, probeAll, oracle, fails, failsHold, adoptedAt, probes, state: statusOf(l, s.key, B, 100 + length * 3_600_000).state, l }
}

const q = (xs: number[], p: number) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] }
const r2 = (x: number) => Math.round(x * 100) / 100
const report: any[] = []
for (const s of SCENARIOS) {
  const tasks = pool(s)
  if (tasks.length < 6) continue
  const eps = Array.from({ length: EPISODES }, () => episode(tasks, s, LENGTH))
  const rel = eps.map((e) => e.learned / e.hold)
  const adopted = eps.filter((e) => e.adoptedAt >= 0)
  // held out: learn on half the tasks, then freeze what it learned and apply it to the other half
  const half = tasks.filter((_, i) => i % 2 === 0), rest = tasks.filter((_, i) => i % 2 === 1)
  const gen: number[] = [], genFail: number[] = [], genHold: number[] = []
  for (let k = 0; k < EPISODES; k++) {
    const e = episode(half, s, LENGTH)
    const st = e.state
    // the frozen rule: if adopted, the probe on every held-out task (a tenth on hold); otherwise the shipped start
    let c = 0, f = 0, ch = 0
    for (const t of rest) { const a = st === 'adopted' && rnd() >= 0.1 ? 'probe' : 'hold'; const o = run(t, a, s); c += o.cost; f += o.failed ? 1 : 0; ch += run(t, 'hold', s).cost }
    gen.push(c / ch); genFail.push(f / rest.length)
  }
  const failRate = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  report.push({
    scenario: s.name, note: s.why, tasksInPool: tasks.length, runsPerArm: { hold: r2(tasks.reduce((a, t) => a + t.hold.length, 0) / tasks.length), probe: r2(tasks.reduce((a, t) => a + t.probe.length, 0) / tasks.length) },
    recorded: { holdCostPerTask: r2(tasks.reduce((a, t) => a + mean(t.hold), 0) / tasks.length), probeCostPerTask: r2(tasks.reduce((a, t) => a + mean(t.probe), 0) / tasks.length), holdAccepted: r2(tasks.reduce((a, t) => a + accepted(t.hold), 0) / tasks.length), probeAccepted: r2(tasks.reduce((a, t) => a + accepted(t.probe), 0) / tasks.length) },
    streamLength: LENGTH, episodes: EPISODES,
    adoptedIn: { episodes: r2(adopted.length / EPISODES), medianTask: adopted.length ? q(adopted.map((e) => e.adoptedAt), 0.5) : null },
    finalState: Object.fromEntries(['collecting', 'adopted', 'reverted'].map((k) => [k, r2(eps.filter((e) => e.state === k).length / EPISODES)])),
    costVsShipped: { median: r2(q(rel, 0.5)), p10: r2(q(rel, 0.1)), p90: r2(q(rel, 0.9)) },
    costVsAlwaysCheaper: r2(eps.reduce((a, e) => a + e.learned, 0) / eps.reduce((a, e) => a + e.probeAll, 0)),
    costVsOracle: r2(eps.reduce((a, e) => a + e.learned, 0) / eps.reduce((a, e) => a + e.oracle, 0)),
    failuresPerTask: { learned: r2(eps.reduce((a, e) => a + e.fails, 0) / (EPISODES * LENGTH)), shipped: r2(eps.reduce((a, e) => a + e.failsHold, 0) / (EPISODES * LENGTH)) },
    probeShare: r2(eps.reduce((a, e) => a + e.probes, 0) / (EPISODES * LENGTH)),
    // The curve: cost against the shipped route, and failures per task, for each block of 50 tasks. It falls as the person's own tasks teach it.
    curve: eps[0].win.map((_, k) => ({ tasks: `${k * WINDOW + 1}-${Math.min(LENGTH, (k + 1) * WINDOW)}`, costVsShipped: r2(eps.reduce((a, e) => a + e.win[k].l, 0) / eps.reduce((a, e) => a + e.win[k].h, 0)), failuresPerTask: r2(eps.reduce((a, e) => a + e.win[k].f, 0) / (EPISODES * Math.min(WINDOW, LENGTH - k * WINDOW))) })),
    heldOut: { costVsShipped: r2(failRate(gen)), failuresPerTask: r2(failRate(genFail)) },
  })
}
const out = { basis: 'real recorded costs and hidden-test outcomes from the committed benchmark rows, resampled; a failed probe reruns on the shipped route; calculated, not billed', episodes: EPISODES, report }
const o = opt('--out')
if (o) fs.writeFileSync(o, JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify(out, null, 2))
export { PROMISING_SHARE }
