// The outcome matrix: raw observations, task-by-arm cells, and three benchmark-health signals. Pure: no I/O.
//
// Contract:
//   - An observation is one graded run. It keeps its full experiment identity, and never any reply text.
//   - A cell groups the observations of one task and one arm that share an identity. Repeat is not part of it.
//   - Two identities for one task and arm are never pooled. They stay two cells, and the pair is a conflict.
//   - A task and arm that never ran is `missing`. Missing is never zero.
//   - Set-level numbers treat the task as the unit. Repeats never count as independent tasks.
//   - A false completion needs an explicit claim field. A row without one is N/A, never a success or a failure.
import crypto from 'node:crypto'
import { canonical } from './experiment.mts'
import { isResult } from './outcome.mts'
import { bootstrapCI, discordant, holm, mcnemarExact } from './stats.mts'

// The arm whose pass rate measures difficulty.
export const REFERENCE_ARM = 'sonnet-high'
// Two arms with the same verdict differ economically when one costs at least this many times the other per accepted run.
export const COST_RATIO = 1.5
// Below this share of comparable tasks with outcome discrimination, the report warns. A heuristic, not a release gate.
export const HEALTH_MIN_SHARE = 0.2
// The task every report names on all three signals.
export const FOCUS_TASK = 'longctx-sqlglot-intersect-precedence-across-dialects'

const hash = (v: unknown) => crypto.createHash('sha256').update(canonical(v)).digest('hex').slice(0, 12)

// A run that saw the user's auto-memory, the reference commit or the repository cache is contaminated.
export const tainted = (r: any) => r.memory_refs > 0 || r.leak_refs > 0

export interface Identity {
  model: string        // the requested model spec and the alias map
  policy: string       // the plugin kind and config, or `none`
  spec: string         // spec_hash: it covers the plugin code hash, the prompt template and the task's grading fields
  environment: string  // runner, platform and sandbox image
  grader: string       // the accept command and hidden test paths from the task file, or `unknown`
  harness: string      // the harness git SHA, marked when the tree was dirty
}

export interface Observation {
  run_id: string
  task_id: string
  cohort: string | null
  arm: string
  repeat: number
  identity: Identity
  key: string
  accepted: boolean
  cost_usd: number | null
  at: string | null
}

export interface TaskGrading { accept?: string; hidden_tests?: string[] | string }

// graderId hashes what decides a verdict. With no task file, the grader is unknown, not empty.
export const graderId = (task?: TaskGrading | null) =>
  task && task.accept != null ? hash({ accept: task.accept, hidden_tests: task.hidden_tests ?? null }) : 'unknown'

const evidenceOf = (r: any) => (r.evidence && typeof r.evidence === 'object' ? r.evidence : {})

export function identityOf(r: any, task?: TaskGrading | null): Identity {
  const h = r.harness ?? {}
  return {
    model: hash({ model: r.model ?? null, alias_map: r.alias_map ?? null }),
    policy: r.plugin ? `${r.plugin.kind ?? 'plugin'}:${hash(r.plugin)}` : 'none',
    spec: r.spec_hash ?? 'unknown',
    environment: [h.runner ?? 'unknown', h.platform ?? 'unknown', evidenceOf(r).sandbox_image ?? 'no-image'].join('|'),
    grader: graderId(task),
    harness: h.git_sha ? `${h.git_sha}${h.dirty ? '+dirty' : ''}` : 'unknown',
  }
}

export const identityKey = (id: Identity) => hash(id)

// runCost matches the report: the CLI cost plus the judge router's own calls. A run with no reported cost is unknown.
export const runCost = (r: any) => (typeof r.cost_usd_api_equiv === 'number' ? r.cost_usd_api_equiv + (r.judge?.usd || 0) : null)

// observe returns null for a row that is no result, is contaminated, or has no verdict yet.
export function observe(r: any, task?: TaskGrading | null): Observation | null {
  if (!r?.run_id || !r.task_id || !r.arm || !isResult(r) || tainted(r) || typeof r.accepted !== 'boolean') return null
  const identity = identityOf(r, task)
  return {
    run_id: r.run_id, task_id: r.task_id, cohort: r.cohort ?? null, arm: r.arm, repeat: r.repeat ?? 1,
    identity, key: identityKey(identity), accepted: r.accepted, cost_usd: runCost(r), at: r.at ?? null,
  }
}

