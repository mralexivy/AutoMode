// Policy replay on recorded decisions. Each policy-auto decision record carries `auto.replay`: the route input, the
// outcome and its provenance (hooks/lib/auto-route.ts replayOf). This module checks that input and runs a policy on it.
//
// Contract:
// - A record without a complete input is unreplayable, with the reason. Nothing fills a missing field with a default,
//   because a default could manufacture agreement.
// - `exact` asks whether the recorded policy reproduces the recorded outcome. It counts agreement only where the
//   record's route fingerprint matches the code that replays it. A record from other code is reported apart.
// - `counterfactual` asks how another policy routes the same frozen evidence. Its rows compare outcomes, never verdicts.
// - Rerunning the judges is classifier evaluation. Records hold no prompt text, so it cannot run from here.
import { AUTO_ROUTE_SCHEMA, type AutoRouteInput, type RouteOutcome } from '../../hooks/lib/auto-route.ts'

export type Policy = (input: AutoRouteInput) => RouteOutcome

// The fields routeAuto reads. A key with the value undefined is absent after a JSON round trip, so optional fields
// (fixedFamily, command, second, appEffort, reachHaiku, resetPrefixTokens, lastWorkBand) are not listed.
const REQUIRED: Record<string, string[]> = {
  '': ['schemaVersion', 'now', 'allowed', 'appFamily', 'shortcut', 'kept', 'judge', 'judgeCached', 'anchor', 'verdicts', 'complexity', 'stage', 'previousStage', 'boundary', 'riskChanged', 'planBoundary', 'planExited', 'floor', 'current', 'usable', 'executor', 'learned', 'votes', 'switching', 'economics', 'consult', 'policy'],
  floor: ['taskId', 'risk', 'riskReasons', 'ladderFloor', 'taskDecision', 'stayUp', 'currentFamily'],
  executor: ['on', 'taskRoute'],
  learned: ['on', 'opusBuckets'],
  votes: ['tier', 'n'],
  switching: ['cache', 'reset', 'requestsSinceSwitch', 'verifiedSinceSwitch', 'switchesThisTask', 'warm', 'warmPrefix', 'continuity'],
  economics: ['attempt', 'outputPerStep', 'effortOutput', 'effortSteps', 'prices', 'calibrated'],
  consult: ['consulted', 'packetTokens', 'ttlMs'],
  policy: ['lowConfidence'],
}

// missingField: the first required field the input lacks, or null when the input is complete.
export function missingField(input: Record<string, any>): string | null {
  for (const [scope, keys] of Object.entries(REQUIRED)) {
    const obj = scope ? input[scope] : input
    if (obj === null || typeof obj !== 'object') return scope
    for (const k of keys) if (!(k in obj)) return scope ? `${scope}.${k}` : k
  }
  return null
}

export interface Replayable { at: number; sessionId: string; taskId: string; input: AutoRouteInput; outcome: RouteOutcome; fingerprint: string }
export interface Excluded { at: number; sessionId: string; reason: string }

// replayable splits policy-auto decision records into complete inputs and exclusions with reasons.
export function replayable(records: any[]): { rows: Replayable[]; excluded: Excluded[] } {
  const rows: Replayable[] = []
  const excluded: Excluded[] = []
  for (const r of records) {
    if (r?.kind !== 'decision' || r.policy !== 'auto' || !r.auto) continue
    const base = { at: r.at, sessionId: r.sessionId }
    const rep = r.auto.replay
    if (!rep) { excluded.push({ ...base, reason: r.point === 'trigger' ? 'trigger: stored verdicts, no route input' : 'no route input: recorded before replay existed' }); continue }
    if (rep.input?.schemaVersion !== AUTO_ROUTE_SCHEMA) { excluded.push({ ...base, reason: `unknown input schema ${rep.input?.schemaVersion}` }); continue }
    const missing = missingField(rep.input)
    if (missing) { excluded.push({ ...base, reason: `missing ${missing}` }); continue }
    if (!rep.outcome?.route) { excluded.push({ ...base, reason: 'missing outcome' }); continue }
    rows.push({ ...base, taskId: r.taskId, input: rep.input, outcome: rep.outcome, fingerprint: rep.provenance?.fingerprint ?? '' })
  }
  return { rows, excluded }
}

