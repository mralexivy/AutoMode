// AutoMode judge router (V3). A function-hooks module: one cheap Haiku call per prompt decides
// the path and the effort before the main model starts. Ideas from effortless (HeyCubit, MIT) are
// rebuilt here in a lean form, without its UI bar, its external judges, or per-prompt model switching.
//
//   prompt.submit   On the AutoMode picker ID, the judge returns { path, effort, why }, given the
//                   last reply, whether a turn is running, and any attachments. A deterministic risk
//                   rule can only raise the path. Only the short instruction for that path is attached.
//                   Named effort ("use max effort") wins over the judge. Short follow-ups reuse the last
//                   verdict. A cold cache on a heavy chat gets a one-line hint to compact first.
//   turn.step       Sets each main-thread request's effort to the verdict. If the person changes effort
//                   themselves, Auto stops for the session: the person always wins. Near a 5-hour or
//                   weekly limit, effort is capped at medium (save mode).
//   session.compact Haiku writes the compaction summary instead of the chat's model.
//   tool.call       Denies git writes and rm -rf from AutoMode subagents.
//
// The model never changes mid-chat: each model keeps its own prompt cache, so a switch rewrites the
// whole chat into a new cache (effortless measured 5-10x the cost). Inactive sessions (any other
// model) pass every event straight through: no judge, no context, no state, no files.
import type { EngineInterface, Register } from 'claude-code'
import { COMPACT_SYSTEM, transcriptOf } from './lib/compact.ts'
import { guardianPromptSubmit, guardianSessionEnd, guardianSessionStart, guardianSnapshot, guardianStep, guardianToolCall, guardianTurnComplete, guardianTurnStart } from './guardian.ts'
import { useV4, v4AgentSpawn, v4Append, v4Attachment, v4Compact, v4PromptSubmit, v4SessionStart, v4Snapshot, v4ToolCall, v4TurnComplete, v4TurnStep } from './v4.ts'
import { setOptions } from './options.ts'
import { setSources } from './ui/publish.ts'
import { registerUi, uiSessionStart } from './ui/register-ui.tsx'

export { COMPACT_SYSTEM, transcriptOf }

type Path = 'chat' | 'change' | 'review' | 'workflow'
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Verdict = { path: Path; effort: Effort; why: string; by: 'judge' | 'follow-up' | 'fallback' | 'user' | 'named' }

const DEFAULTS = {
  router: 'judge',
  pickerModel: 'claude-sonnet-5-5[1m]',
  workflowName: 'automode:run',
  standardMode: 'discover',
  reviewPolicy: 'risk',
  maxConcurrency: 1,
  judgeModel: 'haiku',
  judgeTimeoutMs: 4000,
  fallbackEffort: 'medium' as Effort,
  compactWith: 'haiku',
  compactModel: 'claude-haiku-5-5',
  saveModePercent: 80,
  cacheTtlMinutes: 60,
  heavyChatTokens: 60000,
  debugLog: false,
  blockGitWritesWhenActive: true,
}
type Config = typeof DEFAULTS

const PATHS: readonly Path[] = ['chat', 'change', 'review', 'workflow']
const JUDGE_EFFORTS: readonly Effort[] = ['low', 'medium', 'high']
const ALL_EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