// --- Clopper-Pearson ---------------------------------------------------------------------------------------------

const logFact = (() => { const t = [0]; return (n: number) => { for (let i = t.length; i <= n; i++) t[i] = t[i - 1] + Math.log(i); return t[n] } })()

// binomCdf is P(X <= x) for X ~ Binomial(n, p).
function binomCdf(x: number, n: number, p: number) {
  if (x < 0) return 0
  if (x >= n) return 1
  if (p <= 0) return 1
  if (p >= 1) return 0
  let s = 0
  for (let k = 0; k <= x; k++) s += Math.exp(logFact(n) - logFact(k) - logFact(n - k) + k * Math.log(p) + (n - k) * Math.log(1 - p))
  return Math.min(1, s)
}

// solve finds p in [0, 1] where f(p) crosses the target. f must fall as p grows.
function solve(f: (p: number) => number, target: number) {
  let lo = 0, hi = 1
  for (let i = 0; i < 200; i++) { const mid = (lo + hi) / 2; if (f(mid) > target) lo = mid; else hi = mid }
  return (lo + hi) / 2
}

// clopperPearson is the exact two-sided interval for x successes in n trials. It is null when n is zero.
export function clopperPearson(x: number, n: number, alpha = 0.05): [number, number] | null {
  if (!n) return null
  const lower = x === 0 ? 0 : solve((p) => -(1 - binomCdf(x - 1, n, p)), -alpha / 2)
  const upper = x === n ? 1 : solve((p) => binomCdf(x, n, p), alpha / 2)
  return [lower, upper]
}

// --- The matrix --------------------------------------------------------------------------------------------------

// majority follows stats.mts `discordant`: solved when more than half the repeats pass. A tie is not solved.
export const majority = (accepted: number, n: number) => accepted * 2 > n

export interface Cell {
  task_id: string
  arm: string
  key: string
  identity: Identity
  n: number
  accepted: number
  rate: number
  ci: [number, number]
  verdict: boolean
  repeats: number[]
  cost_per_accepted: number | null // null with no accepted run, or when any run has no known cost
  latest: string | null
  observations: Observation[]
}

export type CellStatus = 'ok' | 'conflict' | 'missing'
export interface Entry { task_id: string; arm: string; status: CellStatus; cells: Cell[]; primary: Cell | null }
export interface Matrix { tasks: string[]; arms: string[]; entries: Entry[]; observations: Observation[] }

function cellOf(obs: Observation[]): Cell {
  const n = obs.length, accepted = obs.filter((o) => o.accepted).length
  const costs = obs.map((o) => o.cost_usd)
  const known = costs.every((c) => c !== null)
  return {
    task_id: obs[0].task_id, arm: obs[0].arm, key: obs[0].key, identity: obs[0].identity, n, accepted, rate: accepted / n,
    ci: clopperPearson(accepted, n), verdict: majority(accepted, n), repeats: obs.map((o) => o.repeat).sort((a, b) => a - b),
    cost_per_accepted: known && accepted ? costs.reduce((a, c) => a + c, 0) / accepted : null,
    latest: obs.map((o) => o.at).filter(Boolean).sort().pop() ?? null, observations: obs,
  }
}