export const sameOutcome = (a: RouteOutcome, b: RouteOutcome) => a.route === b.route && a.owner === b.owner && (a.gate ?? null) === (b.gate ?? null) && (a.consult ?? null) === (b.consult ?? null) && !!a.fallback === !!b.fallback

export interface ExactReport { mode: 'exact'; replayed: number; agreed: number; differed: { at: number; sessionId: string; recorded: RouteOutcome; replayed: RouteOutcome }[]; otherCode: { replayed: number; agreed: number }; excluded: Record<string, number> }

// exact: replay each complete record on `policy` and compare with what was recorded. `fingerprint` is the replaying
// code's routeFingerprint(); records from other code count apart.
export function exact(records: any[], policy: Policy, fingerprint: string): ExactReport {
  const { rows, excluded } = replayable(records)
  const report: ExactReport = { mode: 'exact', replayed: 0, agreed: 0, differed: [], otherCode: { replayed: 0, agreed: 0 }, excluded: countBy(excluded) }
  for (const row of rows) {
    const out = policy(row.input)
    const same = sameOutcome(row.outcome, out)
    if (row.fingerprint !== fingerprint) { report.otherCode.replayed += 1; if (same) report.otherCode.agreed += 1; continue }
    report.replayed += 1
    if (same) report.agreed += 1
    else report.differed.push({ at: row.at, sessionId: row.sessionId, recorded: row.outcome, replayed: out })
  }
  return report
}

export interface CounterfactualReport { mode: 'counterfactual'; replayed: number; changed: number; models: Record<string, number>; efforts: number; owners: Record<string, number>; confusion: Record<string, Record<string, number>>; excluded: Record<string, number> }

// counterfactual: route the same frozen inputs with policies A and B, and count how the routes move.
export type BatchPolicy = (inputs: AutoRouteInput[]) => RouteOutcome[]
export function counterfactual(records: any[], a: BatchPolicy, b: BatchPolicy): CounterfactualReport {
  const { rows, excluded } = replayable(records)
  const inputs = rows.map((r) => r.input)
  const outA = a(inputs)
  const outB = b(inputs)
  const report: CounterfactualReport = { mode: 'counterfactual', replayed: rows.length, changed: 0, models: {}, efforts: 0, owners: {}, confusion: {}, excluded: countBy(excluded) }
  rows.forEach((_, k) => {
    const [x, y] = [outA[k], outB[k]]
    report.confusion[x.route] ??= {}
    report.confusion[x.route][y.route] = (report.confusion[x.route][y.route] ?? 0) + 1
    if (sameOutcome(x, y)) return
    report.changed += 1
    const [fx] = x.route.split('/'), [fy] = y.route.split('/')
    if (fx !== fy) report.models[`${fx}->${fy}`] = (report.models[`${fx}->${fy}`] ?? 0) + 1
    else if (x.route !== y.route) report.efforts += 1
    if (x.owner !== y.owner) report.owners[`${x.owner}->${y.owner}`] = (report.owners[`${x.owner}->${y.owner}`] ?? 0) + 1
  })
  return report
}

// routeDistance: how far two first routes are apart. A model change counts 1, each effort step 0.25.
export function routeDistance(a: string, b: string): number {
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
  const [fa, ea] = a.split('/'), [fb, eb] = b.split('/')
  return (fa !== fb ? 1 : 0) + 0.25 * Math.abs(EFFORTS.indexOf(ea) - EFFORTS.indexOf(eb))
}

function countBy(excluded: Excluded[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of excluded) out[e.reason] = (out[e.reason] ?? 0) + 1
  return out
}