// HIGH_RISK mirrors the S3 task-text rules in workflows/run.js and an external signals writer (a test keeps
// the three identical). Plural forms count: "goroutines" is as risky as "goroutine".
const HIGH_RISK = [
  { reason: 'security or credentials', text: /\b(security (review|fix|issue|vulnerabilit\w+)|cve-\d+|(oauth|auth\w*|login|sso|saml|jwts?|session) (flows?|logic|scopes?|tokens?|middleware|bypass|handling|checks?)|credentials? (handling|storage|rotation|leaks?)|(stor\w*|handl\w*|sav\w*|load\w*) (the |user |api )?credentials?|rotat\w* (the )?(\w+ )?(keys?|secrets?|credentials?|tokens?)|passwords? (hashing|storage|reset)|reset (the |user )?passwords?|(check\w*|enforc\w*|chang\w*) (the |user )?permissions?|verif\w* (the )?signatures?|refresh (the |access )?tokens?|encrypt\w*|decrypt\w*|permission (checks?|model)|rbac|acls?)\b/i },
  { reason: 'data migration or destructive operation', text: /\b((data|schema|database|db) migrations?|migrat\w* (the )?(data|database|schema|users|tables?)|schema changes?|drop (tables?|columns?)|truncat\w* (the )?tables?|backfill\w*|delete (all|the) (data|records|rows))\b/i },
  { reason: 'concurrency', text: /\b(race conditions?|deadlocks?|data races?|thread[- ]safe\w*|concurrent (access|writes?|calls?|requests)|mutex(es)?|from (several|multiple|many) goroutines|goroutines? (leaks?|safety)|lock ordering)\b/i },
  { reason: 'externally visible contract', text: /\b(public apis?|breaking changes?|api contracts?|wire formats?|protocol changes?|sdk interfaces?)\b/i },
  { reason: 'payments or sensitive data', text: /\b(payments?|billing (logic|calculation|code)|invoic\w+|pii|gdpr|personal data)\b/i },
]

// Short replies between steps keep the verdict already given; no judge is asked.
const FOLLOW_UP = /^(go( ahead)?|ok(ay)?|yes( please)?|y|yep|sure|continue|proceed|do it|next|lgtm|sounds good|thanks?|thank you)[.!\s]*$/i

// "use max effort", "effort: low": the person named the level, so no judge picks it. `ultrathink` and "think hard"
// are in-context requests for deeper reasoning (Claude Code's own behavior); they never set the API effort.
const NAMED_EFFORT = /\b(?:(low|medium|high|xhigh|max)(?:imum)? effort|effort[:=]?\s*(low|medium|high|xhigh|max))\b/gi

const BLOCKED = [
  /\bgit\s+(commit|push|merge|rebase|cherry-pick|revert|am|tag)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f/,
  /\bgit\s+checkout\s+(--\s|\.\s*$|-f\b)/,
  /\bgit\s+restore\b(?!.*--staged)/,
  /\bgit\s+stash\s+(drop|clear)\b/,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+worktree\s+remove\b/,
  /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/,
]

export const JUDGE_SYSTEM = `You route one message in a coding assistant session. Pick the cheapest path and effort that still get it right.
Paths:
- chat: questions, explanations, research, and writing that is not saved in the repository (messages, MR text, plans). Editing any file in the repository, docs included, is a change.
- change: a code change with a clear goal (the files, the behavior, or the fix are clear). Sonnet does it alone.
- review: a clear code change that touches security, credentials, data migration, destructive operations, concurrency, a public contract, or payments. Sonnet does it, then Opus reviews it.
- workflow: open-ended work only: no clear spec, a design choice across several modules, or a large refactor. A multi-agent workflow plans it on Opus. It is the most expensive path; never pick it for a clear change, and never for a bug or a failing or flaky test, however hard: that is change with high effort.
Effort:
- low: lookups, renames, short answers, and small mechanical edits in one or two files (a constant, a config value, a typo, an import, a flag). When a small edit is clear, pick low.
- medium: normal features and fixes.
- high: hard debugging, subtle correctness, cross-module reasoning.
A message typed while a turn runs usually steers that task: keep its path unless it starts new work.
Reply with JSON only: {"path":"chat|change|review|workflow","effort":"low|medium|high","why":"at most 8 words"}`

// risksOf matches the risk patterns against the words of the request, not its file names:
// "split auth.go" names a file, it does not change authentication.
export function risksOf(text: string): string[] {
  const words = text.replace(/\S+\.[A-Za-z]{1,5}\b/g, ' ')
  return HIGH_RISK.filter((r) => r.text.test(words)).map((r) => r.reason)
}