// buildMatrix groups observations into cells over every task and arm named. A conflict keeps all its cells, and the
// signals read its primary cell: the one with the most observations, then the latest.
export function buildMatrix(observations: Observation[], { tasks, arms }: { tasks?: string[]; arms?: string[] } = {}): Matrix {
  const taskIds = tasks ?? [...new Set(observations.map((o) => o.task_id))].sort()
  const armIds = arms ?? [...new Set(observations.map((o) => o.arm))].sort()
  const groups = new Map<string, Map<string, Observation[]>>()
  for (const o of observations) {
    const k = `${o.task_id}\u0000${o.arm}`
    const byKey = groups.get(k) ?? new Map<string, Observation[]>()
    groups.set(k, byKey)
    byKey.set(o.key, [...(byKey.get(o.key) ?? []), o])
  }
  const entries: Entry[] = []
  for (const t of taskIds) for (const a of armIds) {
    const cells = [...(groups.get(`${t}\u0000${a}`)?.values() ?? [])].map(cellOf)
      .sort((x, y) => y.n - x.n || String(y.latest).localeCompare(String(x.latest)))
    entries.push({ task_id: t, arm: a, status: !cells.length ? 'missing' : cells.length > 1 ? 'conflict' : 'ok', cells, primary: cells[0] ?? null })
  }
  return { tasks: taskIds, arms: armIds, entries, observations }
}

// --- Signals -----------------------------------------------------------------------------------------------------

export interface TaskSignals {
  task_id: string
  arms_run: string[]
  difficulty: { arm: string; n: number; accepted: number; rate: number; ci: [number, number] } | null
  outcome: { discriminates: boolean | null; solved_by: string[]; failed_by: string[] }
  economic: { discriminates: boolean | null; pairs: { cheaper: string; dearer: string; ratio: number; verdict: boolean }[] }
}

export interface SignalOptions { reference?: string; costRatio?: number }

export function taskSignals(m: Matrix, task: string, { reference = REFERENCE_ARM, costRatio = COST_RATIO }: SignalOptions = {}): TaskSignals {
  const run = m.entries.filter((e) => e.task_id === task && e.primary).map((e) => e.primary)
  const ref = run.find((c) => c.arm === reference)
  const comparable = run.length >= 2
  const pairs: TaskSignals['economic']['pairs'] = []
  for (let i = 0; i < run.length; i++) for (let j = i + 1; j < run.length; j++) {
    const [x, y] = [run[i], run[j]]
    if (x.verdict !== y.verdict || !x.cost_per_accepted || !y.cost_per_accepted) continue
    const [cheaper, dearer] = x.cost_per_accepted <= y.cost_per_accepted ? [x, y] : [y, x]
    pairs.push({ cheaper: cheaper.arm, dearer: dearer.arm, ratio: dearer.cost_per_accepted / cheaper.cost_per_accepted, verdict: x.verdict })
  }
  return {
    task_id: task, arms_run: run.map((c) => c.arm),
    difficulty: ref ? { arm: reference, n: ref.n, accepted: ref.accepted, rate: ref.rate, ci: ref.ci } : null,
    outcome: {
      discriminates: comparable ? new Set(run.map((c) => c.verdict)).size > 1 : null,
      solved_by: run.filter((c) => c.verdict).map((c) => c.arm), failed_by: run.filter((c) => !c.verdict).map((c) => c.arm),
    },
    economic: { discriminates: pairs.length ? pairs.some((p) => p.ratio >= costRatio) : null, pairs },
  }
}

export interface SetSignals {
  reference: string
  cost_ratio: number
  difficulty: { tasks: number; mean_rate: number | null; ci: [number | null, number | null]; failed_tasks: number }
  outcome: { comparable_tasks: number; single_arm_tasks: number; discriminating: number; share: number | null }
  pairs: { a: string; b: string; tasks: number; only_a: number; only_b: number; p_holm: number }[]
  economic: { eligible_tasks: number; discriminating: number; share: number | null }
  warning: string | null // a heuristic, not a release gate
}

