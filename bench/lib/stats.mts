// Statistics for benchmark reports. Pure and seeded, so a report is reproducible. Repeats of one task share its
// difficulty, so every interval resamples tasks first and repeats within them, stratified by cohort.

// Seeded PRNG (mulberry32).
export function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const interval = (stats: number[]): [number | null, number | null] => {
  stats.sort((a, b) => a - b)
  return stats.length ? [stats[Math.floor(0.025 * stats.length)], stats[Math.floor(0.975 * stats.length)]] : [null, null]
}
const pick = <T,>(xs: T[], r: () => number) => xs[Math.floor(r() * xs.length)]

function strata<T>(rows: T[], taskOf: (row: T) => string, cohortOf: (row: T) => string) {
  const byCohort = new Map<string, Map<string, T[]>>()
  for (const row of rows) {
    const cohort = byCohort.get(cohortOf(row)) ?? new Map<string, T[]>()
    byCohort.set(cohortOf(row), cohort)
    cohort.set(taskOf(row), [...(cohort.get(taskOf(row)) ?? []), row])
  }
  return [...byCohort.values()].map((c) => [...c.values()])
}

export interface BootstrapOptions<T> { n?: number; seed?: number; cohortOf?: (row: T) => string }

export function bootstrapCI<T>(rows: T[], taskOf: (row: T) => string, stat: (sample: T[]) => number | null, { n = 2000, seed = 42, cohortOf = () => '' }: BootstrapOptions<T> = {}): [number | null, number | null] {
  if (!rows.length) return [null, null]
  const groups = strata(rows, taskOf, cohortOf)
  const r = rng(seed)
  const stats: number[] = []
  for (let i = 0; i < n; i++) {
    const sample = groups.flatMap((tasks) => tasks.flatMap(() => { const runs = pick(tasks, r); return runs.map(() => pick(runs, r)) }))
    const s = stat(sample)
    if (s !== null && Number.isFinite(s)) stats.push(s)
  }
  return interval(stats)
}

// pairedDelta compares arm B minus arm A on the tasks both ran. Each draw keeps a task's two arms together, which is
// what makes this a paired analysis. `value` turns one task's rows for one arm into a number.
export function pairedDelta<T>(a: T[], b: T[], taskOf: (row: T) => string, value: (rows: T[]) => number | null, { n = 2000, seed = 42, cohortOf = () => '' }: BootstrapOptions<T> = {}) {
  const shared = strata([...a, ...b], taskOf, cohortOf).map((tasks) => tasks.map((rows) => ({ a: rows.filter((x) => a.includes(x)), b: rows.filter((x) => b.includes(x)) })).filter((p) => p.a.length && p.b.length)).filter((t) => t.length)
  const tasks = shared.reduce((s, t) => s + t.length, 0)
  const diff = (pairs: { a: T[]; b: T[] }[]) => {
    const d = pairs.map((p) => { const x = value(p.a), y = value(p.b); return x === null || y === null ? null : y - x }).filter((v) => v !== null)
    return mean(d)
  }
  const r = rng(seed)
  const stats: number[] = []
  for (let i = 0; i < n; i++) {
    const s = diff(shared.flatMap((t) => t.map(() => pick(t, r))))
    if (s !== null && Number.isFinite(s)) stats.push(s)
  }
  return { tasks, delta: diff(shared.flat()), ci: interval(stats) }
}

// mcnemarExact is the two-sided exact test on the discordant task counts: b tasks only A solved, c tasks only B solved.
export function mcnemarExact(b: number, c: number) {
  const n = b + c
  if (!n) return 1
  let term = 2 ** -n, tail = term
  for (let k = 1; k <= Math.min(b, c); k++) { term *= (n - k + 1) / k; tail += term }
  return Math.min(1, 2 * tail)
}

// discordant reduces repeats to one verdict per task, by majority. A tie counts as not solved.
export function discordant<T>(a: T[], b: T[], taskOf: (row: T) => string, solved: (row: T) => boolean) {
  const verdicts = (rows: T[]) => {
    const m = new Map<string, boolean[]>()
    for (const r of rows) m.set(taskOf(r), [...(m.get(taskOf(r)) ?? []), solved(r)])
    return new Map([...m].map(([t, v]) => [t, v.filter(Boolean).length * 2 > v.length]))
  }
  const va = verdicts(a), vb = verdicts(b)
  let onlyA = 0, onlyB = 0
  for (const [t, x] of va) { if (!vb.has(t)) continue; if (x && !vb.get(t)) onlyA++; if (!x && vb.get(t)) onlyB++ }
  return { onlyA, onlyB }
}

// holm adjusts p values for testing several arms against one control. The result keeps the input order.
export function holm(ps: number[]) {
  const order = ps.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p)
  const out = new Array<number>(ps.length)
  let floor = 0
  order.forEach(({ p, i }, rank) => { floor = Math.max(floor, Math.min(1, p * (ps.length - rank))); out[i] = floor })
  return out
}

export interface Point { id: string; quality: number; cost: number }

// paretoFrontier keeps a point unless another is at least as good on both and strictly better on one.
export const paretoFrontier = (points: Point[]) =>
  points.filter((p) => !points.some((q) => q.quality >= p.quality && q.cost <= p.cost && (q.quality > p.quality || q.cost < p.cost)))

export interface ArmOutcome { arm: string; quality: number; cost: number; wall: number }

// routingRegret is the utility the hindsight-best arm got on one task, minus the routed arm's. It is relative to the
// arms that ran on that task, so it says nothing about arms left out of the study.
export function routingRegret(outcomes: ArmOutcome[], routed: string, lambdaCost: number, lambdaWall: number) {
  const u = (o: ArmOutcome) => o.quality - lambdaCost * o.cost - lambdaWall * o.wall
  const mine = outcomes.find((o) => o.arm === routed)
  if (!mine || outcomes.length < 2) return null
  return Math.max(...outcomes.map(u)) - u(mine)
}

// routeSummary gives the measures that need no chosen weights, over tasks where the routed arm and others ran.
export function routeSummary(tasks: ArmOutcome[][], routed: string) {
  const usable = tasks.filter((t) => t.length > 1 && t.some((o) => o.arm === routed))
  const excess: number[] = []
  let pareto = 0, failedButSolvable = 0, failed = 0, overspent = 0, solved = 0
  for (const t of usable) {
    const me = t.find((o) => o.arm === routed)
    if (paretoFrontier(t.map((o) => ({ id: o.arm, quality: o.quality, cost: o.cost }))).some((p) => p.id === routed)) pareto++
    const others = t.filter((o) => o.arm !== routed)
    const winners = t.filter((o) => o.quality > 0.5)
    if (me.quality <= 0.5) { failed++; if (others.some((o) => o.quality > 0.5)) failedButSolvable++ } else {
      solved++
      excess.push(me.cost - Math.min(...winners.map((o) => o.cost)))
      if (others.some((o) => o.quality > 0.5 && o.cost < me.cost)) overspent++
    }
  }
  const sorted = [...excess].sort((a, b) => a - b)
  return {
    tasks: usable.length, pareto_share: usable.length ? pareto / usable.length : null,
    median_excess_usd: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null,
    failures: failed, failures_another_arm_solved: failedButSolvable,
    solved, solved_where_cheaper_arm_also_solved: overspent,
  }
}
