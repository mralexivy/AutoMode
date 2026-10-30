export const meta = {
  name: 'run',
  description: 'AutoMode V2: risk-banded routing. Haiku discovery (or a direct handoff), Opus or Sonnet plan, Sonnet build on a bounded task graph, code-checked verification, evidence-first Opus review by policy',
  whenToUse: 'A non-trivial coding task while the AutoMode model profile is active. Pass args { task, tier, mode, reviewPolicy, maxConcurrency, source_version }.',
  phases: [
    { title: 'Discover', detail: 'explorer on Haiku, read-only, 1 to 3 agents with disjoint scopes. Skipped in handoff mode and for S0.', model: 'haiku' },
    { title: 'Plan', detail: 'architect on Opus (Sonnet for low-risk S1). One bounded call, plus at most one evidence round.', model: 'opus' },
    { title: 'Build', detail: 'implementer on Sonnet, one agent per workstream, dependency-ordered, at most 2 at a time', model: 'sonnet' },
    { title: 'Verify', detail: 'verifier on Sonnet, at most 2 rounds. Code decides pass or fail from the checks.', model: 'sonnet' },
    { title: 'Review', detail: 'reviewer on Opus, by review policy and mandatory risk rules', model: 'opus' },
  ],
}

// ---------- input ----------
const A = typeof args === 'string' ? { task: args } : (args || {})
const task = String(A.task || '').trim()
if (!task) return { error: 'automode: args.task is required. Pass args { task: "...", tier: "standard|complex|critical", mode: "discover|handoff" }.' }
const SCHEMA_VERSION = 2
const TIERS = ['trivial', 'standard', 'complex', 'critical']
const BANDS = ['S0', 'S1', 'S2', 'S3']
const tierHint = TIERS.includes(A.tier) ? A.tier : 'standard'
// discover: Haiku agents explore first and the architect plans from their summaries.
// handoff: the architect reads the code itself and plans. Sonnet then takes over.
let mode = ['discover', 'handoff'].includes(A.mode) ? A.mode : 'discover'
// stages (optional, from the router's stagesFor): the stages this task needs. Absent means all, as in V2.
// implement and verify always run. Without 'discover' the architect reads the code itself (handoff).
// Without 'architect' a Sonnet planner plans, but only for bands S0-S1; S2+ always gets the Opus plan.
// Without 'review' the review runs only when a mandatory rule fires: a required review is never skipped.
const STAGES = ['discover', 'architect', 'implement', 'verify', 'review']
const stages = Array.isArray(A.stages) ? STAGES.filter((s) => A.stages.includes(s) || s === 'implement' || s === 'verify') : STAGES
if (!stages.includes('discover') && A.mode === undefined) mode = 'handoff'
// always: an Opus review on every S1+ run. risk: only when a mandatory rule applies.
const reviewPolicy = !stages.includes('review') ? 'risk' : ['always', 'risk'].includes(A.reviewPolicy) ? A.reviewPolicy : 'risk'
const maxConcurrency = Math.min(2, Math.max(1, Number(A.maxConcurrency) || 1))
const useDag = A.dag !== false
// Off by default: a Sonnet plan for small, risk-free S1 tasks saves Opus spend but is not measured yet.
const sonnetPlansSmallS1 = A.sonnetPlanSmall === true
const sourceVersion = String(A.source_version || 'unknown')
const MAX_VERIFY_ROUNDS = 2
const MAX_ESCALATIONS = 2
const DISCOVERY_CHAR_CAP = 24000
const FINDING_CHAR_CAP = 300
const ARCHITECT_READS = { discover: 8, handoff: 12 }

