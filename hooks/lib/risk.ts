// Risk: prospective (before any change) and observed (after changes). Prospective risk comes from the
// judge's risk axis, from deterministic rules on file paths the task names, and from the person's own
// risk phrases. Observed risk comes from the paths actually edited and the size of the change. Topic
// words alone ("token", "permissions") never raise risk: that sent 14 of 16 benchmark runs to review.
import type { Risk, RiskAssessment } from './types.ts'
import { maxRisk } from './types.ts'
import { assess, textConsequence } from './consequence.ts'

// Consequential surfaces, matched against file paths (named in the task or edited).
export const RISK_PATHS: { reason: string; level: Risk; path: RegExp }[] = [
  { reason: 'auth or credentials code', level: 'critical', path: /(^|\/)(auth|oauth|login|session|credential|secret|crypto|permission|rbac|acl|sso|saml|jwt)[\w-]*(\/|\.[a-z]+$)/i },
  { reason: 'migration or schema', level: 'critical', path: /(^|\/)(migrations?|schema|db\/migrate|flyway|alembic|liquibase)(\/|\.[a-z]+$)|\.sql$/i },
  { reason: 'public API or wire format', level: 'critical', path: /(^|\/)(api|proto|openapi|swagger|graphql)(\/|\.[a-z]+$)|\.proto$|openapi\.(ya?ml|json)$/i },
  { reason: 'payments or personal data', level: 'critical', path: /(^|\/)(payments?|billing|invoices?|pii|gdpr)[\w-]*(\/|\.[a-z]+$)/i },
  { reason: 'deployment config', level: 'elevated', path: /(^|\/)(helm|k8s|kubernetes|terraform|deploy|\.gitlab-ci\.yml|\.github\/workflows|Dockerfile)/i },
]

// pathsIn extracts file-like paths from text: tokens with a slash or a file extension.
export function pathsIn(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/[\w./-]*[\w-]+\.(go|ts|tsx|js|mjs|py|rb|java|kt|rs|sql|proto|ya?ml|json|tf|sh)\b|(?:[\w-]+\/)+[\w.-]+/g)) out.add(m[0])
  return [...out]
}

export function pathRisk(paths: string[]): { level: Risk; reasons: string[] } {
  let level: Risk = 'none'
  const reasons = new Set<string>()
  for (const p of paths) for (const r of RISK_PATHS) if (r.path.test(p)) { level = maxRisk(level, r.level); reasons.add(`${r.reason}: ${p}`) }
  return { level, reasons: [...reasons].slice(0, 6) }
}

// prospectiveRisk: before any change, through the layered assessment (consequence.ts assess). Named or planned paths
// are the path layer. A path alone does not make a question, a surface edit or a behavior-preserving change critical:
// then it counts as elevated. The judge can raise but never lower.
export function prospectiveRisk(text: string, judge: { risk: Risk; why: string } | null, plannedPaths: string[] = []): RiskAssessment {
  const t = textConsequence(text)
  const fromPaths = pathRisk([...pathsIn(text), ...plannedPaths])
  const softened = fromPaths.level === 'critical' && t.level !== 'critical' && (t.intent !== 'change' || PRESERVING.test(text))
  const pathLevel = softened ? 'elevated' : fromPaths.level
  const a = assess({ text, judge: judge ? { risk: judge.risk } : null, pathLevel })
  const reasons = [...t.reasons, ...a.hard, ...fromPaths.reasons, ...(softened ? ['intent: no consequential change to these paths yet'] : [])]
  let source: RiskAssessment['source'] = t.level !== 'none' ? 'user' : 'rules'
  if (fromPaths.level !== 'none') source = plannedPaths.length ? 'plan' : 'rules'
  if (judge && judge.risk !== 'none') { reasons.push(`judge: ${judge.why || judge.risk}`); if (source === 'rules' && !fromPaths.reasons.length) source = 'judge' }
  return { level: a.level, reasons, source, ...(a.routing !== a.level ? { routing: a.routing } : {}), ...(a.review === 'sonnet' ? { review: 'sonnet' as const } : {}), ...(a.hard.length ? { hard: a.hard } : {}) }
}

export const PRESERVING = /\b(without changing (its |the )?behaviou?r|no behaviou?r change|behaviou?r[- ]preserving|(pure|just a|only a) (rename|move|refactor)|rename\b[^.]*\bwithout)\b/i

// interfaceChanges counts exported declarations an edit changes: Go exported funcs, methods and types,
// TS/JS exports. A changed signature is a consequence signal for review; it never picks the model.
const EXPORTED = /^\s*(func (\([^)]*\) )?[A-Z]\w*\s*\(.*|type [A-Z]\w*\b.*|export (default )?(async )?(function|const|class|interface|type|enum)\b.*)$/gm
export function interfaceChanges(oldText: string, newText: string): number {
  const decls = (t: string) => new Set([...t.matchAll(EXPORTED)].map((m) => m[0].trim().replace(/\s+/g, ' ')))
  const a = decls(oldText)
  const b = decls(newText)
  let n = 0
  for (const d of a) if (!b.has(d)) n += 1
  for (const d of b) if (!a.has(d)) n += 1
  return n
}

export interface ObservedInput { editedPaths: string[]; changedFiles: number; changedLines: number; verification: 'pass' | 'fail' | 'unverified' | 'none'; interfacesChanged?: number }
export const DEFAULT_LARGE = { files: 8, lines: 400 }

export function observedRisk(o: ObservedInput, large = DEFAULT_LARGE): RiskAssessment {
  const fromPaths = pathRisk(o.editedPaths)
  let level = fromPaths.level
  const reasons = [...fromPaths.reasons]
  if (o.changedFiles > large.files || o.changedLines > large.lines) { level = maxRisk(level, 'elevated'); reasons.push(`large change: ${o.changedFiles} files, ${o.changedLines} lines`) }
  if ((o.interfacesChanged ?? 0) > 0) { level = maxRisk(level, 'elevated'); reasons.push(`exported interface changed (${o.interfacesChanged})`) }
  return { level, reasons, source: 'diff' }
}

// A judge's word alone buys a Sonnet review. Every other reason to review keeps the Opus reviewer.
const JUDGE_ONLY = 'judge-only critical'
export const reviewerFamily = (because: string[]): 'sonnet' | 'opus' => (because.length && because.every((b) => b.startsWith(JUDGE_ONLY)) ? 'sonnet' : 'opus')

// reviewNeeded applies the review rules: critical risk, consequential surfaces, a large change, or a
// verification that failed or never ran. A passing test never clears rules 1, 3 or 4.
export function reviewNeeded(prospective: RiskAssessment, observed: RiskAssessment | null, verification: ObservedInput['verification'], large: boolean): string[] {
  const because: string[] = []
  if (prospective.level === 'critical') because.push(`prospective critical: ${prospective.reasons.join('; ')}`)
  else if (prospective.review === 'sonnet') because.push(`${JUDGE_ONLY}: ${prospective.reasons.join('; ')}`)
  if (observed && observed.level === 'critical') because.push(`observed critical: ${observed.reasons.join('; ')}`)
  if (large) because.push('large change')
  if (verification === 'fail' || verification === 'unverified') because.push(`verification ${verification}`)
  return because
}
