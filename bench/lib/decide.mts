// The offline decision: graded rows plus a policy fixed before any row give SHIP, DO_NOT_SHIP or INCONCLUSIVE, with
// every blocker named. Pure and deterministic (a seeded bootstrap). No model call, ever: reanalysis is free.
//
// Every row lands in one class, and no class is dropped from the denominators:
//   accepted          the run finished and the full hidden suite passed
//   product_failure   the run finished and the suite failed: a real result against the arm
//   infra_interrupted a usage limit, an UNKNOWN or a harness stop: no result, but its cost counts
//   harness_invalid   setup failed or the harness broke: no result; counts against the experiment, not the arm
//   grader_error      the accept command never returned: no verdict
//   fixture_invalid   the task failed its preflight: no slot should exist; listed so it cannot hide
export type RowClass = 'accepted' | 'product_failure' | 'infra_interrupted' | 'harness_invalid' | 'grader_error' | 'fixture_invalid'

export interface GradedRow { run_id: string; task_id: string; cohort?: string; arm: string; exit_reason?: string; accepted?: boolean | null; harness_error?: string; cost_usd_api_equiv?: number | null; fixture_invalid?: boolean }

export function rowClass(r: GradedRow): RowClass {
  if (r.fixture_invalid) return 'fixture_invalid'
  if (r.harness_error === 'accept command did not finish') return 'grader_error'
  if (r.harness_error || r.exit_reason === 'setup_error') return 'harness_invalid'
  if (r.exit_reason === 'quota' || r.exit_reason === 'unknown') return 'infra_interrupted'
  return r.accepted ? 'accepted' : 'product_failure'
}
export const valid = (c: RowClass) => c === 'accepted' || c === 'product_failure'

export interface Policy {
  id: string; treatment: string; control: string; min_valid_pairs: number; max_pass_loss: number; max_cost_ratio: number
  cost_ratio_ci_upper_for_ship: number; cost_ratio_ci_lower_for_no_ship: number; pass_loss_for_no_ship: number
  critical_cohorts: string[]; max_critical_regressions: number; max_invalid_share: number; bootstrap: { resamples: number; seed: number; level: number }
}

// A small seeded generator, so the same rows and policy always give the same interval.
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

export interface ArmStats { rows: number; paid_usd: number; accepted: number; valid: number; classes: Record<RowClass, number>; usd_per_accepted: number | null }
export interface Decision {
  policy: string; status: 'SHIP' | 'DO_NOT_SHIP' | 'INCONCLUSIVE'; blockers: string[]; notes: string[]
  pairs: number; treatment: ArmStats; control: ArmStats; pass_loss: number; discordant: { treatment_only: string[]; control_only: string[] }
  critical_regressions: string[]; cost_ratio: number | null; cost_ratio_ci: [number, number] | null; invalid_share: number; next: string | null
}

function stats(rows: GradedRow[]): ArmStats {
  const classes = { accepted: 0, product_failure: 0, infra_interrupted: 0, harness_invalid: 0, grader_error: 0, fixture_invalid: 0 } as Record<RowClass, number>
  for (const r of rows) classes[rowClass(r)]++
  const paid = rows.reduce((a, r) => a + (r.cost_usd_api_equiv ?? 0), 0)
  return { rows: rows.length, paid_usd: Math.round(paid * 1e4) / 1e4, accepted: classes.accepted, valid: classes.accepted + classes.product_failure, classes, usd_per_accepted: classes.accepted ? Math.round((paid / classes.accepted) * 1e4) / 1e4 : null }
}