// fnv1a returns a short, stable hash for trace correlation. It is not a security guarantee.
function fnv1a(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
const taskId = String(A.task_id || `task-${fnv1a(task)}`)
const workflowId = String(A.workflow_id || `wf-${fnv1a([task, tierHint, mode, reviewPolicy, sourceVersion])}`)

// ---------- policy engine: deterministic, can only raise the band ----------
const RISK_RULES = [
  { band: 'S3', reason: 'security or credentials', text: /\b(security (review|fix|issue|vulnerabilit\w+)|cve-\d+|(oauth|auth\w*|login|sso|saml|jwts?|session) (flows?|logic|scopes?|tokens?|middleware|bypass|handling|checks?)|credentials? (handling|storage|rotation|leaks?)|(stor\w*|handl\w*|sav\w*|load\w*) (the |user |api )?credentials?|rotat\w* (the )?(\w+ )?(keys?|secrets?|credentials?|tokens?)|passwords? (hashing|storage|reset)|reset (the |user )?passwords?|(check\w*|enforc\w*|chang\w*) (the |user )?permissions?|verif\w* (the )?signatures?|refresh (the |access )?tokens?|encrypt\w*|decrypt\w*|permission (checks?|model)|rbac|acls?)\b/i, path: /(^|\/)(auth|security|crypto|secrets?)(\/|\.|$)|\.(pem|key)$/i },
  { band: 'S3', reason: 'data migration or destructive operation', text: /\b((data|schema|database|db) migrations?|migrat\w* (the )?(data|database|schema|users|tables?)|schema changes?|drop (tables?|columns?)|truncat\w* (the )?tables?|backfill\w*|delete (all|the) (data|records|rows))\b/i, path: /(^|\/)migrations?\/|\.sql$/i },
  { band: 'S3', reason: 'concurrency', text: /\b(race conditions?|deadlocks?|data races?|thread[- ]safe\w*|concurrent (access|writes?|calls?|requests)|mutex(es)?|from (several|multiple|many) goroutines|goroutines? (leaks?|safety)|lock ordering)\b/i, path: null },
  { band: 'S3', reason: 'externally visible contract', text: /\b(public apis?|breaking changes?|api contracts?|wire formats?|protocol changes?|sdk interfaces?)\b/i, path: /(^|\/)(api|proto|openapi)(\/|\.|$)|\.proto$/i },
  { band: 'S3', reason: 'payments or sensitive data', text: /\b(payments?|billing (logic|calculation|code)|invoic\w+|pii|gdpr|personal data)\b/i, path: null },
  { band: 'S2', reason: 'infrastructure or deployment', text: /\b(helm|terraform|kubernetes|k8s|dockerfile|ci pipeline|deploy\w*)\b/i, path: /(^|\/)(helm|terraform|k8s|deploy|\.github|\.gitlab-ci)|Dockerfile$|\.gitlab-ci\.yml$/i },
]
const higher = (a, b) => (BANDS.indexOf(a) >= BANDS.indexOf(b) ? a : b)
function classifyRisk(text, files, extra) {
  let band = 'S0'
  const reasons = []
  for (const r of RISK_RULES) {
    const hitText = r.text && r.text.test(text)
    const hitPath = r.path && files.some((f) => r.path.test(f))
    if (hitText || hitPath) {
      band = higher(band, r.band)
      reasons.push(`${r.band}: ${r.reason} (${hitPath ? 'path' : 'task text'})`)
    }
  }
  const modules = new Set(files.map((f) => f.split('/').slice(0, 2).join('/')))
  if (modules.size >= 3) { band = higher(band, 'S2'); reasons.push(`S2: ${modules.size} modules touched`) }
  if (extra.workstreams > 1) { band = higher(band, 'S2'); reasons.push(`S2: ${extra.workstreams} workstreams`) }
  if (extra.unknowns > 0) { band = higher(band, 'S2'); reasons.push(`S2: ${extra.unknowns} open unknowns`) }
  return { band, reasons }
}
let band = { trivial: 'S0', standard: 'S1', complex: 'S2', critical: 'S3' }[tierHint]
const bandReasons = [`${band}: router tier hint "${tierHint}"`]
function raiseBand(found, stage) {
  if (BANDS.indexOf(found.band) > BANDS.indexOf(band)) {
    note(`${stage}: band raised from ${band} to ${found.band} (${found.reasons.filter((r) => r.startsWith(found.band)).join('; ')}).`)
    band = found.band
  }
  for (const r of found.reasons) if (!bandReasons.includes(r)) bandReasons.push(r)
}

// ---------- roles: one model per role, set here and nowhere else ----------
const ROLE = {
  explorer:    { agentType: 'automode:explorer',    model: 'haiku',  effort: 'medium', stage: 'Discover' },
  architect:   { agentType: 'automode:architect',   model: 'opus',   effort: 'high',   stage: 'Plan' },
  planner:     { agentType: 'automode:architect',   model: 'sonnet', effort: 'high',   stage: 'Plan' },
  implementer: { agentType: 'automode:implementer', model: 'sonnet', effort: 'high',   stage: 'Build' },
  verifier:    { agentType: 'automode:verifier',    model: 'sonnet', effort: 'medium', stage: 'Verify' },
  reviewer:    { agentType: 'automode:reviewer',    model: 'opus',   effort: 'high',   stage: 'Review' },
}
const trace = []
const notes = []
function note(msg) { notes.push(msg); log(msg) }

// run calls one agent. A null result (skipped agent or terminal API error) gets one retry. Every
// attempt goes into the trace with the artifact hash, so nothing succeeds silently.
async function run(role, prompt, opts) {
  const r = ROLE[role]
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await agent(prompt, { ...opts, agentType: r.agentType, model: r.model, effort: r.effort })
    trace.push({
      workflow_id: workflowId, task_id: taskId, seq: trace.length + 1, stage: opts.phase || r.stage, role,
      model_id: r.model, label: opts.label, status: res === null ? 'null_result' : 'ok',
      retry_reason: attempt > 1 ? 'null_result' : null, schema_version: SCHEMA_VERSION,
      artifact_hash: res === null ? null : fnv1a(res), band, review_policy: reviewPolicy, source_version: sourceVersion,
    })
    if (res !== null) return res
  }
  note(`${opts.label}: the ${role} agent returned no result twice.`)
  return null
}