// namedEffort returns the level the person named, unless they negated it ("not max effort").
export function namedEffort(text: string): Effort | undefined {
  for (const m of text.matchAll(NAMED_EFFORT)) {
    const before = text.slice(Math.max(0, (m.index ?? 0) - 20), m.index).toLowerCase()
    if (/\b(not|no|don'?t|never|without|instead of)\b/.test(before)) continue
    return (m[1] ?? m[2]).toLowerCase() as Effort
  }
  return undefined
}

// parseVerdict reads the judge's reply. Anything that is not exactly the contract is rejected.
export function parseVerdict(text: string): { path: Path; effort: Effort; why: string } | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0]) as { path?: unknown; effort?: unknown; why?: unknown }
    if (!PATHS.includes(j.path as Path) || !JUDGE_EFFORTS.includes(j.effort as Effort)) return null
    return { path: j.path as Path, effort: j.effort as Effort, why: String(j.why ?? '').slice(0, 80) }
  } catch {
    return null
  }
}

// applyRules raises the judge's verdict with the deterministic risk rule and the review policy.
// It never lowers a verdict, except under reviewPolicy "never", which turns every review into a
// change: everything stays on Sonnet and no Opus review runs.
export function applyRules(v: Verdict, risks: string[], cfg: Config): Verdict {
  if (cfg.reviewPolicy === 'never') return v.path === 'review' ? { ...v, path: 'change' } : v
  let out = v
  if (risks.length && out.path === 'change') out = { ...out, path: 'review', why: `${out.why}; risk: ${risks.join(', ')}` }
  if (cfg.reviewPolicy === 'always' && out.path === 'change') out = { ...out, path: 'review' }
  return out
}

// capEffort applies save mode: at or past the limit share, effort goes no higher than medium.
export function capEffort(effort: Effort, limitPercent: number | null, cfg: Config): Effort {
  if (limitPercent === null || limitPercent < cfg.saveModePercent) return effort
  return ALL_EFFORTS.indexOf(effort) > ALL_EFFORTS.indexOf('medium') ? 'medium' : effort
}

const REVIEW_CALL = 'After your checks pass, call the Agent tool with subagent_type "automode:reviewer" and run_in_background set to false ' +
  '(it runs on Opus; wait for it). Give it the original request, the acceptance criteria you used, each check command with its output, ' +
  'and the changed files. Fix every blocker it reports, run the checks again, and do not call the reviewer a second time. Do not act on non-blocking notes; list them in your reply.'

export function contextFor(v: Verdict, cfg: Config, risks: string[], sourceVersion: string): string | null {
  const head = `[AutoMode: ${v.path}, effort ${v.effort}${v.why ? ` (${v.why})` : ''}]`
  const checks = 'Do it yourself and read only the code you need. Before you call it done, run the relevant tests or build and show that they pass. Never report a change as done without a passing check.'
  const commit = 'Commit or push only when the user asks you to.'
  switch (v.path) {
    case 'chat':
      return null
    case 'change':
      return `${head}\n${checks}\n${commit}`
    case 'review':
      return `${head}\n${checks}\n${REVIEW_CALL}\n${commit}`
    case 'workflow': {
      const tier = risks.length ? 'critical' : 'complex'
      const call = `Workflow({ name: "${cfg.workflowName}", args: { task: "<the full task with every constraint>", tier: "${tier}", mode: "${cfg.standardMode}", ` +
        `reviewPolicy: "${cfg.reviewPolicy}", maxConcurrency: ${Number(cfg.maxConcurrency) || 1}, source_version: "${sourceVersion}" } })`
      return `${head}\nThis is open-ended work. Run ${call}\nUntil it returns, do not implement it yourself. Then report the changed files, the verification, the review findings, and open risks.\n${commit}`
    }
  }
}

// cacheSafe: on the 5.5 models an effort change between requests keeps the prompt cache.
const cacheSafe = (model: string) => /(sonnet|opus)-5-5/.test(model)