export function setSignals(m: Matrix, perTask: TaskSignals[], { reference = REFERENCE_ARM, costRatio = COST_RATIO }: SignalOptions = {}): SetSignals {
  const primaries = m.entries.filter((e) => e.primary).map((e) => e.primary)
  const refObs = primaries.filter((c) => c.arm === reference).flatMap((c) => c.observations)
  // Each task weighs the same, so a task with more repeats does not count for more.
  const taskMean = (obs: Observation[]) => {
    const by = new Map<string, boolean[]>()
    for (const o of obs) by.set(o.task_id, [...(by.get(o.task_id) ?? []), o.accepted])
    const rates = [...by.values()].map((v) => v.filter(Boolean).length / v.length)
    return rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null
  }
  const refTasks = perTask.filter((t) => t.difficulty)
  const comparable = perTask.filter((t) => t.outcome.discriminates !== null)
  const disc = comparable.filter((t) => t.outcome.discriminates).length
  const eligible = perTask.filter((t) => t.economic.discriminates !== null)
  const share = comparable.length ? disc / comparable.length : null

  const raw = []
  for (let i = 0; i < m.arms.length; i++) for (let j = i + 1; j < m.arms.length; j++) {
    const [a, b] = [m.arms[i], m.arms[j]]
    const obsOf = (arm: string) => primaries.filter((c) => c.arm === arm).flatMap((c) => c.observations)
    const oa = obsOf(a), ob = obsOf(b)
    const shared = new Set(oa.map((o) => o.task_id).filter((t) => ob.some((o) => o.task_id === t)))
    if (!shared.size) continue
    const d = discordant(oa, ob, (o) => o.task_id, (o) => o.accepted)
    raw.push({ a, b, tasks: shared.size, only_a: d.onlyA, only_b: d.onlyB, p: mcnemarExact(d.onlyA, d.onlyB) })
  }
  const adjusted = holm(raw.map((r) => r.p))
  const pairs = raw.map(({ p, ...r }, i) => ({ ...r, p_holm: adjusted[i] }))

  const warning = share === null
    ? 'No task ran on two or more arms, so outcome discrimination cannot be measured.'
    : share < HEALTH_MIN_SHARE
      ? `Only ${disc} of ${comparable.length} comparable tasks (${(100 * share).toFixed(0)}%) separate the arms on outcome, below ${(100 * HEALTH_MIN_SHARE).toFixed(0)}%. The set may be too easy or too hard to rank arms.`
      : null
  return {
    reference, cost_ratio: costRatio,
    difficulty: { tasks: refTasks.length, mean_rate: taskMean(refObs), ci: bootstrapCI(refObs, (o) => o.task_id, taskMean), failed_tasks: refTasks.filter((t) => !majority(t.difficulty.accepted, t.difficulty.n)).length },
    outcome: { comparable_tasks: comparable.length, single_arm_tasks: perTask.filter((t) => t.arms_run.length === 1).length, discriminating: disc, share },
    pairs,
    economic: { eligible_tasks: eligible.length, discriminating: eligible.filter((t) => t.economic.discriminates).length, share: eligible.length ? eligible.filter((t) => t.economic.discriminates).length / eligible.length : null },
    warning,
  }
}

// --- False completion --------------------------------------------------------------------------------------------

// The claim field. bench/lib/run-one.mts sets it from the final message's status line when the prompt template asks for
// one (repo-change-v2, bench/lib/claim.mts). A row must carry `completion.claimed` as a boolean to count. Rows from a
// template that never asked count as no field; a row whose agent gave no status line counts as ambiguous.
export const CLAIM_FIELD = 'completion.claimed'

export interface FalseCompletion { rows: number; claims_graded: number; false_claims: number; rate: number | null; no_claim: number; na_no_field: number; na_ambiguous: number; na_ungraded: number; gate_verified: number; gate_verified_failed: number }

export function falseCompletion(rows: any[]): FalseCompletion {
  const out: FalseCompletion = { rows: rows.length, claims_graded: 0, false_claims: 0, rate: null, no_claim: 0, na_no_field: 0, na_ambiguous: 0, na_ungraded: 0, gate_verified: 0, gate_verified_failed: 0 }
  for (const r of rows) {
    // The completion gate's own verdict, apart from the claim: how often "verified" meets failing hidden tests.
    if (r?.completion?.gate_state === 'verified' && isResult(r) && !tainted(r) && typeof r.accepted === 'boolean') { out.gate_verified++; if (!r.accepted) out.gate_verified_failed++ }
    if (!r || typeof r !== 'object' || !('completion' in r) || r.completion == null || r.completion.claim_asked === false) { out.na_no_field++; continue }
    const claimed = r.completion.claimed
    if (typeof claimed !== 'boolean') { out.na_ambiguous++; continue }
    if (!claimed) { out.no_claim++; continue }
    if (!isResult(r) || tainted(r) || typeof r.accepted !== 'boolean') { out.na_ungraded++; continue }
    out.claims_graded++
    if (!r.accepted) out.false_claims++
  }
  out.rate = out.claims_graded ? out.false_claims / out.claims_graded : null
  return out
}