const GIT_RULES = 'Never commit, push, reset --hard, checkout -- <path>, clean, stash drop, or rm -rf. Leave all changes in the working tree.'
const S = (items) => ({ type: 'array', items })
const STR = { type: 'string' }

// ---------- schemas (version 2: additive to version 1) ----------
const DISCOVERY = {
  type: 'object',
  properties: {
    findings: S({ type: 'object', properties: { where: STR, what: STR, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }, required: ['where', 'what'] }),
    interfaces: S(STR),
    tests: S(STR),
    commands: S(STR),
    constraints: S(STR),
    open_questions: S(STR),
  },
  required: ['findings', 'interfaces', 'tests', 'commands', 'constraints', 'open_questions'],
}
const PLAN = {
  type: 'object',
  properties: {
    summary: STR,
    complexity_check: { type: 'string', enum: TIERS },
    risk_class: { type: 'string', enum: BANDS },
    decisions: S(STR),
    assumptions: S(STR),
    forbidden_changes: S(STR),
    missing_evidence: S(STR),
    evidence_blocking: { type: 'boolean' },
    workstreams: S({
      type: 'object',
      properties: { id: STR, goal: STR, files: S(STR), steps: S(STR), tests: S(STR), depends_on: S(STR) },
      required: ['id', 'goal', 'files', 'steps', 'tests', 'depends_on'],
    }),
    acceptance_criteria: S(STR),
    validation_commands: S(STR),
    risks: S({ type: 'object', properties: { risk: STR, severity: { type: 'string', enum: ['low', 'medium', 'high'] } }, required: ['risk', 'severity'] }),
    review_required: { type: 'boolean' },
  },
  required: ['summary', 'complexity_check', 'risk_class', 'decisions', 'assumptions', 'forbidden_changes', 'missing_evidence', 'evidence_blocking', 'workstreams', 'acceptance_criteria', 'validation_commands', 'risks', 'review_required'],
}
const IMPL = {
  type: 'object',
  properties: {
    id: STR,
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    files_changed: S(STR),
    tests_added: S(STR),
    commands_run: S({ type: 'object', properties: { cmd: STR, outcome: { type: 'string', enum: ['pass', 'fail', 'not_run'] } }, required: ['cmd', 'outcome'] }),
    deviations: S(STR),
    unresolved: S(STR),
    escalation: {
      type: 'object',
      properties: { needed: { type: 'boolean' }, question: STR, evidence: S(STR) },
      required: ['needed', 'question', 'evidence'],
    },
    notes: STR,
  },
  required: ['id', 'status', 'files_changed', 'tests_added', 'commands_run', 'deviations', 'unresolved', 'escalation', 'notes'],
}
const ANSWER = {
  type: 'object',
  properties: { answer: STR, plan_changes: S(STR), stop: { type: 'boolean' }, stop_reason: STR },
  required: ['answer', 'plan_changes', 'stop', 'stop_reason'],
}
const VERIFY = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pass', 'fail', 'partial'] },
    checks: S({
      type: 'object',
      properties: {
        cmd: STR,
        exit_code: { type: ['integer', 'null'] },
        outcome: { type: 'string', enum: ['pass', 'fail', 'skipped', 'pre-existing'] },
        failure_summary: STR,
      },
      required: ['cmd', 'exit_code', 'outcome', 'failure_summary'],
    }),
    fixes_made: S(STR),
    regressions: S(STR),
    remaining_failures: S(STR),
    diff_stat: STR,
  },
  required: ['status', 'checks', 'fixes_made', 'regressions', 'remaining_failures', 'diff_stat'],
}
const REVIEW = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['approve', 'approve_with_notes', 'changes_required'] },
    findings: S({
      type: 'object',
      properties: {
        severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
        area: { type: 'string', enum: ['correctness', 'architecture', 'security', 'api', 'concurrency', 'performance', 'tests', 'other'] },
        file: STR, detail: STR, fix: STR,
      },
      required: ['severity', 'area', 'file', 'detail', 'fix'],
    }),
  },
  required: ['verdict', 'findings'],
}