// decide: rows may hold several attempts per task and arm (an interrupted one, then a finished one). Cost counts every
// attempt; the verdict per task and arm is its last valid row.
export function decide(rows: GradedRow[], p: Policy, next = 'repeat the discordant and high-variance tasks'): Decision {
  const arm = (a: string) => rows.filter((r) => r.arm === a)
  const t = stats(arm(p.treatment)), c = stats(arm(p.control))
  const verdict = (a: string) => { const m = new Map<string, GradedRow>(); for (const r of arm(a)) if (valid(rowClass(r))) m.set(r.task_id, r); return m }
  const vt = verdict(p.treatment), vc = verdict(p.control)
  const tasks = [...vt.keys()].filter((k) => vc.has(k)).sort()
  const costOf = (a: string, task: string) => arm(a).filter((r) => r.task_id === task).reduce((x, r) => x + (r.cost_usd_api_equiv ?? 0), 0)
  const tOnly = tasks.filter((k) => vt.get(k)!.accepted && !vc.get(k)!.accepted)
  const cOnly = tasks.filter((k) => !vt.get(k)!.accepted && vc.get(k)!.accepted)
  const passLoss = cOnly.length - tOnly.length
  const critical = cOnly.filter((k) => p.critical_cohorts.includes(String(vc.get(k)!.cohort ?? '')))
  // Cost per accepted over the paired tasks, and a paired bootstrap over tasks for its ratio.
  const ratioOf = (ks: string[]) => {
    const acc = (a: string, m: Map<string, GradedRow>) => ks.filter((k) => m.get(k)!.accepted).length
    const ta = acc(p.treatment, vt), ca = acc(p.control, vc)
    if (!ta || !ca) return null
    const tu = ks.reduce((x, k) => x + costOf(p.treatment, k), 0), cu = ks.reduce((x, k) => x + costOf(p.control, k), 0)
    return (tu / ta) / (cu / ca)
  }
  const ratio = tasks.length ? ratioOf(tasks) : null
  let ci: [number, number] | null = null
  if (tasks.length >= 2 && ratio !== null) {
    const r = rng(p.bootstrap.seed), xs: number[] = []
    for (let i = 0; i < p.bootstrap.resamples; i++) { const ks = tasks.map(() => tasks[Math.floor(r() * tasks.length)]); const v = ratioOf(ks); if (v !== null) xs.push(v) }
    xs.sort((a, b) => a - b)
    const lo = (1 - p.bootstrap.level) / 2
    ci = [xs[Math.floor(lo * (xs.length - 1))], xs[Math.ceil((1 - lo) * (xs.length - 1))]]
  }
  const all = [...arm(p.treatment), ...arm(p.control)]
  const invalidShare = all.length ? all.filter((r) => !valid(rowClass(r))).length / all.length : 0
  const blockers: string[] = [], notes: string[] = []
  if (tasks.length < p.min_valid_pairs) blockers.push(`only ${tasks.length} valid pairs; the policy needs ${p.min_valid_pairs}`)
  if (invalidShare > p.max_invalid_share) blockers.push(`${Math.round(invalidShare * 100)}% of rows are no result (over ${Math.round(p.max_invalid_share * 100)}%): the experiment, not the arm, is in doubt`)
  const noShip: string[] = []
  if (passLoss >= p.pass_loss_for_no_ship) noShip.push(`${p.treatment} lost ${passLoss} tasks net (no-ship at ${p.pass_loss_for_no_ship})`)
  if (critical.length > p.max_critical_regressions) noShip.push(`critical regressions: ${critical.join(', ')}`)
  if (ci && ci[0] > p.cost_ratio_ci_lower_for_no_ship) noShip.push(`cost per accepted is higher with confidence: ratio CI [${ci[0].toFixed(2)}, ${ci[1].toFixed(2)}]`)
  const ship = !blockers.length && !noShip.length && passLoss <= p.max_pass_loss && ratio !== null && ratio <= p.max_cost_ratio && !!ci && ci[1] <= p.cost_ratio_ci_upper_for_ship
  if (!ship && !noShip.length) {
    if (passLoss > p.max_pass_loss) blockers.push(`${p.treatment} lost ${passLoss} tasks net (ship allows ${p.max_pass_loss})`)
    if (ratio !== null && ratio > p.max_cost_ratio) blockers.push(`cost ratio ${ratio.toFixed(2)} is over ${p.max_cost_ratio}`)
    if (ci && ci[1] > p.cost_ratio_ci_upper_for_ship) blockers.push(`cost ratio CI upper ${ci[1].toFixed(2)} is over ${p.cost_ratio_ci_upper_for_ship}: too uncertain to ship`)
    if (ratio === null) blockers.push('no cost ratio: an arm has no accepted task')
  }
  notes.push(`${tasks.length} valid pairs: a release signal of limited precision, not a general claim`)
  const status = noShip.length ? 'DO_NOT_SHIP' : ship ? 'SHIP' : 'INCONCLUSIVE'
  return {
    policy: p.id, status, blockers: noShip.length ? noShip : blockers, notes, pairs: tasks.length, treatment: t, control: c, pass_loss: passLoss,
    discordant: { treatment_only: tOnly, control_only: cOnly }, critical_regressions: critical, cost_ratio: ratio === null ? null : Math.round(ratio * 1000) / 1000,
    cost_ratio_ci: ci ? [Math.round(ci[0] * 1000) / 1000, Math.round(ci[1] * 1000) / 1000] : null, invalid_share: Math.round(invalidShare * 1000) / 1000,
    next: status === 'INCONCLUSIVE' ? `${next}: ${[...tOnly, ...cOnly].join(', ') || 'none discordant; add repetitions of the costliest tasks'}` : null,
  }
}
