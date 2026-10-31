// Layered consequence detection: what a wrong change could break. It replaces the single phrase list,
// which caught 0 of 8 critical real prompts. A risky word alone never decides: the text layer needs a
// consequential domain AND a change to that domain (not a question, not a message, not a surface edit
// such as copy, style, docs or tests). Other layers come from the work itself: planned and edited paths,
// changed exported interfaces, failed verification, and the judge.
//
// Critical needs hard evidence: an edited path, an operation (lib/operations.ts) or a production target. Words and the
// judge are opinions, so either alone caps at elevated, and only their agreement stands in for hard evidence. A judge
// that alone says critical still buys a review, on Sonnet, and routing still reads its word (`routing`).
//
// Consequence sets controls (verification, independent review) and the floors in v4.ts autoFloors.
// Designed on bench/consequence-dev.json; held-out sets bench/judge-cases-v3.json (seen) and
// a frozen case set was evaluated offline when the module was written.
import type { Risk } from './types.ts'
import { maxRisk } from './types.ts'
import { classifyOperation, productionTarget } from './operations.ts'

export type Domain = 'auth' | 'secrets' | 'data' | 'interface' | 'concurrency' | 'money' | 'pii' | 'production' | 'security'
export type Intent = 'change' | 'inquiry' | 'communicate' | 'operate'