// verdictFromChecks decides the verification result in code, from the commands and exit codes.
// Any failing check fails the run, whatever the agent's own summary says. No checks means the
// result is unverified, which counts as uncertain.
function verdictFromChecks(v) {
  if (!v) return 'unverified'
  const counted = v.checks.filter((c) => c.outcome !== 'pre-existing')
  if (!counted.length) return 'unverified'
  const failed = counted.some((c) => c.outcome === 'fail' || (Number.isInteger(c.exit_code) && c.exit_code !== 0 && c.outcome !== 'skipped'))
  return failed ? 'fail' : 'pass'
}

// ---------- pre-plan classification from the task text ----------
raiseBand(classifyRisk(task, [], { workstreams: 0, unknowns: 0 }), 'Task text')
if (band === 'S0') mode = 'handoff'

// ---------- Phase A: Discover (Haiku) ----------
const LENSES = {
  code: 'Source only: the files, entry points, and types that the task must use or change, and existing code that does something similar. Do not look at tests or build files.',
  tests: 'Tests and build only: the relevant tests, the test framework and helpers, and the exact build, type-check, lint, and test commands from the manifests, Makefile, or CI config. Do not read application source beyond test targets.',
  constraints: 'Constraints only: dependencies and versions, configuration, conventions, and security-sensitive areas that limit how the task can be done. Do not summarize the code itself.',
}
const DROP_ORDER = ['findings', 'tests', 'commands', 'interfaces', 'open_questions', 'constraints']

// fitDiscovery makes the discovery JSON fit the cap without cutting it mid-string. It shortens
// each string, then drops items in DROP_ORDER (findings first, constraints last), from the
// largest lens first. The result is always valid JSON. `omitted` keeps a pointer to every dropped
// finding, so the architect can read those places itself.
function fitDiscovery(input, cap) {
  const clip = (s) => (typeof s === 'string' && s.length > FINDING_CHAR_CAP ? s.slice(0, FINDING_CHAR_CAP - 3) + '...' : s)
  const fit = {}
  const dropped = {}
  const omitted = []
  for (const [lens, d] of Object.entries(input)) {
    fit[lens] = {}
    dropped[lens] = 0
    for (const [k, v] of Object.entries(d)) {
      fit[lens][k] = Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? clip(x) : { ...x, what: clip(x.what), where: clip(x.where) })) : v
    }
  }
  let text = JSON.stringify(fit)
  for (const key of DROP_ORDER) {
    while (text.length > cap) {
      let best = null
      for (const lens of Object.keys(fit)) {
        const list = fit[lens][key]
        if (Array.isArray(list) && list.length && (!best || list.length > fit[best][key].length)) best = lens
      }
      if (!best) break
      const item = fit[best][key].pop()
      dropped[best] += 1
      omitted.push(key === 'findings' ? { lens: best, kind: key, where: item.where } : { lens: best, kind: key })
      text = JSON.stringify(fit)
    }
  }
  return { text, fit, dropped, omitted }
}

let byLens = {}
let discoveryText = ''
let omittedNote = ''
const explorerPrompt = (lensText, extra) =>
  `Task to support (do not implement it):\n${task}\n\nYour scope: ${lensText}\n${extra || ''}\n` +
  'Search with Grep and Glob first. Read only the lines you cite. Return at most 25 findings, one short line each, with path:line and a confidence.'

async function discover() {
  phase('Discover')
  const lensKeys = band === 'S1' ? ['all'] : Object.keys(LENSES)
  const lensText = (k) => (k === 'all' ? Object.values(LENSES).map((t) => t.split(':')[1]).join(' ') : LENSES[k])
  const results = await parallel(lensKeys.map((k) => () =>
    run('explorer', explorerPrompt(lensText(k)), { phase: 'Discover', label: `discover:${k}`, schema: DISCOVERY })))
  results.forEach((d, i) => { if (d) byLens[lensKeys[i]] = d })
}

function refit() {
  const fitted = fitDiscovery(byLens, DISCOVERY_CHAR_CAP)
  byLens = fitted.fit
  discoveryText = fitted.text
  const lost = Object.entries(fitted.dropped).filter(([, n]) => n > 0)
  omittedNote = ''
  if (lost.length) {
    const pointers = fitted.omitted.filter((o) => o.where).map((o) => o.where)
    omittedNote = `To fit the size limit, ${fitted.omitted.length} items were left out (${lost.map(([l, n]) => `${n} from ${l}`).join(', ')}). ` +
      `Findings left out point at: ${pointers.join(', ') || '(none)'}. Read those places yourself where a decision needs them.\n\n`
    note(`Discovery was over ${DISCOVERY_CHAR_CAP} chars. Left out ${fitted.omitted.length} items; constraints are dropped last.`)
  }
  return fitted
}

