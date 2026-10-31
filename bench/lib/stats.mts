// Interval statistics for benchmark reports. Pure and seeded, so a report is reproducible.

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

// bootstrapCI gives a 95% interval that resamples tasks, not runs. Repeats of one task share its difficulty, so
// treating them as independent would give an interval that is too narrow. A drawn task brings all of its runs.
export function bootstrapCI<T>(rows: T[], taskOf: (row: T) => string, stat: (sample: T[]) => number | null, n = 2000, seed = 42): [number | null, number | null] {
  if (!rows.length) return [null, null]
  const groups = new Map<string, T[]>()
  for (const row of rows) groups.set(taskOf(row), [...(groups.get(taskOf(row)) ?? []), row])
  const tasks = [...groups.values()]
  const r = rng(seed)
  const stats: number[] = []
  for (let i = 0; i < n; i++) {
    const sample = Array.from({ length: tasks.length }, () => tasks[Math.floor(r() * tasks.length)]).flat()
    const s = stat(sample)
    if (s !== null && Number.isFinite(s)) stats.push(s)
  }
  stats.sort((a, b) => a - b)
  return stats.length ? [stats[Math.floor(0.025 * stats.length)], stats[Math.floor(0.975 * stats.length)]] : [null, null]
}
