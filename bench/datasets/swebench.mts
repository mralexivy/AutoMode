// SWE-bench items become tasks. Upstream's Docker harness does the scoring, because each instance needs its own image:
// this exports predictions and reads the scores back. It never reimplements the evaluator.
import type { Task } from '../lib/task-repo.mts'

export interface SweItem { repo: string; instance_id: string; base_commit: string; problem_statement: string; difficulty?: string }

export function sweTask(item: SweItem, dataset: string, revision: string): Task {
  return {
    schema_version: 2, id: item.instance_id, cohort: 'external', repo: `https://github.com/${item.repo}`, license: 'dataset', base: item.base_commit, reference: item.base_commit,
    task: item.problem_statement, hidden_tests: [], accept: '', external_eval: 'swebench', provenance: { source: 'swebench', dataset, dataset_version: revision },
  }
}

// Upstream caches by run id and instance, so each arm and repeat is one prediction file and one upstream run.
export const sweRunName = (arm: string, repeat: number) => `${arm}__r${repeat}`

export function predictions(rows: any[], readPatch: (runId: string) => string | null) {
  const out = new Map<string, { instance_id: string; model_name_or_path: string; model_patch: string }[]>()
  for (const r of rows) {
    const name = sweRunName(r.arm, r.repeat)
    out.set(name, [...(out.get(name) ?? []), { instance_id: r.task_id, model_name_or_path: name, model_patch: readPatch(r.run_id) ?? '' }])
  }
  return out
}

export const evaluationCommand = (datasetName: string, file: string, runName: string) =>
  ['python', '-m', 'swebench.harness.run_evaluation', '--dataset_name', datasetName, '--predictions_path', file, '--max_workers', '4', '--run_id', runName]

// applyReport sets each row's verdict from upstream's results.json. An instance upstream could not judge stays pending:
// an infrastructure failure says nothing about the patch.
export function applyReport(rows: any[], report: any, runName: string) {
  for (const k of ['resolved_ids', 'unresolved_ids', 'empty_patch_ids']) if (!Array.isArray(report[k])) throw new Error(`results.json has no ${k}: the upstream format changed`)
  const resolved = new Set<string>(report.resolved_ids)
  const failed = new Set<string>([...report.unresolved_ids, ...report.empty_patch_ids])
  return rows.map((r) => {
    if (sweRunName(r.arm, r.repeat) !== runName) return r
    if (resolved.has(r.task_id)) return { ...r, accepted: true, external_verdict: 'resolved' }
    if (failed.has(r.task_id)) return { ...r, accepted: false, external_verdict: 'failed' }
    return r
  })
}