if (mode === 'discover') {
  await discover()
  if (!Object.keys(byLens).length) {
    note('Every discovery agent failed. The workflow continues in handoff mode: the architect reads the code itself.')
    mode = 'handoff'
  } else {
    refit()
    const found = Object.values(byLens)
    const files = [...new Set(found.flatMap((d) => d.findings.map((x) => String(x.where).split(':')[0])))]
    const unknowns = found.reduce((n, d) => n + d.open_questions.length, 0)
    raiseBand(classifyRisk(task + '\n' + found.flatMap((d) => d.constraints).join('\n'), files, { workstreams: 0, unknowns }), 'Discovery')
  }
}

// ---------- Phase B: Plan ----------
phase('Plan')
function planPrompt(extraEvidence) {
  const input = mode === 'discover'
    ? `Discovery summaries (JSON, from read-only Haiku agents):\n${discoveryText}\n\n${omittedNote}You may read at most ${ARCHITECT_READS.discover} files.`
    : `No discovery ran. Read the code you need yourself: at most ${ARCHITECT_READS.handoff} files. Find the validation commands in the repository manifests.`
  return `Task:\n${task}\n\nRisk band so far: ${band} (${bandReasons.join('; ')})\nMode: ${mode}\n\n${input}\n\n${extraEvidence || ''}` +
    'Produce the implementation plan. Keep workstreams few, and use more than one only when the parts own different files. ' +
    'List in missing_evidence any fact you need but could not establish, instead of guessing. ' +
    'Set evidence_blocking to true only when a decision in this plan could be wrong without those facts; otherwise the gaps go to the reviewer as notes.'
}
// S0 gets a Sonnet plan. With sonnetPlanSmall on, so does S1 with small, risk-free discovery.
// Anything else, or any doubt, gets Opus.
const discoveredFiles = new Set(Object.values(byLens).flatMap((d) => d.findings.map((x) => String(x.where).split(':')[0])))
const sonnetPlans = band === 'S0' || (!stages.includes('architect') && band === 'S1') || (sonnetPlansSmallS1 && band === 'S1' && mode === 'discover' && discoveredFiles.size > 0 && discoveredFiles.size <= 2 &&
  Object.values(byLens).every((d) => !d.open_questions.length))
let plan = await run(sonnetPlans ? 'planner' : 'architect', planPrompt(), { phase: 'Plan', label: 'plan', schema: PLAN })
if (!plan && !sonnetPlans) {
  note('The Opus architect returned no plan. Sonnet makes the plan instead, and the review becomes mandatory.')
  plan = await run('planner', planPrompt(), { phase: 'Plan', label: 'plan:fallback', schema: PLAN })
  if (plan) bandReasons.push('review mandatory: Opus plan unavailable')
}
if (!plan) return { error: 'automode: no planning call returned a plan. Nothing was changed.', band, discovery: byLens, trace, notes }

// One bounded evidence round: targeted discovery, then one more plan call. Never a loop. It runs
// only for blocking gaps: in the 2026-10-19 light run, non-blocking gaps re-planned on Opus every
// time and were most of V2's extra cost over V1.
let evidenceIncomplete = false
let evidenceNotes = []
if (plan.missing_evidence.length && !plan.evidence_blocking) {
  evidenceNotes = plan.missing_evidence
  note(`The plan lists ${plan.missing_evidence.length} non-blocking open fact(s); they go to the reviewer instead of a re-plan.`)
} else if (plan.missing_evidence.length) {
  if (mode === 'discover') {
    note(`The plan lists ${plan.missing_evidence.length} missing fact(s). One targeted discovery round and one re-plan follow.`)
    const extra = await run('explorer',
      explorerPrompt('Answer only these questions, with path:line evidence:', plan.missing_evidence.map((q, i) => `${i + 1}. ${q}`).join('\n')),
      { phase: 'Discover', label: 'discover:missing-evidence', schema: DISCOVERY })
    if (extra) {
      byLens.missing_evidence = extra
      refit()
      const replan = await run(sonnetPlans ? 'planner' : 'architect', planPrompt('The previous plan asked for evidence. It is now in the "missing_evidence" lens above.\n\n'),
        { phase: 'Plan', label: 'plan:with-evidence', schema: PLAN })
      if (replan) plan = replan
    }
  }
  if (plan.missing_evidence.length && plan.evidence_blocking) {
    evidenceIncomplete = true
    note(`The plan still lists missing evidence: ${plan.missing_evidence.join('; ')}. The run continues and the review becomes mandatory.`)
  }
}

