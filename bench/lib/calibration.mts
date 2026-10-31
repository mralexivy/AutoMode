// Does a judge agree with people, and does confidence mean anything? Pure. All of these need the caller's own data.

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

// ranks gives tied values their average rank.
function ranks(xs: number[]) {
  const order = xs.map((x, i) => ({ x, i })).sort((a, b) => a.x - b.x)
  const out = new Array<number>(xs.length)
  for (let i = 0; i < order.length;) {
    let j = i
    while (j + 1 < order.length && order[j + 1].x === order[i].x) j++
    for (let k = i; k <= j; k++) out[order[k].i] = (i + j) / 2 + 1
    i = j + 1
  }
  return out
}

function pearson(a: number[], b: number[]) {
  const ma = mean(a), mb = mean(b)
  let cov = 0, va = 0, vb = 0
  for (let i = 0; i < a.length; i++) { cov += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2 }
  return va && vb ? cov / Math.sqrt(va * vb) : null
}

// spearman is null when either side has no variation, because a rank correlation says nothing then.
export const spearman = (a: number[], b: number[]) => (a.length < 2 ? null : pearson(ranks(a), ranks(b)))
export const exactAgreement = (a: number[], b: number[]) => mean(a.map((x, i) => (x === b[i] ? 1 : 0)))
export const withinOne = (a: number[], b: number[]) => mean(a.map((x, i) => (Math.abs(x - b[i]) <= 1 ? 1 : 0)))

export interface Forecast { p: number; correct: boolean }

export const brier = (fs: Forecast[]) => mean(fs.map((f) => (f.p - (f.correct ? 1 : 0)) ** 2))

export const nll = (fs: Forecast[], floor = 1e-6) => mean(fs.map((f) => -Math.log(Math.max(floor, f.correct ? f.p : 1 - f.p))))

// ece is expected calibration error over equal-width bins: the gap between confidence and hit rate, weighted by bin size.
export function ece(fs: Forecast[], bins = 10) {
  if (!fs.length) return null
  let total = 0
  for (let b = 0; b < bins; b++) {
    const inBin = fs.filter((f) => Math.min(bins - 1, Math.floor(f.p * bins)) === b)
    if (inBin.length) total += (inBin.length / fs.length) * Math.abs(mean(inBin.map((f) => f.p)) - mean(inBin.map((f) => (f.correct ? 1 : 0))))
  }
  return total
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

// effortDistance is how many levels the label sits from the nearest acceptable effort. 0 means acceptable.
export function effortDistance(effort: string, ok: string[]) {
  const i = EFFORTS.indexOf(effort)
  return i < 0 ? null : Math.min(...ok.map((o) => Math.abs(EFFORTS.indexOf(o) - i)))
}

// replicaForecast turns repeated labels for one case into a forecast. The modal label's frequency is the confidence, an
// empirical measure that does not trust a model saying how sure it is. One replica gives no information, so it is null.
export function replicaForecast(labels: string[], ok: string[]): Forecast | null {
  if (labels.length < 2) return null
  const counts = new Map<string, number>()
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1)
  const [top, n] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
  return { p: n / labels.length, correct: ok.includes(top) }
}