// Module state. A reload starts it over, which only means the next prompt is judged again.
let cfg: Config = DEFAULTS
let sourceVersion = 'unknown'
let current: Verdict | null = null
let loaded = false
let autoEffort = true          // false once the person changes effort themselves
let appEffort: string | undefined // the app's own effort setting, as the last request carried it
let toldJudgeDown = false
let toldSaveMode = false
let lastAnswerAt: number | null = null
let lastAnswerText = ''
let coldHintAt = 0

// load reads the plugin's config.json. It runs at session.start and, after a reload that missed
// session.start, on first use: a module on built-in defaults must never route beside the classic hook.
async function load($: EngineInterface) {
  loaded = true
  try { cfg = { ...DEFAULTS, ...JSON.parse(await $.fs.read(`${$.plugin.root}/config.json`)) } } catch { cfg = DEFAULTS }
  try { sourceVersion = JSON.parse(await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`)).version || 'unknown' } catch {}
}

async function active($: EngineInterface) {
  if (!loaded) await load($)
  if (cfg.router !== 'judge') return false
  try { return (await $.session.model()).trim() === cfg.pickerModel } catch { return false }
}

// debug appends one JSON line to the plugin's own folder, only with debugLog on.
async function debug($: EngineInterface, entry: Record<string, unknown>) {
  if (!cfg.debugLog) return
  const file = `${$.plugin.root}/judge-log.jsonl`
  try {
    let before = ''
    try { before = await $.fs.read(file) } catch {}
    await $.fs.write(file, before + JSON.stringify({ at: await $.clock.now(), ...entry }) + '\n')
  } catch {}
}

// limitShare is the highest 5-hour or weekly limit share the last response reported, or null.
async function limitShare($: EngineInterface): Promise<number | null> {
  try {
    const shares = (await $.session.usage()).rateLimits.map((r) => r.percentUsed).filter((n) => Number.isFinite(n))
    return shares.length ? Math.max(...shares) : null
  } catch { return null }
}

// coldHint returns a one-line hint when the cache went cold on a heavy chat and no agent is
// still running (a compaction then would lose their answers), at most once per cold spell.
async function coldHint($: EngineInterface): Promise<string | null> {
  if (lastAnswerAt === null) return null
  try {
    const now = await $.clock.now()
    const idleMin = (now - lastAnswerAt) / 60000
    if (idleMin < cfg.cacheTtlMinutes || coldHintAt > lastAnswerAt) return null
    const usage = await $.session.usage()
    const tokens = usage.context.tokens ?? 0
    if (tokens < cfg.heavyChatTokens) return null
    const live = (await $.agent.list()).filter((a) => a.status === 'pending' || a.status === 'running' || a.status === 'waiting')
    if (live.length) return null
    coldHintAt = now
    return `AutoMode: the prompt cache went cold (${Math.round(idleMin)} min idle), so this message re-writes about ${Math.round(tokens / 1000)}k tokens. Next time, /compact before a long break.`
  } catch { return null }
}

// The classic router's prompt decision (router v4 hands the prompt to v4PromptSubmit).
async function routePrompt($: EngineInterface, e: any, next: any) {
  if (await useV4($)) return v4PromptSubmit($, e, next)
  const text = e.text.trim()
  const byPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'
  if (!byPerson || e.command || e.isMeta || text.startsWith('/') || text.startsWith('!')) return next(e)
  if (!(await active($))) return next(e)

  const hint = await coldHint($)
  if (hint) $.ui.toast(hint)

  const risks = risksOf(text)
  const named = namedEffort(text)
  const midTurn = e.turnId !== undefined
  const attachments = e.attachments?.length ?? 0
  let v: Verdict
  if (/^am:direct\b/i.test(text)) v = { path: 'change', effort: named ?? cfg.fallbackEffort, why: 'user asked: direct', by: 'user' }
  else if (/^am:run\b/i.test(text)) v = { path: 'workflow', effort: named ?? 'high', why: 'user asked: workflow', by: 'user' }
  else if (current && !attachments && FOLLOW_UP.test(text)) v = { ...current, by: 'follow-up' }
  else {
    const recent = lastAnswerText ? `Last reply (start): ${lastAnswerText.slice(0, 600)}\n` : ''
    const state = `${current ? `Previous verdict: ${current.path}, ${current.effort}.\n` : ''}${midTurn ? 'Typed while a turn is running.\n' : ''}${attachments ? `With ${attachments} attachment(s), such as a screenshot.\n` : ''}`
    const asked = `${recent}${state}Message:\n${text.slice(0, 4000)}`
    const r = await $.model.complete({ model: cfg.judgeModel, system: JUDGE_SYSTEM, prompt: asked, maxTokens: 120, effort: 'low', timeoutMs: cfg.judgeTimeoutMs })
    const parsed = r.isAnswered ? parseVerdict(r.text) : null
    if (parsed) v = { ...parsed, by: 'judge' }
    else {
      v = { path: 'change', effort: cfg.fallbackEffort, why: 'judge unavailable', by: 'fallback' }
      if (!toldJudgeDown) {
        toldJudgeDown = true
        $.ui.toast(`AutoMode: the Haiku judge did not answer (${r.isAnswered ? 'unreadable reply' : 'reason' in r ? r.reason : 'no answer'}). Prompts run on Sonnet at ${cfg.fallbackEffort} effort until it does.`)
      }
    }
    if (named) v = { ...v, effort: named, by: 'named' }
    await debug($, { ev: 'judge', ok: Boolean(parsed), reply: r.isAnswered ? r.text.slice(0, 200) : null, usage: r.isAnswered ? r.usage : null })
  }
  if (v.by !== 'user') v = applyRules(v, risks, cfg)
  const capped = capEffort(v.effort, await limitShare($), cfg)
  if (capped !== v.effort) {
    if (!toldSaveMode) { toldSaveMode = true; $.ui.toast(`AutoMode save mode: a usage limit is past ${cfg.saveModePercent}%, so effort is capped at medium.`) }
    v = { ...v, effort: capped }
  }
  current = v
  $.ui.status(`AutoMode: ${v.path} · ${autoEffort ? v.effort : 'your effort'}`)
  await debug($, { ev: 'verdict', path: v.path, effort: v.effort, why: v.why, by: v.by, risks, midTurn, attachments })

  const context = contextFor(v, cfg, risks, sourceVersion)
  return next(context ? { ...e, context: [...(e.context ?? []), context] } : e)
} // a failing judge never blocks a prompt: the registration falls through on any error

export const register: Register = (on, options) => {
  // userConfig (the settings panel's persistent values) for this load; a change reloads the module with new options.
  setOptions(options)
  setSources({ router: v4Snapshot, guardian: guardianSnapshot })
  on('session.start', async ($, e, next) => guardianSessionStart($, e, async (e2: any) => {
    await load($)
    return (await useV4($)) ? v4SessionStart($, e2, next) : next(e2)
  }).then(async (res: any) => { await uiSessionStart($); return res }))

  // The guardian sees each prompt first (a handoff, am:continue), then the router decides the route.
  on('prompt.submit', async ($, e, next) => guardianPromptSubmit($, e, (e2: any) => routePrompt($, e2, next))).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    try { await guardianStep($, e) } catch {} // the guardian counts the request; it never blocks one
    if (await useV4($)) return yield* v4TurnStep($, e, next)
    if (e.agentId !== undefined || !(await active($))) return yield* next(e)
    // The app's setting rides on every request. A change we did not make is the person's own: from
    // then on their effort stands for this session.
    if (typeof e.effort === 'string') {
      if (appEffort !== undefined && e.effort !== appEffort && autoEffort) {
        autoEffort = false
        $.ui.toast(`AutoMode: you set effort to ${e.effort}, so Auto effort is off for this session.`)
      }
      appEffort = e.effort
    }
    const effort = autoEffort && current && cacheSafe(e.model) && e.effort !== undefined ? current.effort : undefined
    const answer = yield* next(effort ? { ...e, effort } : e)
    try { lastAnswerAt = await $.clock.now() } catch {}
    if (answer?.answer) lastAnswerText = answer.answer
    return answer
  })

  on('session.compact', async ($, e, next) => {
    if (await useV4($)) return v4Compact($, e, next)
    if (e.agentId !== undefined || cfg.compactWith !== 'haiku' || !(await active($))) return next(e)
    // Summaries computed ahead of time would be written by the chat's model and then not used.
    if (e.trigger === 'precompute') return { skip: 'AutoMode compacts with Haiku when it is time' }
    const messages = Array.isArray(e.messages) && e.messages.length ? e.messages : await $.session.messages().catch(() => [])
    const transcript = transcriptOf(messages)
    const r = await $.model.complete({
      model: cfg.compactModel, system: COMPACT_SYSTEM, maxTokens: 16000, effort: 'medium', timeoutMs: 240000,
      prompt: `${transcript}\n\n---\nWrite the summary now.${e.instructions?.trim() ? `\nThe user asked the summary to keep or stress: ${e.instructions.trim()}` : ''}`,
    }).catch(() => null)
    if (!r || !r.isAnswered || r.text.trim().length < 200) {
      $.ui.toast("AutoMode: Haiku could not write the summary, so the chat's own model compacts.")
      return next(e)
    }
    await debug($, { ev: 'compact', chars: transcript.length, usage: r.usage })
    return {
      messages: [{
        role: 'user' as const,
        text: `This session continues from an earlier conversation that ran out of context. The summary below, written by Haiku for AutoMode, covers it.\n\n${r.text.trim()}\n\nContinue from where it left off without asking the user further questions.`,
        toolUses: [],
      }],
    }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (await useV4($)) return v4ToolCall($, e, next)
    if (!cfg.blockGitWritesWhenActive || e.agentId === undefined) return next(e)
    if (!(await active($))) return next(e)
    if (!BLOCKED.some((re) => re.test(e.command))) return next(e)
    return { deny: 'AutoMode agents do not run git writes or destructive commands. Leave the changes in the working tree for the user to review.' }
  }).catch(($, e, next) => next(e))

  // V4 only: completions, spawns, worker tools, and the guards on every other tool.
  on('turn.complete', async ($, e, next) => guardianTurnComplete($, e, async (e2: any) => ((await useV4($)) ? v4TurnComplete($, e2, next) : next(e2)))).catch(($, e, next) => next(e))
  on('agent.spawn', async ($, e, next) => ((await useV4($)) ? v4AgentSpawn($, e, next) : next(e))).catch(($, e, next) => next(e))
  on('prompt.attachment', async ($, e, next) => ((await useV4($)) ? v4Attachment($, e, next) : next(e))).catch(($, e, next) => next(e))
  on('session.append', async ($, e, next) => ((await useV4($)) ? v4Append($, e, next) : next(e))).catch(($, e, next) => next(e))
  for (const tool of ['Agent', 'Read', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch']) {
    on('tool.call', { tool }, async ($, e, next) => ((await useV4($)) ? v4ToolCall($, e, next) : next(e)))
      .catch(($, e, next) => (next.called ? next(e) : { deny: 'AutoMode guard failed; the call was not run.' }))
  }

  // Session and cost guardian (hooks/guardian.ts): its own hooks, each falling through to the engine on any error.
  // Off with AUTOMODE_GUARDIAN=off or config.json "guardian": { "mode": "off" }; the router above is unaffected.
  on('session.end', ($, e, next) => guardianSessionEnd($, e, next)).catch(($, e, next) => next(e))
  // The presentation layer (hooks/ui): drawings, the /automode command and the controls. It reads the view atom only.
  registerUi(on)
  on('turn.start', ($, e, next) => guardianTurnStart($, e, next)).catch(($, e, next) => next(e))
  on('tool.call', ($, e, next) => guardianToolCall($, e, next)).catch(($, e, next) => (next.called ? { deny: 'AutoMode guardian failed after the call; its result is lost. Run it again if needed.' } : next(e)))
}