const planFiles = [...new Set(plan.workstreams.flatMap((w) => w.files))]
raiseBand(classifyRisk(task + '\n' + plan.decisions.join('\n'), planFiles, { workstreams: plan.workstreams.length, unknowns: 0 }), 'Plan')
if (BANDS.indexOf(plan.risk_class) > BANDS.indexOf(band)) raiseBand({ band: plan.risk_class, reasons: [`${plan.risk_class}: architect risk class`] }, 'Plan')
const planBrief = JSON.stringify({
  summary: plan.summary, decisions: plan.decisions, assumptions: plan.assumptions, forbidden_changes: plan.forbidden_changes,
  acceptance_criteria: plan.acceptance_criteria, validation_commands: plan.validation_commands, risks: plan.risks,
})

// ---------- Phase C: Build (Sonnet, dependency-ordered) ----------
phase('Build')
const ws = plan.workstreams.length ? plan.workstreams : [{ id: 'main', goal: plan.summary, files: [], steps: plan.decisions, tests: [], depends_on: [] }]
const owners = {}
for (const w of ws) for (const f of w.files) (owners[f] = owners[f] || []).push(w.id)

// knownFacts gives an implementer the discovery findings for the files it owns, plus the shared
// interfaces and commands, so that it does not read again what discovery already read.
function knownFacts(w) {
  const lenses = Object.values(byLens)
  if (!lenses.length) return ''
  const owns = (where) => w.files.some((f) => String(where).split(':')[0].endsWith(f) || f.endsWith(String(where).split(':')[0]))
  const facts = {
    findings: lenses.flatMap((d) => d.findings || []).filter((x) => owns(x.where)),
    interfaces: [...new Set(lenses.flatMap((d) => d.interfaces || []))],
    commands: [...new Set(lenses.flatMap((d) => d.commands || []))],
  }
  return `Facts from discovery (JSON). Trust them, and read a file only when you edit it or a fact is missing:\n${JSON.stringify(facts)}\n\n`
}
const implPrompt = (w, answer) =>
  `You implement workstream "${w.id}" of an approved plan.\n\nOverall task:\n${task}\n\nPlan context (JSON):\n${planBrief}\n\n` +
  knownFacts(w) +
  (answer ? `The architect answered your escalation:\n${JSON.stringify(answer)}\n\n` : '') +
  `Workstream (JSON):\n${JSON.stringify(w)}\n\nFiles you own: ${w.files.join(', ') || '(not listed: keep the change minimal)'}\n` +
  `Files other workstreams own: ${Object.keys(owners).filter((f) => !w.files.includes(f)).join(', ') || '(none)'}. Do not edit those files.\n` +
  'If you hit an incompatible contract, hidden coupling, a security concern, or a question you cannot answer from the code, stop and set escalation.needed with the question and your evidence.\n' +
  GIT_RULES

let escalations = 0
const results = {}   // id -> IMPL result or null
const status = {}    // id -> pending | done | failed | skipped
const stopReasons = {}
for (const w of ws) status[w.id] = 'pending'

async function buildOne(w) {
  let res = await run('implementer', implPrompt(w), { phase: 'Build', label: `build:${w.id}`, schema: IMPL })
  if (res && res.escalation.needed) {
    if (escalations >= MAX_ESCALATIONS) {
      stopReasons[w.id] = `escalation limit (${MAX_ESCALATIONS}) reached: ${res.escalation.question}`
      return { res, ok: false }
    }
    escalations += 1
    note(`Workstream ${w.id} escalated to Opus (${escalations}/${MAX_ESCALATIONS}): ${res.escalation.question}`)
    const answer = await run('architect',
      `Answer one escalation from an implementer. Resolve only this question; do not re-plan the task.\n\nTask:\n${task}\n\nPlan (JSON):\n${planBrief}\n\n` +
      `Workstream (JSON):\n${JSON.stringify(w)}\n\nQuestion: ${res.escalation.question}\nEvidence: ${JSON.stringify(res.escalation.evidence)}\n` +
      'Set stop to true only when the workstream must not continue, and say why.',
      { phase: 'Build', label: `escalate:${w.id}`, schema: ANSWER })
    if (!answer || answer.stop) {
      stopReasons[w.id] = answer ? `architect stopped the workstream: ${answer.stop_reason}` : 'escalation got no answer'
      return { res, ok: false }
    }
    bandReasons.push(`review mandatory: workstream ${w.id} escalated`)
    res = await run('implementer', implPrompt(w, answer), { phase: 'Build', label: `build:${w.id}:after-escalation`, schema: IMPL })
    if (res && res.escalation.needed) {
      stopReasons[w.id] = `escalated again after the answer: ${res.escalation.question}`
      return { res, ok: false }
    }
  }
  if (!res) stopReasons[w.id] = 'implementer returned no result'
  else if (res.status === 'blocked') stopReasons[w.id] = `blocked: ${res.unresolved.join('; ')}`
  return { res, ok: Boolean(res) && res.status !== 'blocked' }
}

