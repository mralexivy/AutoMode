// The task envelope: what survives short follow-ups and compaction. The spec keeps the full prompt
// and is never injected whole; only a bounded summary is, and only when something changed.
import type { Acceptance, Complexity, RiskAssessment, TaskEnvelope } from './types.ts'
import { maxRisk } from './types.ts'
import { reviewNeeded } from './risk.ts'

export const SUMMARY_CHARS = 1200 // about 300 tokens

export function headline(text: string): string {
  const first = text.trim().split(/\n/)[0] ?? ''
  return first.length > 160 ? `${first.slice(0, 157)}...` : first
}

// acceptanceFrom keeps the person's own criteria: bullet lines, "must", "should", "make sure" lines.
export function acceptanceFrom(text: string): Acceptance[] {
  const out: Acceptance[] = []
  for (const line of text.split(/\n/)) {
    const l = line.trim().replace(/^[-*•]\s+|^\d+[.)]\s+/, '')
    if (l.length < 6 || l.length > 300) continue
    if (/^[-*•]|^\d+[.)]/.test(line.trim()) || /\b(must|should|make sure|ensure|needs? to|has to|do not|don'?t)\b/i.test(l)) out.push({ text: l, source: 'user' })
  }
  return out.slice(0, 20)
}

export function newEnvelope(taskId: string, promptId: string, text: string, now: number, complexity: Complexity, prospective: RiskAssessment): TaskEnvelope {
  const env: TaskEnvelope = {
    taskId, revision: 1, createdAt: now, promptIds: [promptId], spec: { promptId, text },
    summary: '', acceptance: acceptanceFrom(text), complexity,
    risk: { prospective, observed: null, effective: prospective.level },
    reviewRequired: { value: false, because: [] }, verified: false, workflow: {}, discovery: [], failures: [],
    escalations: 0, editedPaths: [], status: 'open', injectedRevision: 0,
  }
  return withReview(env, 'none', false)
}

export function withReview(env: TaskEnvelope, verification: 'pass' | 'fail' | 'unverified' | 'none', large: boolean): TaskEnvelope {
  const because = reviewNeeded(env.risk.prospective, env.risk.observed, verification, large)
  if (!because.length) return env
  const merged = [...new Set([...env.reviewRequired.because, ...because])]
  return { ...env, reviewRequired: { value: true, because: merged }, revision: env.revision + (merged.length === env.reviewRequired.because.length ? 0 : 1) }
}

// observe raises the envelope's risk from what was actually changed. It never lowers it.
export function observe(env: TaskEnvelope, observed: RiskAssessment): TaskEnvelope {
  const prior = env.risk.observed
  const level = maxRisk(prior?.level ?? 'none', observed.level)
  const reasons = [...new Set([...(prior?.reasons ?? []), ...observed.reasons])]
  const effective = maxRisk(env.risk.effective, level)
  const changed = effective !== env.risk.effective || reasons.length !== (prior?.reasons.length ?? 0)
  return { ...env, risk: { ...env.risk, observed: { level, reasons, source: 'diff' }, effective }, revision: env.revision + (changed ? 1 : 0) }
}

export function summaryOf(env: TaskEnvelope): string {
  const parts = [
    `Task: ${headline(env.spec.text)}`,
    `Risk: ${env.risk.effective}${env.risk.effective !== 'none' ? ` (${[...env.risk.prospective.reasons, ...(env.risk.observed?.reasons ?? [])].slice(0, 3).join('; ')})` : ''}`,
    env.reviewRequired.value ? `Independent review required: ${env.reviewRequired.because.slice(0, 3).join('; ')}. Do not call the task done before it.` : '',
    env.workflow.stage ? `Workflow stage: ${env.workflow.stage}` : '',
    env.acceptance.filter((a) => a.source === 'user').length ? `User acceptance: ${env.acceptance.filter((a) => a.source === 'user').map((a) => a.text).join(' | ')}` : '',
  ].filter(Boolean)
  const s = parts.join('\n')
  return s.length > SUMMARY_CHARS ? `${s.slice(0, SUMMARY_CHARS - 3)}...` : s
}

// injection decides what the model sees: nothing when nothing changed, the full summary after a
// reset (compaction, reload) or on a new task, otherwise only the changed lines.
export function injection(env: TaskEnvelope, reason: 'none' | 'reset' | 'new-task', previousSummary: string): string | null {
  const now = summaryOf(env)
  if (reason !== 'none') return `[AutoMode task state]\n${now}`
  if (env.injectedRevision === env.revision) return null
  const before = new Set(previousSummary.split('\n'))
  const delta = now.split('\n').filter((l) => !before.has(l))
  return delta.length ? `[AutoMode task update]\n${delta.join('\n')}` : null
}

// isBoundary decides whether a prompt opens a new task.
export function isBoundary(opts: { explicitNew: boolean; cleared: boolean; judgeNewTask: boolean; judgeConfidence: number; followUp: boolean; envelope: TaskEnvelope | null }): boolean {
  if (!opts.envelope) return true
  if (opts.explicitNew || opts.cleared) return true
  if (opts.followUp) return false
  if (opts.envelope.workflow.stage === 'done') return true
  return opts.judgeNewTask && opts.judgeConfidence >= 0.7
}

// close ends an envelope. A pending review on an abandoned task is reported by the caller.
export function close(env: TaskEnvelope, how: 'done' | 'abandoned' | 'superseded'): TaskEnvelope {
  return { ...env, status: how }
}

export function compactInstructions(env: TaskEnvelope): string {
  const user = env.acceptance.filter((a) => a.source === 'user').map((a) => `- ${a.text}`).join('\n')
  return `Keep this task state in the summary verbatim:\n${summaryOf(env)}${user ? `\nUser acceptance criteria:\n${user}` : ''}`
}
