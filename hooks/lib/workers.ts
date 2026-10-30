// Worker protocol (supported delegation): the main model calls the Agent tool; these helpers bound the
// worker's reads, validate its report, and offer earlier discoveries for reuse. A report that returns
// after its task changed is dropped by the caller (v4.ts compares task ids).
import type { DiscoveryRecord } from './types.ts'

export interface WorkerBudget { target: number; stopAt: number; maxReadLines: number; maxGrepResults: number }
export const HAIKU_BUDGET: WorkerBudget = { target: 60_000, stopAt: 45_000, maxReadLines: 800, maxGrepResults: 200 }

// clampRead bounds one Read call so no single tool result adds more than about 10k tokens.
export function clampRead(input: Record<string, unknown>, b: WorkerBudget): Record<string, unknown> | null {
  const limit = Number(input.limit)
  if (Number.isFinite(limit) && limit > 0 && limit <= b.maxReadLines) return null
  return { ...input, limit: b.maxReadLines }
}

export function clampGrep(input: Record<string, unknown>, b: WorkerBudget): Record<string, unknown> | null {
  const head = Number(input.head_limit)
  if (Number.isFinite(head) && head > 0 && head <= b.maxGrepResults) return null
  return { ...input, head_limit: b.maxGrepResults }
}

export const BUDGET_STOP = 'Budget reached: stop reading. Return your findings now as the JSON report, and list every file or question you did not cover in "omitted".'

export const DISCOVERY_REPORT = `Return JSON only:
{"findings":[{"what":"one fact","where":"path:line","confidence":"high|medium|low"}],
 "relevant_files":["path"],"interfaces":["signature or contract, with path:line"],
 "tests":["test file or command"],"constraints":["rule the change must keep"],
 "open_questions":["..."],"omitted":["file or area not read, and why"],"complete":true|false}`

export const DIAGNOSIS_REPORT = `Return JSON only:
{"failing":["test or check name"],"cause":"the most likely cause, one paragraph","evidence":["path:line or log line"],
 "category":"defect|environment|flaky|unknown","fix_plan":["step"],"omitted":["..."],"complete":true|false}`

export function diagnosePrompt(command: string, output: string, edited: string[]): string {
  return [
    `Failing command: ${command}`,
    `Output (tail):\n${output.slice(-6000)}`,
    edited.length ? `Files edited in this task: ${edited.slice(0, 30).join(', ')}` : '',
    'Find the cause. Read only what you need. Do not fix it.',
    DIAGNOSIS_REPORT,
  ].filter(Boolean).join('\n\n')
}

export type ReportStatus = 'ok' | 'partial' | 'invalid'
export interface Validated { status: ReportStatus; report: Record<string, unknown> | null; omitted: string[] }

// validateReport accepts only JSON with the required keys and an omitted list.
export function validateReport(text: string, kind: 'discovery' | 'diagnosis'): Validated {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return { status: 'invalid', report: null, omitted: [] }
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>
    const need = kind === 'discovery' ? ['findings', 'relevant_files', 'omitted'] : ['cause', 'evidence', 'omitted']
    if (!need.every((k) => k in j)) return { status: 'invalid', report: null, omitted: [] }
    const omitted = Array.isArray(j.omitted) ? j.omitted.map(String) : []
    return { status: j.complete === false || omitted.length ? 'partial' : 'ok', report: j, omitted }
  } catch {
    return { status: 'invalid', report: null, omitted: [] }
  }
}

// priorCoverage is the advisory reuse note for a new exploration: the task's complete discoveries
// whose files nobody edited since. Advisory only: the worker may still read anything.
// Revision-aware: with the files' current content hashes, a record whose covered file changed in any
// way (an edit in this session, a checkout, another tool) is dropped; without hashes the edit log decides.
export function priorCoverage(records: DiscoveryRecord[], edits: { path: string; at: number }[], current: Record<string, string> = {}): { paths: string[]; note: string | null } {
  const changed = (d: DiscoveryRecord) => d.paths.some((p) => d.hashes[p] !== undefined && current[p] !== undefined && d.hashes[p] !== current[p])
  const valid = records.filter((d) => d.complete && !changed(d) && !edits.some((e) => e.at > d.at && d.paths.includes(e.path)))
  const paths = [...new Set(valid.flatMap((d) => d.paths))].slice(0, 60)
  if (!paths.length) return { paths, note: null }
  return { paths, note: `[AutoMode: an earlier discovery in this task already covered these files, unchanged since: ${paths.join(', ')}. Use what the session already knows about them; read them again only for something it did not cover.]` }
}