// Domain entities: specific terms of the consequential surface, never generic topic words ("token",
// "budget", "session" alone do not count).
const DOMAINS: Record<Domain, RegExp> = {
  auth: /\b(okta|sso|saml|oauth|oidc|jwt|log ?in|login|sign[- ]?in|sessions? (timeout|cookie|token)|session timeout|cookies?|groups? claims?|claims|group rules?|roles?|rbac|acls?|permissions?|permissioning|authori[sz]\w*|authenticat\w*|access (checks?|control|rights?)|read access|write access|tenants?'?|admins?|admin endpoint|editors? (role|group)s?|approv(e|al|als|ers?)\b[^.]{0,30}\b(polic\w*|levels?|flow|top[- ]?ups?)|who can approve|without a token|signature verification|auth (package|module|service|code|helpers?|middleware))\b/i,
  secrets: /\b(secrets?|credentials?|passwords?|password hashes|api[- ]?keys?|private keys?|service account keys?|(access|refresh|auth|bearer|oauth) tokens?|signing keys?|keys? rotation|rotate\b[^.]{0,30}\bkeys?|key\b[^.]{0,30}\b(repo|config|commit)|load\w* its key)\b/i,
  data: /\b(backfill\w*|migrat\w*\b[^.]{0,40}\b(data|users?|tables?|records|database|schema|hashes|stored)|(delete|remove|removes|purge|wipe|drop|truncate)\w*\b[^.]{0,30}\b(accounts?|users?|records|rows|tables?|columns?|data|files|events|uploads?)|drop (the )?(\w+ )?(table|columns?)|deprecated columns|move\b[^.]{0,30}\btable\b)\b/i,
  interface: /\b(public api|exported|breaking change|wire format|protocol|response (shape|format)|(GET|POST|PUT|PATCH|DELETE) \/\S+|other services import|for (all|every) consumers?|consumers?\b[^.]{0,20}\b(change|switch)|backward[- ]compat\w*|signature of)\b/i,
  concurrency: /\b(race conditions?|races?\b|deadlocks?|concurren\w*|parallel (writes?|requests?|updates?)|several (goroutines|threads)|from (several|multiple|many) (goroutines|threads|workers|pods)|two (workers|pods|requests|processes)\b[^.]{0,40}\b(same|at once|together)|shared (map|state)|mutex(es)?|locks? (ordering|contention)|atomic\w*|interleav\w*|at the same time|at once|same (job|report|item) twice|double[- ]?(send|charge|process\w*)|idempoten\w*|while\b[^.]{0,40}\b(running|blocked|in progress|finaliz\w*)|pause\b[^.]{0,40}\bresume|abort\b[^.]{0,40}\bresume)\b/i,
  money: /\b(charg(e|es|ing)\b[^.]{0,20}\b(customer|card|user)s?|(credit|debit|payment|customer'?s?|user'?s?) cards?|payments?|payouts?|refunds?|invoices?|billing records|discounts?|tax\b|receipts?|top[- ]?ups?|balance strateg\w*|spend limits?)\b/i,
  pii: /\b(pii|personal data|gdpr|ssn|date of birth|phone numbers?|ip addresses|emails? and (home )?addresses|reporting[- ]line)\b/i,
  security: /\b(cve-\d{4}-\d+|vulnerabilit\w*|security (fix|patch|issue|hole|advisory)|exploit\w*|injection (flaw|bug|attack)|xss|csrf|ssrf|decrypt\w*|encrypt\w*)\b/i,
  production: /\b(prod(uction)?\b[^.]{0,60}\b(down|broken|fails?|failing|errors?|500|stuck|loops?|redirects?|outage|incident|returns?)|since the last deploy|after the deploy\b[^.]{0,40}\b(fails?|broken|loops?|forever|500))|\b(down|broken|500|stuck|loops?|redirects forever)\b[^.]{0,40}\bprod(uction)?\b/i,
}

// Change targets that are only the surface: wording, styling, docs, tests, comments, observability.
const SURFACE = /\b(typos?|heading|copy|labels?|wording|translat\w*|spinner|loading (bar|state)|progress bar|dark mode|styles?|styling|colou?rs?|alignment|align|sort\w*|rename the\b[^.]{0,30}\b(tab|label|section|button|heading)|readme|docs?|document\w*|comments?|unit tests?|add a test|tests? (for|that)|metrics for|debug logs?|print\w*|faster by caching the static)\b/i

const QUESTION_START = /^(what|why|how|which|who|when|where|is|are|was|were|does|do|did|can|could|should|would|will|explain|tell me|show me|give me|list|count|compare|summari[sz]e|describe)\b/i
const CHANGE_VERB = /\b(add|adds|fix|fixes|change|changes|implement|remove|removes|delete|deletes|rename|migrate|store|stores|update|refactor|create|write|writes|make|let|allow|give|grant|enforce|switch|replace|support|backfill|move|purge|drop|rotate|hash|expose|log|charge|refund|apply|build|design|set)\b/i
const COMMUNICATE = /\b(slack|message|ticket|email|reply|answer for|case|announcement)\b/i
const OPERATE = /\b(deploy\w*|push\w* to (main|origin|prod\w*)|merge request|\bmr\b|release|ship\w*|against prod\w*)\b/i
const PRESERVE = /\b(without (changing|a) (its |the )?(behaviou?r|logic)|no behaviou?r change|without behaviou?r change|behaviou?r[- ]preserving|without changing (it|logic)|(pure|just a|only a) (rename|move|refactor))\b/i

// A surface word covers only its own clause: "fix the auth middleware; add a test for that" still changes auth.
const CLAUSE = /[.!?]+\s+|[;\n]+\s*|,\s*(?:and|then|also)\b|\s+and then\s+|\s+then\s+/i
const clausesOf = (text: string) => text.split(CLAUSE).filter(Boolean)
function surfaceOnly(text: string): boolean {
  const touching = clausesOf(text).filter((c) => domainsOf(c).length)
  // A domain phrase split across clauses matches in no single clause: the whole text decides.
  return touching.length ? touching.every((c) => SURFACE.test(c)) : SURFACE.test(text)
}

export function intentOf(text: string): Intent {
  const t = text.trim()
  if (COMMUNICATE.test(t) && /\b(write|draft|prepare|create|open|construct|rewrite)\b/i.test(t) && !/\b(fix|implement|refactor)\b/i.test(t)) return 'communicate'
  if (QUESTION_START.test(t) && !/\b(and (then )?(fix|implement|change|add|make|update)|then (fix|implement|change))\b/i.test(t)) return 'inquiry'
  // Ends on a question: the last sentence decides ("..., does that make sense?" asks; "fix X?" asks for a change).
  const last = (t.replace(/\?\s*$/, '').split(/[.;:!]\s/).pop() ?? '').trim()
  if (/\?\s*$/.test(t) && (QUESTION_START.test(last) || !CHANGE_VERB.test(last))) return 'inquiry'
  // A deploy word does not make a change an operation: "rotate the key and update every deployment" changes.
  if (OPERATE.test(t) && !CHANGE_VERB.test(t.replace(new RegExp(OPERATE.source, 'gi'), ' '))) return 'operate'
  return 'change'
}

export function domainsOf(text: string): Domain[] {
  return (Object.keys(DOMAINS) as Domain[]).filter((d) => DOMAINS[d].test(text))
}

export interface TextConsequence { level: Risk; intent: Intent; domains: Domain[]; reasons: string[] }

// textConsequence: the prompt layer.
export function textConsequence(text: string): TextConsequence {
  const intent = intentOf(text)
  const domains = domainsOf(text)
  const reasons: string[] = []
  // A production incident is critical whatever the phrasing: something live is broken.
  if (domains.includes('production') && intent !== 'communicate') return { level: 'critical', intent, domains, reasons: ['production incident'] }
  if (!domains.length) return { level: intent === 'operate' ? 'elevated' : 'none', intent, domains, reasons: intent === 'operate' ? ['deploy or release step'] : [] }
  // A proposal ("can we store X in the cookie?") is a design decision on the domain: elevated, so checks
  // run; the diff layer raises it to critical if the change is made.
  if (intent === 'inquiry' && /^(can|could|should|shall) (we|i|you)\b/i.test(text.trim()) && CHANGE_VERB.test(text)) return { level: 'elevated', intent, domains, reasons: [`proposal touching ${domains.join(', ')}`] }
  if (intent === 'inquiry') return { level: 'none', intent, domains, reasons: [`question about ${domains.join(', ')}; nothing changes`] }
  if (intent === 'communicate' || intent === 'operate') return { level: 'elevated', intent, domains, reasons: [`${intent} touching ${domains.join(', ')}`] }
  // Personal data written somewhere new is critical even through logs or exports.
  const piiExposure = domains.includes('pii') && /\b(log|export|write|store|share|send|backfill)\w*\b/i.test(text)
  if (surfaceOnly(text) && !piiExposure) return { level: 'none', intent, domains, reasons: [`surface change near ${domains.join(', ')}`] }
  if (PRESERVE.test(text)) return { level: 'elevated', intent, domains, reasons: [`behavior-preserving change in ${domains.join(', ')}`] }
  reasons.push(...domains.map((d) => `changes ${d}`))
  return { level: 'critical', intent, domains, reasons }
}

export interface ConsequenceInput {
  text: string
  judge?: { risk: Risk; consequence?: Risk; confidence?: number } | null
  judgeFailed?: boolean
  pathLevel?: Risk          // from planned or named paths (risk.ts pathRisk): words about a target, not an edit
  observedLevel?: Risk      // from edits, diff size and interfaces (risk.ts observedRisk)
  verificationFailed?: boolean
}
export interface ConsequenceAssessment {
  level: Risk                  // what the controls act on
  routing: Risk                // what model routing reads: the level, or critical where the judge alone says so
  review: 'opus' | 'sonnet' | null
  hard: string[]               // the evidence that needs no opinion
  layers: Record<string, Risk>
  reasons: string[]
  uncertain: boolean
}

// hardEvidence: what stands without an opinion. A command spelled out in the prompt counts when the prompt asks to run
// it: a question about `terraform apply` does not, and neither does a clause that only documents or tests it.
function hardEvidence(i: ConsequenceInput, t: TextConsequence): string[] {
  const out: string[] = []
  if (i.observedLevel === 'critical') out.push('edited path')
  if (t.domains.includes('production') && t.intent !== 'communicate') out.push('production incident')
  if (t.intent === 'change' || t.intent === 'operate') {
    const acting = clausesOf(i.text).filter((c) => !SURFACE.test(c))
    const op = acting.map(classifyOperation).find(Boolean)
    if (op) out.push(`operation: ${op.reason}`)
    if (acting.some(productionTarget)) out.push('production target')
  }
  return out
}

// assess combines the layers. The judge can raise but never lower the deterministic layers. A failed or low-confidence
// judge marks the result uncertain and floors it at elevated: checks run.
export function assess(i: ConsequenceInput): ConsequenceAssessment {
  const t = textConsequence(i.text)
  const judged = i.judge ? maxRisk(i.judge.risk, i.judge.consequence ?? 'none') : 'none'
  const uncertain = !!i.judgeFailed || (!!i.judge && (i.judge.confidence ?? 1) < 0.6)
  const layers: Record<string, Risk> = { text: t.level, judge: judged, paths: i.pathLevel ?? 'none', diff: i.observedLevel ?? 'none', verification: i.verificationFailed ? 'elevated' : 'none' }
  let top: Risk = uncertain ? 'elevated' : 'none'
  for (const v of Object.values(layers)) top = maxRisk(top, v)
  const hard = hardEvidence(i, t)
  const wordsCritical = t.level === 'critical' || i.pathLevel === 'critical'
  const agree = wordsCritical && judged === 'critical'
  const level: Risk = hard.length || agree ? 'critical' : top === 'critical' ? 'elevated' : top
  const routing = judged === 'critical' ? 'critical' : level
  const review = level === 'critical' ? 'opus' : judged === 'critical' ? 'sonnet' : null
  const reasons = [...t.reasons, ...hard, ...(judged !== 'none' ? [`judge: ${judged}`] : []), ...(uncertain ? ['judge unavailable or unsure'] : [])]
  return { level, routing, review, hard, layers, reasons, uncertain }
}