// --- Assembly and rendering --------------------------------------------------------------------------------------

export interface OutcomeReport { matrix: Matrix; perTask: TaskSignals[]; set: SetSignals; falseCompletion: FalseCompletion; focus: TaskSignals | null; dropped: number }

export interface OutcomeInput extends SignalOptions { rows: any[]; tasks?: Record<string, TaskGrading>; arms?: string[]; focus?: string }

export function outcomeReport({ rows, tasks = {}, arms, focus = FOCUS_TASK, ...opts }: OutcomeInput): OutcomeReport {
  const observations = rows.map((r) => observe(r, tasks[r?.task_id])).filter((o) => o !== null)
  const matrix = buildMatrix(observations, { arms })
  const perTask = matrix.tasks.map((t) => taskSignals(matrix, t, opts))
  return {
    matrix, perTask, set: setSignals(matrix, perTask, opts), falseCompletion: falseCompletion(rows),
    focus: perTask.find((t) => t.task_id === focus) ?? null, dropped: rows.length - observations.length,
  }
}

const cellJson = ({ observations, ...c }: Cell) => ({ ...c, run_ids: observations.map((o) => o.run_id) })

// outcomeJson is the matrix file. It holds ids, hashes, verdicts and costs, and never reply text.
export function outcomeJson(r: OutcomeReport) {
  return {
    version: 1, reference: r.set.reference, cost_ratio: r.set.cost_ratio, health_min_share: HEALTH_MIN_SHARE, warning_kind: 'heuristic, not a release gate', claim_field: CLAIM_FIELD,
    observations: r.matrix.observations,
    entries: r.matrix.entries.map((e) => ({ task_id: e.task_id, arm: e.arm, status: e.status, primary: e.primary?.key ?? null, cells: e.cells.map(cellJson) })),
    tasks: r.perTask, set: r.set, false_completion: r.falseCompletion,
  }
}

const pct = (x: number | null) => (x === null ? 'n/a' : `${(100 * x).toFixed(0)}%`)
const range = (c: [number | null, number | null] | null) => (!c || c[0] === null ? '' : ` [${pct(c[0])}–${pct(c[1])}]`)
const yesNo = (x: boolean | null) => (x === null ? 'n/a' : x ? 'yes' : 'no')

