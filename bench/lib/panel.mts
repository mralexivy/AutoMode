// A judge panel. Each judge grades alone, and blindly. The panel's score is the per-item median, so one odd judge
// cannot move it. Runs the judges disagree on go to a queue for a person. Deterministic tests stay the primary result.
import { DIMENSIONS, grade } from './grade-core.mts'

export interface Judge { id: string; call(prompt: string): Promise<{ reply: unknown; cost: number | null }> }

export const claudeJudge = (model: string, cwd: string): Judge => ({ id: model, call: (prompt) => grade(prompt, cwd, model) })

type Grade = Record<string, any>

// lowerMedian keeps a real score with an even panel, and leans to the stricter one.
const lowerMedian = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]

export function aggregate(grades: Record<string, Grade | null>) {
  const ok = Object.values(grades).filter((g): g is Grade => !!g)
  const reasons: string[] = []
  for (const [id, g] of Object.entries(grades)) if (!g) reasons.push(`no grade from ${id}`)
  if (!ok.length) return { grade: null, disputed: true, reasons }
  const merged: Grade = {}
  for (const k of DIMENSIONS) {
    const xs = ok.map((g) => g[k])
    merged[k] = lowerMedian(xs)
    if (Math.max(...xs) - Math.min(...xs) >= 2) reasons.push(`${k} differs by 2 or more`)
  }
  const verdicts = ok.map((g) => g.vs_reference)
  if (new Set(verdicts).size > 1) reasons.push('vs_reference differs')
  merged.vs_reference = [...new Set(verdicts)].sort((a, b) => verdicts.filter((v) => v === b).length - verdicts.filter((v) => v === a).length)[0]
  merged.defect_count = lowerMedian(ok.map((g) => g.defects?.length ?? 0))
  return { grade: merged, disputed: reasons.length > 0, reasons }
}

// countsOnly removes the defect lines. They are model reply text, and a result file must not store that.
export function countsOnly(g: Grade | null) {
  if (!g) return null
  const { defects, ...rest } = g
  return { ...rest, defect_count: defects?.length ?? 0 }
}