if (!useDag) {
  note(`Build: task graph off (ablation). ${ws.length} workstream(s) in plan order.`)
  for (const w of ws) {
    const { res, ok } = await buildOne(w)
    results[w.id] = res
    status[w.id] = ok ? 'done' : 'failed'
  }
} else {
  // Ready-queue scheduler: a workstream runs when all its dependencies are done. Two workstreams
  // that share a file never run at the same time. A failed dependency skips its dependents.
  for (;;) {
    for (const w of ws) {
      if (status[w.id] !== 'pending') continue
      const bad = w.depends_on.find((d) => status[d] === 'failed' || status[d] === 'skipped' || !(d in status))
      if (bad) {
        status[w.id] = 'skipped'
        stopReasons[w.id] = bad in status ? `dependency ${bad} ${status[bad]}` : `unknown dependency ${bad}`
      }
    }
    const ready = ws.filter((w) => status[w.id] === 'pending' && w.depends_on.every((d) => status[d] === 'done'))
    if (!ready.length) {
      for (const w of ws) if (status[w.id] === 'pending') { status[w.id] = 'skipped'; stopReasons[w.id] = 'dependency cycle' }
      break
    }
    const batch = []
    const taken = new Set()
    for (const w of ready) {
      if (batch.length >= maxConcurrency) break
      if (w.files.some((f) => taken.has(f))) continue
      w.files.forEach((f) => taken.add(f))
      batch.push(w)
    }
    if (batch.length > 1) note(`Build: ${batch.map((w) => w.id).join(' and ')} run in parallel; they own different files.`)
    const done = await parallel(batch.map((w) => () => buildOne(w)))
    batch.forEach((w, i) => {
      const r = done[i] || { res: null, ok: false }
      results[w.id] = r.res
      status[w.id] = r.ok ? 'done' : 'failed'
    })
  }
}
const implDone = ws.map((w) => results[w.id]).filter(Boolean)
const changedFiles = [...new Set(implDone.flatMap((r) => r.files_changed))]
if (!changedFiles.length) note('No implementer reported a changed file.')
const buildFailed = ws.some((w) => status[w.id] !== 'done')
raiseBand(classifyRisk('', changedFiles, { workstreams: ws.length, unknowns: 0 }), 'Build')

// ---------- Phase D: Verify (Sonnet, bounded; code decides) ----------
phase('Verify')
let verify = null
let verifyStatus = 'unverified'
const verifyHistory = []
for (let round = 1; round <= MAX_VERIFY_ROUNDS; round++) {
  const prior = verify ? `\n\nThe previous round left these failures:\n${JSON.stringify(verify.remaining_failures)}\nFixes already made: ${JSON.stringify(verify.fixes_made)}` : ''
  verify = await run('verifier',
    `Verify the change for this task:\n${task}\n\nAcceptance criteria (JSON):\n${JSON.stringify(plan.acceptance_criteria)}\n\nChanged files: ${changedFiles.join(', ') || '(use git status)'}\n` +
    `Validation commands: ${plan.validation_commands.join(' ; ') || '(find them in the repository)'}\n` +
    'Report every command you ran with its real exit code. Use outcome "pre-existing" only for a failure you showed exists without this change.\n' +
    `This is verification round ${round} of ${MAX_VERIFY_ROUNDS}.${prior}\n${GIT_RULES}`,
    { phase: 'Verify', label: `verify:${round}`, schema: VERIFY })
  verifyStatus = verdictFromChecks(verify)
  if (verify && verify.status === 'pass' && verifyStatus !== 'pass') note(`Verification round ${round}: the verifier said pass, but its checks say ${verifyStatus}. The checks win.`)
  verifyHistory.push({ round, reported: verify ? verify.status : null, computed: verifyStatus, remaining_failures: verify ? verify.remaining_failures : [] })
  if (!verify) break
  if (verifyStatus === 'pass') break
  if (round === MAX_VERIFY_ROUNDS) note(`Verification is still ${verifyStatus} after ${MAX_VERIFY_ROUNDS} rounds. The workflow stops repairing.`)
}