export function renderOutcomes(r: OutcomeReport, focusId = FOCUS_TASK): string[] {
  const { matrix: m, set: s, falseCompletion: f } = r
  const count = (st: CellStatus) => m.entries.filter((e) => e.status === st).length
  const out: string[] = []
  out.push('\n### Outcome matrix\n')
  out.push('A cell is one task and one arm under one experiment identity: model, policy, spec hash, environment, grader and harness SHA. Repeats share a cell. Two identities are never pooled: they are a conflict, and the signals read the larger cell. A cell that never ran is missing, not zero. Intervals here are exact Clopper-Pearson 95% intervals over one cell\'s repeats.\n')
  out.push(`- Observations: ${m.observations.length} graded runs. Rows left out (no result, contaminated or ungraded): ${r.dropped}.`)
  out.push(`- Cells: ${m.tasks.length} tasks × ${m.arms.length} arms = ${m.entries.length}. Run: ${count('ok')}. Conflicts: ${count('conflict')}. Missing: ${count('missing')}.`)
  for (const e of m.entries.filter((x) => x.status === 'conflict')) {
    const differs = (Object.keys(e.cells[0].identity) as (keyof Identity)[]).filter((k) => e.cells.some((c) => c.identity[k] !== e.cells[0].identity[k]))
    out.push(`  - Conflict: \`${e.task_id}\` / ${e.arm}: ${e.cells.map((c) => `${c.accepted}/${c.n}`).join(' vs ')}, split by ${differs.join(', ')}.`)
  }

  out.push('\n### Benchmark health signals\n')
  out.push(`Three separate signals. They are never combined into one score.\n`)
  out.push(`- **Difficulty:** the pass rate of the reference arm \`${s.reference}\`. Mean over ${s.difficulty.tasks} tasks, each weighted once: ${pct(s.difficulty.mean_rate)}${range(s.difficulty.ci)} (bootstrap over tasks). Tasks it fails by majority: ${s.difficulty.failed_tasks}.`)
  out.push(`- **Outcome discrimination:** a task discriminates when the per-task majority verdicts of its arms differ. A verdict is solved when more than half the repeats pass, and a tie is not solved, as in stats.mts \`discordant\`. ${s.outcome.discriminating} of ${s.outcome.comparable_tasks} tasks that ran on two or more arms discriminate (${pct(s.outcome.share)}). Tasks on one arm only: ${s.outcome.single_arm_tasks}.`)
  out.push(`- **Economic discrimination:** two arms with the same majority verdict differ when one costs at least ${s.cost_ratio}× the other per accepted run. ${s.economic.discriminating} of ${s.economic.eligible_tasks} tasks with such a pair discriminate (${pct(s.economic.share)}).`)
  if (s.pairs.length) {
    out.push('\n| Arm A | Arm B | Shared tasks | Only A solved | Only B solved | p (McNemar, Holm) |\n|---|---|---:|---:|---:|---:|')
    for (const p of s.pairs) out.push(`| ${p.a} | ${p.b} | ${p.tasks} | ${p.only_a} | ${p.only_b} | ${p.p_holm.toFixed(3)} |`)
  }
  out.push(`\n**\`${focusId}\`:**`)
  const t = r.focus
  if (!t) out.push('- Not in these results.')
  else {
    const cells = m.entries.filter((e) => e.task_id === t.task_id && e.primary).map((e) => `${e.arm} ${e.primary.accepted}/${e.primary.n}${range(e.primary.ci)}`)
    out.push(`- Cells: ${cells.join('; ')}.`)
    out.push(`- Difficulty: ${t.difficulty ? `${t.difficulty.accepted}/${t.difficulty.n} on ${t.difficulty.arm} (${pct(t.difficulty.rate)}${range(t.difficulty.ci)})` : `missing: \`${s.reference}\` did not run it`}.`)
    out.push(`- Outcome discrimination: ${yesNo(t.outcome.discriminates)}. Solved by majority: ${t.outcome.solved_by.join(', ') || 'none'}. Failed: ${t.outcome.failed_by.join(', ') || 'none'}.`)
    out.push(`- Economic discrimination: ${yesNo(t.economic.discriminates)}${t.economic.pairs.length ? `. ${t.economic.pairs.map((p) => `${p.dearer} costs ${p.ratio.toFixed(2)}× ${p.cheaper} (both ${p.verdict ? 'solved' : 'failed'})`).join('; ')}` : '. No two arms share a verdict with a known cost per accepted run'}.`)
  }
  if (s.warning) out.push(`\n> **Warning (heuristic, not a release gate).** ${s.warning}`)

  out.push('\n### False completion rate\n')
  out.push(`Rate = runs that explicitly claimed completion and failed acceptance ÷ runs that explicitly claimed completion and have a valid grade. The claim field is \`${CLAIM_FIELD}\`, a boolean. A row without it is N/A, never a success or a failure.\n`)
  out.push(`- Rate: ${f.rate === null ? 'n/a' : `${f.false_claims}/${f.claims_graded} (${pct(f.rate)})`}.`)
  out.push(`- N/A: ${f.na_no_field + f.na_ambiguous + f.na_ungraded} of ${f.rows} rows. No claim field: ${f.na_no_field}. Ambiguous field: ${f.na_ambiguous}. Claim without a valid grade: ${f.na_ungraded}. Explicitly no claim: ${f.no_claim}.`)
  out.push(`- Completion gate: ${f.gate_verified ? `${f.gate_verified_failed} of ${f.gate_verified} graded runs it called verified failed the hidden tests` : 'no graded run with a gate verdict of verified'}.`)
  return out
}
