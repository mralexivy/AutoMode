// The return model: a small logistic model that says how likely a person is to send another prompt in the next hour, given a chat that has
// been idle for a while. Pure: no `$`, no I/O.
//
// Why a prior and a model, not a table. A study of one person's real use found three things. The event that matters (a big chat sits idle
// past the cache lifetime and then continues) happened about ten times in three weeks, so no table or model can be learned from a person's
// own events alone. The simple facts that predict a return are the same for everyone: a big context, a session that has run long, a turn that
// did a lot of work, an assistant that asked a question, and less idle time so far. And a model learned from scratch on a few dozen sessions
// scored worse than the prior alone, while the prior with a small, strongly held update scored best. So the model starts from a prior that
// encodes those facts and moves away from it only as fast as the person's own gaps justify (a ridge penalty toward the prior that eases as
// observations accumulate). Every settled gap is both a test of the current model and one more training point.
//
// The prior's signs and rough sizes follow the direction of the univariate results on that one person's data, so its accuracy on that
// person is flattered. It is a starting guess, and the race in lib/keepgate.ts decides whether it ever acts.
export interface Feat { tokens: number; idleMin: number; ageMin: number; prompts: number; turnOut: number; asked: boolean }
export type Base = Omit<Feat, 'idleMin'>

// Fixed scaling: nothing here depends on one person's data.
export const xOf = (f: Feat): number[] => [1, Math.log(Math.max(1, f.tokens) / 1e5), f.idleMin / 60, (Math.log1p(Math.max(0, f.ageMin)) - 4) / 2, (Math.log1p(Math.max(0, f.prompts)) - 2) / 1.5, (Math.log1p(Math.max(0, f.turnOut)) - 6) / 2, f.asked ? 1 : 0]
// bias, size, idle, session age, prompts so far, last-turn output, assistant asked a question
export const PRIOR = [-1.6, 0.6, -0.8, 0.3, 0.3, 0.3, 1.5]
export const LAMBDA = 20
export const CHECKS = [5, 10, 30, 52, 104] // the idle times at which a settled gap becomes a training point

const sig = (z: number) => 1 / (1 + Math.exp(-z))
export const prob = (w: number[], f: Feat) => { const x = xOf(f); return sig(x.reduce((a, v, i) => a + v * w[i], 0)) }

// A point is [y, x1..x6]: y is 1 when the person came back within 60 minutes of the checkpoint; the constant is dropped.
export const pointsOf = (b: Base, gapMin: number): number[][] => CHECKS.filter((t) => gapMin >= t).map((t) => [gapMin <= t + 60 ? 1 : 0, ...xOf({ ...b, idleMin: t }).slice(1)])

// fit: ridge logistic toward PRIOR. The penalty is a ridge of strength LAMBDA toward the prior, which counts as that many pseudo-observations:
// a handful of points move the model very little, and a few hundred let the person's own gaps decide.
export function fit(pts: number[][], lambda = LAMBDA): number[] {
  const w = PRIOR.slice()
  if (!pts.length) return w
  const den = pts.length + lambda
  for (let it = 0; it < 400; it++) {
    const gr = w.map(() => 0)
    for (const p of pts) { const e = sig(w[0] + p.slice(1).reduce((a, v, i) => a + v * w[i + 1], 0)) - p[0]; gr[0] += e; for (let i = 1; i < w.length; i++) gr[i] += e * p[i] }
    for (let i = 0; i < w.length; i++) w[i] -= 0.8 * ((gr[i] + lambda * (w[i] - PRIOR[i])) / den)
  }
  return w.map((v) => Math.round(v * 1e4) / 1e4)
}
export const probOfPoint = (w: number[], p: number[]) => sig(w[0] + p.slice(1).reduce((a, v, i) => a + v * w[i + 1], 0))