// ---------- Phase E: Review (Opus, evidence-first) ----------
const highRisk = plan.risks.some((r) => r.severity === 'high')
const mandatory = []
if (BANDS.indexOf(band) >= 2) mandatory.push(`band ${band}`)
if (verifyStatus !== 'pass') mandatory.push(`verification ${verifyStatus}`)
if (buildFailed) mandatory.push('a workstream did not finish')
if (plan.review_required) mandatory.push('architect requested review')
if (highRisk) mandatory.push('high-severity risk in plan')
if (evidenceIncomplete) mandatory.push('plan evidence incomplete')
for (const r of bandReasons) if (r.startsWith('review mandatory')) mandatory.push(r.replace('review mandatory: ', ''))
const needReview = band !== 'S0' ? (reviewPolicy === 'always' || mandatory.length > 0) : mandatory.length > 0
let review = null
let postReviewFix = null
if (!needReview) {
  note(`Opus review skipped: band ${band}, policy ${reviewPolicy}, no mandatory rule applied.`)
} else {
  phase('Review')
  // The reviewer gets the source of truth (task, criteria, raw checks, file list) and reads the
  // diff itself. Implementer self-assessments are left out to avoid anchoring.
  review = await run('reviewer',
    `Independent review of a finished change.\n\nOriginal task:\n${task}\n\nAcceptance criteria (JSON):\n${JSON.stringify(plan.acceptance_criteria)}\n\n` +
    `Forbidden changes (JSON):\n${JSON.stringify(plan.forbidden_changes)}\n\n` +
    (evidenceNotes.length ? `Facts the architect could not establish (check them in the code):\n${JSON.stringify(evidenceNotes)}\n\n` : '') +
    `Risk band: ${band} (${bandReasons.join('; ')})\nWhy review runs: ${mandatory.join('; ') || `policy ${reviewPolicy}`}\n\n` +
    `Verification checks, as run (JSON):\n${JSON.stringify(verify ? verify.checks : [])}\nComputed verification result: ${verifyStatus}\n\n` +
    `Workstreams that did not finish (JSON):\n${JSON.stringify(Object.fromEntries(Object.entries(stopReasons)))}\n\n` +
    `Changed files (read the diff for these yourself): ${changedFiles.join(' ') || '(use git status)'}`,
    { phase: 'Review', label: 'review', schema: REVIEW })
  const blockers = review ? review.findings.filter((f) => f.severity === 'blocker') : []
  if (blockers.length) {
    note(`The reviewer found ${blockers.length} blocker(s). One Sonnet fix pass and one verification pass follow. Opus does not review again.`)
    const fix = await run('implementer',
      `Fix these review blockers. Change nothing else.\n\nTask:\n${task}\n\nBlockers (JSON):\n${JSON.stringify(blockers)}\n${GIT_RULES}`,
      { phase: 'Review', label: 'fix:blockers', schema: IMPL })
    const reverify = await run('verifier',
      `Verify the blocker fixes and run the validation commands again, with real exit codes: ${plan.validation_commands.join(' ; ')}\nBlockers that were fixed (JSON):\n${JSON.stringify(blockers)}\n${GIT_RULES}`,
      { phase: 'Review', label: 'verify:after-review', schema: VERIFY })
    postReviewFix = { fix, verify: reverify, computed: verdictFromChecks(reverify) }
    if (reverify) { verify = reverify; verifyStatus = postReviewFix.computed }
  }
}

// ---------- result ----------
const byModel = {}
for (const t of trace) byModel[t.model_id] = (byModel[t.model_id] || 0) + 1
return {
  profile: 'AutoMode',
  schema_version: SCHEMA_VERSION,
  workflow_id: workflowId,
  task_id: taskId,
  source_version: sourceVersion,
  band,
  band_reasons: bandReasons,
  mode,
  review_policy: reviewPolicy,
  stages,
  plan: { summary: plan.summary, risk_class: plan.risk_class, decisions: plan.decisions, acceptance_criteria: plan.acceptance_criteria, risks: plan.risks, missing_evidence: plan.missing_evidence },
  evidence_incomplete: evidenceIncomplete,
  build: ws.map((w) => ({ id: w.id, status: status[w.id], stop_reason: stopReasons[w.id] || null, result: results[w.id] || null })),
  changed_files: changedFiles,
  verification: { result: verifyStatus, final: verify, rounds: verifyHistory },
  review: review || (needReview ? { verdict: 'agent_failed' } : { verdict: 'skipped' }),
  review_reasons: needReview ? (mandatory.length ? mandatory : [`policy ${reviewPolicy}`]) : [],
  post_review_fix: postReviewFix,
  model_calls: { by_model: byModel },
  trace,
  notes,
  git: 'No commits or pushes. All changes are in the working tree.',
  usage: 'Token usage per stage: run /automode:usage --trace in this session.',
}
