// AutoMode V4: a quality-first, context-aware execution router. Active only with `router: "v4"` in
// config.json and the AutoMode picker row. Every decision comes from the pure modules in ./lib;
// this file only moves values between the engine and them.
//
// Modes (config `mode`, kill switch AUTOMODE_ROUTER=off):
//   off     every hook passes through.
//   shadow  zero interference: no context, no tools, no rewrites, no redirects. Each request is
//           recorded as the app sent it; after each turn the router records what it would have done.
//   auto    the router applies its decisions: model and effort per request (policy `legacy`: the interval
//           optimizer in lib/optimizer.ts; policy `auto`: the effortless judge per model, ported verbatim in
//           lib/effortless.ts, joined with the AutoMode judge in lib/auto.ts), the task envelope,
//           supported delegation, the Explore redirect, read-only guards, escalation or an Opus
//           consult, plan-mode demand, and Haiku compaction. Every request is recorded.
//
// User tier: the engine skips prompt.attachment, session.compact, and the compaction rows of session.append
// for a user-installed plugin (cc-plugin-sec-default). an external signals writer writes plan mode and compactions to
// a signals file; syncSignals reads it. Only the Haiku summary stays lost.
import type { EngineInterface } from 'claude-code'
import type { CacheState, Complexity, EffectiveRoute, Effort, Family, Floor, Mode, Owner, Risk, Route, Strategy, TaskEnvelope, Tier, TokenUsage } from './lib/types.ts'
import { EFFORTS, maxRisk, tierRank } from './lib/types.ts'
import { ANTHROPIC, familyOf, rowFor, usageUsd } from './lib/prices.ts'
import { isTask, JUDGE_SYSTEM, JUDGE_SYSTEM_V3, JUDGE_SYSTEM_V4, judgePrompt, parseJudge, parseOverride, type JudgeAnswer } from './lib/classify.ts'
import { transitionOf } from './lib/transition.ts'
import { classifyError, sanitizeDetail, UNCLASSIFIED } from './lib/errors.ts'
import { stageOf, type Stage } from './lib/stage.ts'
import { BAND_OF, bandOf, demandBand, TIER_BAND } from './lib/bands.ts'
import { interfaceChanges, observedRisk, prospectiveRisk } from './lib/risk.ts'
import { textConsequence } from './lib/consequence.ts'
import { DEFAULT_PARAMS, remainingFor } from './lib/policy.ts'
import { DEFAULT_LADDER, resolve, routeFor } from './lib/authority.ts'
import { choose, consultOrSwitch, workFromFiles, type StrategyChoice } from './lib/strategy.ts'
import { compactInstructions, injection, isBoundary, newEnvelope, observe, summaryOf, withReview } from './lib/envelope.ts'
import { checkPassed, escalation, evidencePacket, failureOf, fnv1a, isCheck, markFlaky, withPipefail } from './lib/failures.ts'
import { guardTool, READ_ONLY_AGENTS, subagentBlocked } from './lib/guard.ts'
import { BUDGET_STOP, clampGrep, clampRead, diagnosePrompt, DISCOVERY_REPORT, HAIKU_BUDGET, priorCoverage, validateReport } from './lib/workers.ts'
import { decisionRecord, needRecord, nextSignal, outcomeRecord, requestRecord, shouldRotate, type NeedRecord } from './lib/records.ts'
import { adequacy, attemptCost, CAPABILITY, DEFAULT_PRIORS, demandOf, FLOOR_CAPABILITY, mid, optimize, TASK_STEPS, tierOf, type Choice, type Demand, type Priors } from './lib/optimizer.ts'
import { trigger, type Trigger } from './lib/triggers.ts'
import { stagesFor } from './lib/stages.ts'
import { subagentRoute } from './lib/subagents.ts'
import { effortFor, helperEffort, takesEffort, looksLikeRedo, maxEffort, midTurnNote, REDO_STAY_PROMPTS, thinkingOf } from './lib/effort.ts'
import { effortSharesCache, modeOf, providerOf, thinkingRisk, ttlMs, type ProviderEnv } from './lib/mode.ts'
import { bounded, helperFloor, helperQuestion, JUDGE_CALL, JUDGE_SYSTEM as EFFORTLESS_SYSTEM, keepsEffort, parseVerdict } from './lib/effortless.ts'
import { contextOf, judgeInputFor, NEED_ANCHOR } from './lib/effortless-adapt.ts'
import { decisionRequired, escalationTarget, fallbackEffort, fallbackModel, firstCalls, legalEffort, optimizeAuto, ownEffort, runningRuledOut, secondCall, shortcutApplies, type AutoChoice, type AutoFloors, type FamilyVerdict } from './lib/auto.ts'
import { COMPACT_SYSTEM, transcriptOf } from './lib/compact.ts'
import { routerOverrides } from './lib/settings.ts'
import { currentOptions, storedOptions } from './options.ts'
import { publish } from './ui/publish.ts'
import type { AgentSnap, Ledger, RouterSnap } from './ui/view.ts'
import { sid, fsRead, sessionModel, fsWrite } from './lib/io.ts'

const V4_DEFAULTS = {
  router: 'classic', mode: 'shadow' as Mode, activation: 'always' as 'always' | 'picker', pickerModel: 'claude-sonnet-5-5[1m]', workflowName: 'automode:run',
  standardMode: 'discover', reviewPolicy: 'risk', maxConcurrency: 1, judgeModel: 'haiku', judgeVersion: 2, judgeTimeoutMs: 8000,
  compactWith: 'haiku', compactModel: 'claude-haiku-5-5', redirectExplore: true, workerTools: true, workerDeadlineMs: 180_000,
  // Opt-in: route built-in subagents (lib/subagents.ts) in every session, not only while AutoMode is the model. Needs no
  // judge. bench/retro-replay.mts measures what this saves on your own transcripts.
  subagentsEverySession: false,
  blockGitWritesWhenActive: true, recordDecisions: true, signals: true,
  // Decision semantics. `legacy` is the interval optimizer; `auto` is AutoMode Auto (lib/auto.ts: the effortless
  // judge per model and the AutoMode judge, one joint choice). Under `auto` the legacy route is recorded beside it,
  // never applied. AUTOMODE_POLICY overrides this. Any other value (the retired `v4.1` too) runs `legacy`.
  policy: 'legacy',
  // Policy auto: false keeps the app's model and routes the effort only (benchmark arm 4, a safe first rollout).
  routeModels: true,
  effortJudgeTimeoutMs: JUDGE_CALL.timeoutMs,
}
type V4Config = typeof V4_DEFAULTS

// Provider errors (lib/errors.ts). The turn.step result carries no error class; Claude Code's StopFailure hook does, and
// an external signals writer writes it to the signals file. A no-response request is counted at once as an unclassified
// failure (three in a row open a breaker for five minutes), and corrected when the class arrives: a cancel, a
// credentials problem, an output limit or a context overflow is not the model's fault and is undone; a rate limit,
// overload or server error keeps a short cooldown; model_not_found opens at once for 30 minutes. A turn that ends
// `aborted` undoes the failure it counted. The breaker is scoped to provider and model, bounded and reversible.
const BREAKER_FAILURES = UNCLASSIFIED.kind === 'breaker' ? UNCLASSIFIED.threshold : 3
const BREAKER_COOLDOWN_MS = UNCLASSIFIED.kind === 'breaker' ? UNCLASSIFIED.cooldownMs : 300_000
const ERROR_MATCH_MS = 60_000 // a StopFailure word belongs to a no-response request at most this long before it


const emptyLedger = (): Ledger => ({ requests: 0, byModel: {}, cacheRead: 0, cacheWrite: 0, judgeUsd: 0, judgeCalls: 0, subagentUsd: 0 })

// Module state, one session per process. A reload starts it over; the next prompt re-derives it.
const S = {
  cfg: V4_DEFAULTS as V4Config, loaded: false, mode: 'off' as Mode, provider: 'anthropic', effortShared: true, ttl: 300_000,
  current: null as Route | null, pending: null as EffectiveRoute | null, envelope: null as TaskEnvelope | null,
  lastSummary: '', resetPending: true, votes: { tier: null as Tier | null, n: 0 },
  requestsSinceSwitch: 0, verifiedSinceSwitch: false, cache: null as CacheState | null,
  lastReply: '', lastPromptText: '', turnPrompt: new Map<string, { text: string; at: number }>(),
  workers: new Map<string, { type: string; tokens: number; stop: boolean; validate?: boolean }>(),
  lastCheck: null as null | { command: string; passed: boolean },
  editedSinceCheck: false, records: [] as unknown[], toldJudgeDown: false, taskSeq: 0,
  lastOutcome: null as null | { turnId: string; taskId: string },
  sessionId: 'unknown', restored: false, expectWorker: 0,
  // Per-model warm cache (effortless markWarm): until when each model's prefix stays cached, and at which effort.
  warm: {} as Partial<Record<Family, { effort: Effort | null; until: number; prefixTokens: number }>>,
  turnRequests: new Map<string, number>(), // main requests per turn, for outcome records
  stayUp: 0, redoFloor: null as Tier | null, // effortless stay-up after a redo
  heldRoute: null as EffectiveRoute | null,   // a lower route picked mid-turn waits for the turn to end
  planMode: false, planExited: false,
  editLog: [] as { path: string; at: number }[],
  agents: new Map<string, { type: string; effort?: Effort; routed: boolean; judged?: boolean }>(), // every subagent seen, for the ledger
  // Provider errors are scoped to provider and model, and bounded: a model that did not answer BREAKER_FAILURES requests in
  // a row (and was not interrupted by the person) is skipped for BREAKER_COOLDOWN_MS, then tried again.
  breakers: {} as Record<string, { failures: number; openUntil: number; turnId?: string; lastAt?: number; threshold?: number; cooldownMs?: number; class?: string }>,
  lastNoResponse: null as null | { key: string; turnId?: string; at: number },
  failures: [] as { key: string; model: string; at: number; turnId?: string; cls: string; effortOnly?: boolean }[], // recent no-response requests, awaiting a class
  pendingErrors: [] as { at: number; error: string; detail: string }[], // StopFailure words not yet matched to a request
  signalErrorAt: 0,
  signalMode: '',
  compactionPricedAt: 0,          // the compaction a prompt's own decision already priced: its trigger does not route again
  haikuOutUntilCompaction: false, // a context overflow on Haiku: Haiku is skipped until the next compaction
  thinkingRisk: false,        // the configured thinking mode may reject a per-message effort change (lib/mode.ts)
  effortUnsupported: false,   // an invalid_request after a rewrite: effort changes are not sent for the rest of the session
  toldErrorClass: '',
  toldBreaker: false,
  inadequate: null as null | { need: number; shortfall: number; route: string }, // the running route is below the need (policy auto)
  toldInadequateTask: '',
  policy: 'legacy' as 'legacy' | 'auto',
  // Policy auto (lib/auto.ts).
  penv: {} as ProviderEnv,     // provider environment: the effort cache rule is decided per model
  lastAuto: null as null | { verdicts: Partial<Record<Family, FamilyVerdict | null>>; need: FamilyVerdict | null; hm: { tier: Tier; complexity: Complexity } | null; taskId: string },
  verdictCache: {} as Record<string, { verdicts: Partial<Record<Family, FamilyVerdict | null>>; answer: JudgeAnswer | null }>, // unchanged task state: the same verdicts
  taskDecision: null as null | { taskId: string; family: Family; effort: Effort }, // the unfinished task's last judged route, for "continue"
  decidedPlanMode: false,     // the plan mode the last decision saw
  lastRisk: 'none' as Risk,
  newInput: false,            // the next main request carries new input: a message typed mid-turn, or a note this mod added
  lastEffective: null as Effort | null, // the effort in effect at the API (per-message changes wait for new input)
  appEffort: undefined as Effort | undefined, // the effort the app itself asks for on main requests
  appModel: undefined as string | undefined, // the model the app itself asks for on main requests
  sessionModel: undefined as string | undefined, // the session's model before the first request
  pinFamily: undefined as Family | undefined, // set by /model: routing keeps this model until am:reset
  pinEffort: undefined as Effort | undefined, // set by /effort: routing keeps this effort until am:reset
  judgeRiskTask: undefined as string | undefined, // the task whose risk a failed judge raised, until a judge answers
  toldPolicy: false,
  judgeBreaker: {} as Partial<Record<'effortless' | 'automode', { failures: number; until: number }>>,
  cwd: undefined as string | undefined, // the session's working directory, for the per-project first-request size
  prefixSource: null as null | 'preflight (calibrated)' | 'project median' | 'machine p75' | 'preflight (lower bound)',
  preflight: undefined as number | null | undefined, // the first request's raw size from the composed prompt and tools; undefined until computed
  prefixEstimate: null as number | null, // the median first-request prompt size of earlier sessions, measured
  firstPrefixSaved: false,
  consulted: [] as string[], // failure fingerprints an Opus consult already answered: the next repeat switches
  consultCounts: {} as Record<string, number>, // failures of that fingerprint when the consult ran
  resolvedCounts: {} as Record<string, number>, // policy auto: failures of that fingerprint when its command passed again
  switchesThisTask: 0,        // discretionary model switches in this task (anti-oscillation)
  lastDemand: null as Demand | null, // the demand the last judgment gave; triggers re-optimize on it
  stage: 'implement' as 'plan' | 'implement',
  lastWorkBand: undefined as number | undefined, // the band of the last real work, kept through a challenge so a second one keeps its floor
  workStage: 'implement' as Stage, // what the agent is doing now (lib/stage.ts); recorded and shown, and it shapes plan and challenge routes
  verifiedAfterPlan: false, judgedThisStage: false, compactedPending: false, requestsInPrompt: 0,
  basePrefixMeasured: false,
  lastMessageCount: 0,
  basePrefix: 0, // tokens that stay cached across a compaction (system prompt and tools), measured per session
  compactedAt: 0,
  // User tier: the signals file (external) stands in for hooks the engine skips.
  signalsOn: true, signalSeq: 0, signalCompactAt: 0, compactHookSeen: false, toldUserTier: false,
  upgradeVotesFor(tier: Tier): number { this.votes = this.votes.tier === tier ? { tier, n: this.votes.n + 1 } : { tier, n: 1 }; return this.votes.n },
  priors: DEFAULT_PRIORS as Priors,
  providerGuard: false, toldGuard: false,
  // The bar's mode selector (hooks/ui): this session only, never written to config. loadV4 applies it over config.json
  // and userConfig and under AUTOMODE_ROUTER; it is in the snapshot, so a settings reload keeps it.
  sessionMode: null as Mode | null,
  // The request ledger for the UI: running sums of the prices pushRequest and the judges already compute.
  ledger: emptyLedger(),
}

// What the UI shows that routing itself does not keep (hooks/ui/view.ts RouterSnap). Written where the state already
// changes and read only by v4Snapshot; nothing here feeds a routing decision.
const U = {
  killed: false, configMode: 'off' as Mode, judging: false, deferred: null as Effort | null,
  verdict: null as RouterSnap['verdict'], candidates: [] as RouterSnap['candidates'],
  agents: new Map<string, AgentSnap>(),
}
const resetU = () => { U.judging = false; U.deferred = null; U.verdict = null; U.candidates = []; U.agents.clear() }

async function loadV4($: EngineInterface) {
  S.loaded = true
  try { S.cfg = { ...V4_DEFAULTS, ...JSON.parse(await fsRead($, `${$.plugin.root}/config.json`)) } } catch { S.cfg = V4_DEFAULTS }
  // Settings from the UI (userConfig, lib/settings.ts) sit over config.json; the environment still wins below.
  S.cfg = { ...S.cfg, ...routerOverrides(currentOptions(), storedOptions()) } as V4Config
  const safe = async (p: Promise<string | undefined>) => { try { return await p } catch { return undefined } }
  const routerEnv = await safe($.env.get('AUTOMODE_ROUTER'))
  U.killed = ['off', '0', 'false'].includes(String(routerEnv ?? '').trim().toLowerCase())
  U.configMode = S.cfg.router === 'v4' ? modeOf(S.cfg, { AUTOMODE_ROUTER: routerEnv }) : 'off'
  S.mode = S.cfg.router === 'v4' ? modeOf(S.sessionMode ? { ...S.cfg, mode: S.sessionMode } : S.cfg, { AUTOMODE_ROUTER: routerEnv }) : 'off'
  const penv = {
    CLAUDE_CODE_USE_VERTEX: await safe($.env.get('CLAUDE_CODE_USE_VERTEX')), CLAUDE_CODE_USE_BEDROCK: await safe($.env.get('CLAUDE_CODE_USE_BEDROCK')),
    CLAUDE_CODE_USE_FOUNDRY: await safe($.env.get('CLAUDE_CODE_USE_FOUNDRY')), ANTHROPIC_BASE_URL: await safe($.env.get('ANTHROPIC_BASE_URL')),
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: await safe($.env.get('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS')),
  }
  S.provider = providerOf(penv)
  const signalsEnv = String((await safe($.env.get('AUTOMODE_SIGNALS'))) ?? '').trim().toLowerCase()
  S.signalsOn = (S.cfg as any).signals !== false && !['off', '0', 'false'].includes(signalsEnv)
  // Provider guard: auto mode is verified on the Anthropic API and Claude subscriptions only. Elsewhere
  // (Vertex, Bedrock, Foundry, gateways) effort and model switches touch unverified cache behavior, so the
  // router observes (shadow) unless the config opts in with allowUnverifiedProviders.
  S.providerGuard = S.mode === 'auto' && S.provider !== 'anthropic' && !(S.cfg as any).allowUnverifiedProviders
  if (S.providerGuard) S.mode = 'shadow'
  S.penv = penv
  S.effortShared = effortSharesCache(penv, 'claude-sonnet-5-5') // the session-level value in records; requests use effortSharedFor(model)
  const onPlan = !(await safe($.env.get('ANTHROPIC_API_KEY')))
  S.ttl = ttlMs({ CLAUDE_CODE_PROMPT_CACHE_TTL: await safe($.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')), FORCE_PROMPT_CACHING_5M: await safe($.env.get('FORCE_PROMPT_CACHING_5M')), ENABLE_PROMPT_CACHING_1H: await safe($.env.get('ENABLE_PROMPT_CACHING_1H')) }, S.provider, onPlan)
  S.priors = await loadPriors($)
  const policyEnv = String((await safe($.env.get('AUTOMODE_POLICY'))) ?? '').trim().toLowerCase()
  const wanted = policyEnv || String((S.cfg as { policy?: string }).policy ?? 'legacy').trim().toLowerCase()
  S.policy = wanted === 'auto' ? 'auto' : 'legacy'
  if (wanted !== 'auto' && wanted !== 'legacy' && !S.toldPolicy) {
    S.toldPolicy = true
    S.records.push({ v: 1, kind: 'policy-note', at: Date.now(), sessionId: S.sessionId, asked: wanted.slice(0, 20), running: 'legacy', why: wanted === 'v4.1' ? 'v4.1 was replaced by auto' : 'unknown policy' })
    try { $.ui.toast(`AutoMode: policy "${wanted.slice(0, 20)}" is not available${wanted === 'v4.1' ? ' (replaced by "auto")' : ''}; running "legacy".`) } catch {}
  }
  S.prefixEstimate = await loadPrefixEstimate($)
  // Thinking guard: read what Claude Code is configured with (never the request, which the mod cannot see).
  let settings: unknown = {}
  try {
    const home = (await safe($.env.get('CLAUDE_CONFIG_DIR'))) || `${await safe($.env.get('HOME'))}/.claude`
    settings = JSON.parse(await fsRead($, `${home}/settings.json`))
  } catch { /* no readable settings: no signal */ }
  S.thinkingRisk = thinkingRisk({ MAX_THINKING_TOKENS: await safe($.env.get('MAX_THINKING_TOKENS')), AUTOMODE_THINKING_GUARD: await safe($.env.get('AUTOMODE_THINKING_GUARD')) }, settings)
}

// First-request prompt size. An unknown prefix is not zero: the system prompt, tools and skills of a real session
// are tens of thousands of tokens (measured: 81k and 212k at the first request, past Haiku's limit). The size of the
// first request of each earlier session is kept in the data folder; its median is the estimate. No file, no estimate:
// the router then does not pick Haiku for the first prompt.
// The size depends on the project (its CLAUDE.md, skills and MCP servers), so the sizes are kept per project, by a
// hash of the working directory (no path is stored). Where the working directory is not known, one shared key is used.
const FIRST_PREFIX_KEEP = 20
export const projectKey = (cwd: string | undefined) => (cwd ? fnv1a(cwd) : 'unknown')
const nums = (v: unknown) => (Array.isArray(v) ? v : []).filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0)
async function firstFile($: EngineInterface): Promise<{ byProject: Record<string, number[]>; ratios: number[] }> {
  try {
    const file = `${await dataDir($)}/first-prefix.json`
    if (!(await $.fs.exists(file))) return { byProject: {}, ratios: [] }
    const j = JSON.parse(await fsRead($, file)) as { byProject?: Record<string, unknown>; ratios?: unknown }
    return { byProject: Object.fromEntries(Object.entries(j.byProject ?? {}).map(([k, v]) => [k, nums(v)])), ratios: nums(j.ratios) }
  } catch { return { byProject: {}, ratios: [] } }
}
async function readFirstPrefixes($: EngineInterface): Promise<Record<string, number[]>> { return (await firstFile($)).byProject }

// Preflight: the first request's size, computed from what the engine will send before anything is sent. The system
// prompt comes from $.prompt.compose(), the tools from $.tool.list() (names and descriptions; schemas are not visible).
// The raw size is corrected by a per-machine ratio learned from each session's first measured request. With fewer
// than PREFLIGHT_MIN_RATIOS ratios it is only a lower bound. Computed once per session.
const CHARS_PER_TOKEN = 3.5
const PER_TOOL_TOKENS = 150 // a tool's schema beyond its name and description: an assumption the learned ratio corrects
const PREFLIGHT_MIN_RATIOS = 3
async function preflightRaw($: EngineInterface): Promise<number | null> {
  try {
    const [composed, tools] = await Promise.all([$.prompt.compose(), $.tool.list()])
    const sys = composed.sections.reduce((a, s) => a + s.text.length, 0)
    if (!sys) return null
    const toolChars = tools.reduce((a, t) => a + t.name.length + (t.description?.length ?? 0), 0)
    return Math.round((sys + toolChars) / CHARS_PER_TOKEN + tools.length * PER_TOOL_TOKENS)
  } catch { return null } // a host without either call: no preflight, the measured estimates still apply
}
// The estimate: this project's median when it has sizes; else the p75 of every project's sizes on this machine (the
// cautious end, because the project is new); else none. Both get headroom for the prompt and the first output.
const FIRST_PREFIX_HEADROOM = 4_000
// Order of trust: a calibrated preflight (this session's real prompt and tools), this project's median, an uncalibrated
// preflight scaled cautiously, the machine-wide p75, nothing.
async function loadPrefixEstimate($: EngineInterface): Promise<number | null> {
  const { byProject: by, ratios } = await firstFile($)
  if (!S.cache && S.preflight === undefined) S.preflight = await preflightRaw($)
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]
  if (!S.cache && S.preflight && ratios.length >= PREFLIGHT_MIN_RATIOS) { S.prefixSource = 'preflight (calibrated)'; return Math.round(S.preflight * median(ratios)) + FIRST_PREFIX_HEADROOM }
  const own = (by[projectKey(S.cwd)] ?? []).sort((a, b) => a - b)
  if (own.length) { S.prefixSource = 'project median'; return own[Math.floor(own.length / 2)] + FIRST_PREFIX_HEADROOM }
  const all = Object.values(by).flat().sort((a, b) => a - b)
  if (all.length) { S.prefixSource = 'machine p75'; return all[Math.floor(0.75 * (all.length - 1))] + FIRST_PREFIX_HEADROOM }
  // An uncalibrated preflight is only a lower bound: live, it read 16,968 tokens for a 54,795-token first request
  // (tool schemas and injected context are not in it). It can rule Haiku out; it never rules it in.
  if (!S.cache && S.preflight && S.preflight + FIRST_PREFIX_HEADROOM > DEFAULT_PARAMS.haikuMaxContext) { S.prefixSource = 'preflight (lower bound)'; return S.preflight + FIRST_PREFIX_HEADROOM }
  S.prefixSource = null
  return null
}
async function saveFirstPrefix($: EngineInterface, tokens: number) {
  try {
    const { byProject: by, ratios } = await firstFile($)
    const k = projectKey(S.cwd)
    // The preflight's ratio to the measured size, bounded: it corrects the preflight on this machine next time.
    const ratio = S.preflight ? tokens / S.preflight : null
    const nextRatios = ratio && ratio >= 0.5 && ratio <= 20 ? [...ratios, Math.round(ratio * 1000) / 1000].slice(-FIRST_PREFIX_KEEP) : ratios
    await fsWrite($, `${await dataDir($)}/first-prefix.json`, JSON.stringify({ byProject: { ...by, [k]: [...(by[k] ?? []), tokens].slice(-FIRST_PREFIX_KEEP) }, ratios: nextRatios }))
  } catch { /* an unwritable data folder only costs the estimate */ }
}
const prefixUnknown = () => !S.cache && S.prefixEstimate === null
// routingCache: the cache state a routing decision prices. Before the first request it carries the measured estimate.
function routingCache(): CacheState {
  const c = cacheState()
  return !S.cache && S.prefixEstimate ? { ...c, prefixTokens: S.prefixEstimate } : c
}

// loadPriors reads this user's calibration (bench/calibrate.mts writes it next to the records). A
// missing or malformed file keeps the labeled estimates; a calibrated value replaces only its own key.
async function loadPriors($: EngineInterface): Promise<Priors> {
  try {
    const file = `${await dataDir($)}/calibration.json`
    if (!(await $.fs.exists(file))) return DEFAULT_PRIORS
    const c = JSON.parse(await fsRead($, file)) as Partial<Priors> & { priors?: Partial<Priors> }
    const p = c.priors ?? c
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d)
    return {
      ...DEFAULT_PRIORS,
      outputPerStep: { haiku: num(p.outputPerStep?.haiku, DEFAULT_PRIORS.outputPerStep.haiku), sonnet: num(p.outputPerStep?.sonnet, DEFAULT_PRIORS.outputPerStep.sonnet), opus: num(p.outputPerStep?.opus, DEFAULT_PRIORS.outputPerStep.opus) },
      effortOutput: Object.fromEntries(EFFORTS.map((x) => [x, num(p.effortOutput?.[x], DEFAULT_PRIORS.effortOutput[x])])) as Priors['effortOutput'],
      newInputPerStep: num(p.newInputPerStep, DEFAULT_PRIORS.newInputPerStep),
      remainingRequests: num(p.remainingRequests, DEFAULT_PRIORS.remainingRequests),
      remaining: Array.isArray(p.remaining) && p.remaining.every((r) => [r.k, r.n, r.p25, r.median, r.p75].every((x) => typeof x === 'number')) && p.remaining.length ? p.remaining : undefined,
      remainingByStage: p.remainingByStage && typeof p.remainingByStage === 'object' ? Object.fromEntries(Object.entries(p.remainingByStage).filter(([, t]) => Array.isArray(t) && t.length && t.every((r) => [r.k, r.n, r.p25, r.median, r.p75].every((x) => typeof x === 'number')))) : undefined,
      basis: p.basis === 'calibrated' ? 'calibrated' : 'estimate',
      source: String(p.source ?? 'calibration.json'),
    }
  } catch { return DEFAULT_PRIORS }
}

async function activeV4($: EngineInterface): Promise<boolean> {
  // One process can host several sessions in turn (/resume, /clear): routing state belongs to one
  // session id. A new id starts from a clean state, re-reads the config, and restores its own snapshot.
  let id = S.sessionId
  try { id = await sid($) } catch {}
  if (S.restored && id !== S.sessionId) { Object.assign(S, freshSession()); resetU(); S.loaded = false }
  if (!S.loaded) await loadV4($)
  if (S.mode === 'off') return false
  // activation 'always': AutoMode starts with the session. Claude Code 2.1.311 removes the [1m] suffix before a mod sees the
  // model, so a model ID cannot be the switch. 'picker' keeps the old rule for builds that pass the suffix on.
  let live = S.cfg.activation !== 'picker'
  if (!live) { try { live = (await sessionModel($)).trim() === S.cfg.pickerModel } catch { return false } }
  if (live && !S.restored) {
    await restore($)
    // A switch set before a reload comes back with the snapshot: apply it before this prompt routes.
    if (S.sessionMode) { await loadV4($); if (S.mode === 'off') return false }
  }
  return live
}

// Outside AutoMode only the deterministic subagent rule applies: no judge call, no redirect to a plugin agent, no
// routing state. The parent is the session's own model; a subagent with an explicit model is never touched.
async function spawnOutsideAutoMode($: EngineInterface, e: any, next: any) {
  let parent = e.parentModel ?? ''
  if (!parent) { try { parent = await sessionModel($) } catch { return next(e) } }
  const sr = subagentRoute({ type: e.subagentType, explicitModel: e.model, parentFamily: familyOf(parent), demand: null })
  const res = sr ? await next({ ...e, model: sr.model }) : await next(e)
  noteAgent(res, e, sr?.model, !!sr)
  return res
}

// Persistence: a headless --resume or a plugin reload starts a new module, but the session's cache
// and task do not reset. The routing state is saved per session after each turn and read back once.
const SNAPSHOT_KEYS = ['sessionMode', 'ledger', 'lastAuto', 'taskDecision', 'decidedPlanMode', 'lastRisk', 'lastEffective', 'appEffort', 'appModel', 'sessionModel', 'pinFamily', 'pinEffort', 'judgeRiskTask', 'inadequate', 'haikuOutUntilCompaction', 'planExited', 'signalMode', 'lastWorkBand', 'workStage', 'breakers', 'failures', 'signalErrorAt', 'effortUnsupported', 'current', 'cache', 'envelope', 'votes', 'requestsSinceSwitch', 'verifiedSinceSwitch', 'lastSummary', 'taskSeq', 'warm', 'stayUp', 'redoFloor', 'planMode', 'switchesThisTask', 'lastDemand', 'stage', 'consulted', 'pending', 'compactedPending', 'basePrefix', 'compactedAt', 'lastMessageCount', 'consultCounts', 'resolvedCounts', 'signalSeq', 'signalCompactAt', 'compactHookSeen', 'toldUserTier'] as const
async function restore($: EngineInterface) {
  S.restored = true
  try { S.sessionId = await sid($) } catch {}
  try {
    const snap = (await $.store.get(`hm4:${S.sessionId}`)) as Record<string, unknown> | undefined
    if (!snap || typeof snap !== 'object') return
    for (const k of SNAPSHOT_KEYS) if (k in snap) (S as Record<string, unknown>)[k] = snap[k]
    S.lastReply = String(snap.lastReply ?? '')
    // A restored session is mid-conversation: the next prompt is not a reset, unless a compaction happened
    // in the process before (then the envelope is re-attached and the switch priced as a partial reset).
    S.resetPending = snap.compactedPending === true
  } catch {}
}
async function persist($: EngineInterface) {
  if (S.sessionId === 'unknown') return
  const snap: Record<string, unknown> = { lastReply: S.lastReply.slice(0, 600) }
  for (const k of SNAPSHOT_KEYS) snap[k] = (S as Record<string, unknown>)[k]
  try { await $.store.set(`hm4:${S.sessionId}`, snap) } catch {}
}

async function now($: EngineInterface): Promise<number> { try { return await $.clock.now() } catch { return Date.now() } }

function cacheState(): CacheState {
  return S.cache ?? { model: null, effort: null, prefixTokens: 0, lastRequestAt: null, ttlMs: S.ttl, effortSharesCache: S.effortShared }
}

function prices() { return rowFor(S.provider) }

// recordsFile is the plugin data folder the engine gives command hooks, else the default location.
async function dataDir($: EngineInterface): Promise<string> {
  let dir: string | undefined
  try { dir = await $.env.get('CLAUDE_PLUGIN_DATA') } catch {}
  if (!dir) {
    let home: string | undefined
    try { home = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude` } catch {}
    dir = `${home ?? '.'}/plugins/data/automode`
  }
  return dir
}

// recordsFile: one file per session. The engine's fs has no append, so a shared file would be
// read-modify-written by every Claude Code process at once and lose lines; a session lives in one
// process, so its own file has one writer. Readers glob records/*.jsonl (and the legacy decisions.jsonl).
async function recordsFile($: EngineInterface): Promise<string> {
  const id = S.sessionId === 'unknown' ? 'no-session' : S.sessionId.replace(/[^\w.-]/g, '_')
  return `${await dataDir($)}/records/${id}.jsonl`
}

// flush appends the buffered records, one writer at a time within this process (hooks run concurrently).
let flushing: Promise<void> = Promise.resolve()
function flush($: EngineInterface): Promise<void> {
  flushing = flushing.then(() => flushNow($)).catch(() => {})
  return flushing
}
async function flushNow($: EngineInterface) {
  if (!S.cfg.recordDecisions || !S.records.length) return
  const lines = S.records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  S.records = []
  try {
    const file = await recordsFile($)
    let before = ''
    if (await $.fs.exists(file)) {
      before = await fsRead($, file)
      if (shouldRotate(before.length + lines.length)) { await fsWrite($, `${file}.1`, before); before = '' }
    }
    await fsWrite($, file, before + lines)
  } catch {}
}

// ---------------------------------------------------------------- classification and routing

async function judge($: EngineInterface, text: string, midTurn: boolean, attachments: number): Promise<{ answer: JudgeAnswer | null; ms: number; usd?: number }> {
  const t0 = await now($)
  if (S.policy === 'auto' && judgePaused('automode', t0)) { S.records.push({ v: 1, kind: 'model-call', purpose: 'judge', at: t0, sessionId: S.sessionId, ok: false, ms: 0, error: 'paused' }); return { answer: null, ms: 0 } }
  const r = await $.model.complete({
    model: S.cfg.judgeModel, system: S.cfg.judgeVersion >= 4 ? JUDGE_SYSTEM_V4 : S.cfg.judgeVersion === 3 ? JUDGE_SYSTEM_V3 : JUDGE_SYSTEM, maxTokens: 240, effort: 'low', timeoutMs: S.cfg.judgeTimeoutMs,
    // Contract v4 does not show the current route: a judge that sees "T3 opus xhigh" echoes it for a one-line steer.
    prompt: judgePrompt(text, { lastReply: S.lastReply, current: S.current && S.cfg.judgeVersion < 4 ? `${S.current.tier} ${S.current.model} ${S.current.effort}` : undefined, midTurn, attachments, stripReminders: S.cfg.judgeVersion >= 4 }),
  }).catch(() => null)
  const ms = (await now($)) - t0
  if (!r || !r.isAnswered) { if (S.policy === 'auto') judgeOutcome('automode', false, t0 + ms); S.records.push({ v: 1, kind: 'model-call', purpose: 'judge', at: t0, sessionId: S.sessionId, ok: false, ms }); return { answer: null, ms } }
  const u = r.usage
  const tokens = usageOf(u)
  const usd = usageUsd(tokens, ANTHROPIC.rates.haiku)
  noteJudge(usd)
  S.records.push({ v: 1, kind: 'model-call', purpose: 'judge', at: t0, sessionId: S.sessionId, ok: true, ms, model: (u as any).model ?? S.cfg.judgeModel, usage: tokens, usd: { value: round6(usd), basis: 'measured', source: `${ANTHROPIC.provider} ${ANTHROPIC.checkedAt}` } })
  const answer = parseJudge(r.text)
  if (S.policy === 'auto') judgeOutcome('automode', !!answer, t0 + ms)
  return { answer, ms, usd }
}

// raiseForFailedJudge: without a verdict the task counts as elevated. It lasts until a judge answers again (taskBoundary).
function raiseForFailedJudge() {
  if (!S.envelope) return
  if (S.envelope.risk.effective === 'none') S.judgeRiskTask = S.envelope.taskId
  S.envelope = { ...S.envelope, risk: { ...S.envelope.risk, effective: maxRisk(S.envelope.risk.effective, 'elevated') } }
}

// taskBoundary opens a new task envelope on a boundary, or raises the running task's risk from the verdict.
function taskBoundary($: EngineInterface, text: string, answer: JudgeAnswer | null, override: ReturnType<typeof parseOverride>, followUp: boolean, at: number): { boundary: boolean; reason: 'none' | 'reset' | 'new-task' } {
  const boundary = isBoundary({ explicitNew: !!override?.newTask, cleared: false, judgeNewTask: !!answer?.newTask, judgeConfidence: answer?.confidence ?? 0, followUp, envelope: S.envelope })
  let reason: 'none' | 'reset' | 'new-task' = S.resetPending ? 'reset' : 'none'
  if (boundary) {
    if (S.envelope && S.envelope.status === 'open' && S.envelope.reviewRequired.value && !S.envelope.verified && S.mode === 'auto')
      $.ui.toast(`AutoMode: the previous task still had a required review (${S.envelope.reviewRequired.because[0]}).`)
    const risk = prospectiveRisk(text, answer ? { risk: maxRisk(answer.risk, answer.consequence ?? 'none'), why: answer.riskWhy } : null)
    S.taskSeq += 1
    S.envelope = newEnvelope(`task-${at}-${S.taskSeq}`, `turn-${at}`, text, at, answer?.complexity ?? 'standard', risk)
    S.editLog = []
    S.consulted = []
    S.consultCounts = {}
    S.resolvedCounts = {}
    S.switchesThisTask = 0
    S.verifiedAfterPlan = false
    S.judgedThisStage = false
    reason = 'new-task'
  } else if (S.envelope) {
    // The text and path layers run on every message: a short message or a silent judge must not skip them.
    const judged = answer ? maxRisk(answer.risk, answer.consequence ?? 'none') : 'none'
    const risk = prospectiveRisk(text, answer && judged !== 'none' ? { risk: judged, why: answer.riskWhy } : null)
    if (judged !== 'none' || risk.level === 'critical') S.envelope = withReview({ ...S.envelope, risk: { ...S.envelope.risk, prospective: risk, effective: risk.level === 'critical' ? 'critical' : S.envelope.risk.effective } }, 'none', false)
  }
  if (answer && S.envelope && S.judgeRiskTask === S.envelope.taskId) {
    if (S.envelope.risk.effective === 'elevated') S.envelope = { ...S.envelope, risk: { ...S.envelope.risk, effective: maxRisk(S.envelope.risk.prospective.level, S.envelope.risk.observed?.level ?? 'none') } }
    S.judgeRiskTask = undefined
  }
  return { boundary, reason }
}

interface Decision {
  route: EffectiveRoute; strategy: Strategy; strategyChoice: StrategyChoice | null; method: string
  judge?: { called: boolean; ms?: number; ok?: boolean; usd?: number }; answer: JudgeAnswer | null; newTask: boolean; contextNote: string | null
  optimizer: Choice | null; redo: boolean
  // What the person's own words did (a command, scope turn), what the message was (transition), what the other
  // policy would have chosen, and whether no available configuration meets the need.
  override?: { source: 'am-command' | 'typed-command'; scope: 'turn' }
  transition?: string
  stage?: Stage
  consult?: string // an Opus architect consult replaces a switch: the evidence packet it gets
  costTotal?: { mainUsd: number; switchUsd: number; judgeUsd: number; reviewRequired: boolean; consult: boolean; basis: 'estimate'; excluded: string }
  firstRequest?: { tokens: number; source: string } // the prompt size the first route was priced on, and where it came from
  compare?: { policy: 'legacy' | 'auto'; route: string; inadequate?: boolean; band?: number }
  inadequate?: { need: number; shortfall: number; route: string }
  auto?: AutoRecord
  routing?: { cheapestAdequate: string; chosen: string; overRouted: string | null; underRouted: string | null } // policy auto
}

// decide runs the whole pipeline for one person-typed prompt. Pure apart from the judge call.
async function decide($: EngineInterface, text: string, midTurn: boolean, attachments: number, at: number, attachList: readonly { type: string }[] = []): Promise<Decision> {
  if (S.policy === 'auto') return decideAuto($, text, midTurn, attachList.length ? attachList : Array.from({ length: attachments }, () => ({ type: 'file' })), at)
  const override = parseOverride(text)
  // What a short message does to the running task (lib/transition.ts). Only unambiguous ones skip the judge;
  // an answer to a question, an approval and every other short message are judged on the work they start.
  const tr = attachments ? null : transitionOf(text, S.lastReply)
  // effortless redo: the last answer was not good enough, so stay at least one step up for a while.
  const redo = !!S.current && looksLikeRedo(text)
  if (override?.reset) { S.stayUp = 0; S.redoFloor = null }
  const followUp = !!tr && tr.bypassJudge && !!S.envelope && !redo && !override?.reset
  if (redo) { S.stayUp = REDO_STAY_PROMPTS; S.redoFloor = TIER_ORDER[Math.min(4, tierRank(S.current!.tier) + 1)] }
  else if (S.stayUp > 0) S.stayUp -= 1
  if (S.stayUp === 0) S.redoFloor = null
  let answer: JudgeAnswer | null = null
  let method = 'judge'
  let judgeInfo: Decision['judge'] = { called: false }
  if (followUp) method = tr!.kind === 'continue' ? 'continuation' : 'transition'
  else if (override?.tier && override.strategy === undefined && !override.newTask && S.envelope) method = 'override'
  else {
    const j = await judge($, midTurn && S.current ? `${text}\n\n${midTurnNote(S.current.effort)}` : text, midTurn, attachments)
    answer = j.answer
    judgeInfo = { called: true, ms: j.ms, ok: !!j.answer, usd: j.usd }
    if (!answer) {
      method = 'fallback'
      if (!S.toldJudgeDown && S.mode === 'auto') { S.toldJudgeDown = true; $.ui.toast('AutoMode: the Haiku judge did not answer, so routing keeps the current model until it does.') }
    }
  }

  // The command hook that carries the permission mode ends after the mod's prompt.submit starts and before the
  // judge answers: read the signals again here, so this prompt's demand already knows about plan mode.
  await syncSignals($)

  // Task boundary and envelope.
  const { boundary, reason } = taskBoundary($, text, answer, override, followUp, at)
  const env = S.envelope!

  // Floors: repeated failures, critical consequence, and a redo. A critical consequence sets controls
  // (independent review, checks) and a modest implementer floor, Sonnet high; whether the task needs Opus
  // is the demand's question (difficulty and reasoning), never the risk label's.
  const complexity = answer?.complexity ?? env.complexity
  let floor = floorFor(env, complexity)

  // The stage: what the agent is doing now. A challenge to finished work keeps at least the band of that work.
  const stage = stageOf({
    planMode: S.planMode, planJustExited: S.planExited, transition: tr?.kind, tier: answer?.tier, complexity: answer?.complexity,
    strategy: override?.strategy ?? answer?.strategy, text, previous: S.workStage, repeatedFailure: substantiveFailures(env) > 0, hasEdits: env.editedPaths.length > 0,
  })
  const stageMin = 0
  S.workStage = stage

  // Candidate: the active policy's optimizer over the judge's demand, within the floor. The other policy runs
  // beside it and is recorded, never applied.
  let opt: Choice | null = null
  let used: Demand | null = null
  let heldEffort: Effort | undefined
  let currentInadequate = false
  let candidate
  if (answer) {
    const demand = demandOf({ ...answer, consequence: env.risk.effective }, S.planMode, substantiveFailures(env))
    S.lastDemand = demand
    used = demand
    if (stage !== 'reconsider') S.lastWorkBand = demand.band
    opt = pick(S.policy, demand, floor, at, undefined, false, stageMin)
    candidate = { tier: tierOf(opt.best.family, opt.best.effort), source: 'judge' as const, confidence: answer.confidence, reason: `${answer.why || 'judge'}; ${opt.best.family} ${opt.best.effort} ${opt.best.adequacy}${opt.inadequate ? ' (inadequate)' : ''}` }
    currentInadequate = false
    floor = inadequateFloor(floor, opt)
    heldEffort = heldEffortFor(demand, floor, at, opt, stageMin)
  } else if (S.current && (method === 'continuation' || method === 'transition')) {
    candidate = { tier: S.current.tier, source: 'continuation' as const, confidence: 1, reason: method === 'transition' ? tr!.why : 'follow-up keeps the task route' }
  } else {
    // Safe fallback: the judge failed, timed out or answered out of contract. The consequence floor rises
    // to elevated (checks run), and the implementer must be adequate at the lower bound of a hard bounded
    // task: never a cheap guess, never below the running route.
    if (method === 'fallback') raiseForFailedJudge()
    const demand = demandOf({ tier: 'T2', complexity: env.complexity, risk: S.envelope!.risk.effective, confidence: 0.5 }, S.planMode, substantiveFailures(env))
    S.lastDemand = demand
    used = demand
    opt = pick(S.policy, demand, floor, at, undefined, true)
    candidate = { tier: tierOf(opt.best.family, opt.best.effort), source: 'fallback' as const, confidence: 0.5, reason: `judge unavailable: conservative ${opt.best.family} ${opt.best.effort}` }
  }
  S.votes = S.votes.tier === candidate.tier ? { tier: candidate.tier, n: S.votes.n + 1 } : { tier: candidate.tier, n: 1 }

  const route = resolve({
    override: override?.tier || override?.effort ? { tier: override.tier, effort: override.effort, reason: `user: ${text.trim().split(/\s/)[0]}` } : undefined,
    floor, candidate, effortHint: opt ? opt.best.effort : method === 'continuation' ? S.current?.effort : method === 'transition' ? tr!.effort ?? S.current?.effort : undefined, heldEffort, ...(currentInadequate ? { currentInadequate } : {}), current: usableCurrent(at),
    switchInput: {
      cache: cacheState(), now: at, votes: S.votes.n, requestsSinceSwitch: S.requestsSinceSwitch, verifiedSinceSwitch: S.verifiedSinceSwitch,
      // Leaving plan mode is a designed hand-off: a downgrade from planning skips the dwell gate.
      sameTask: !boundary && !S.planExited, risk: env.risk.effective, expectedOutputTokens: S.priors.outputPerStep[S.current?.family ?? 'sonnet'],
      prices: prices(), params: { ...DEFAULT_PARAMS, calibrated: S.priors.basis === 'calibrated' },
      requestsInPrompt: 0, newTaskSteps: boundary ? S.lastDemand?.steps : undefined, remainingTable: remainingTable(), switchesThisTask: S.switchesThisTask,
      targetWarm: opt ? warmFor(opt.best.family, at) : false, resetPrefixTokens: S.compactedAt ? S.basePrefix : undefined,
    },
  }, S.resetPending)
  S.planExited = false

  // The challenge consult (an Opus architect instead of a switch) runs under policy auto (decideAuto).
  const consult: string | undefined = undefined
  const routed = route

  // Decision B. Work size: unknown before reading, so a conservative guess from the judge's view.
  const hint: Strategy | null = S.planMode ? 'direct' : override?.strategy ?? answer?.strategy ?? null
  const work = hint === 'isolated-worker' ? { p50: 40_000, p75: 80_000, source: 'estimate: judge marked large exploration' } : workFromFiles([], text.length)
  // The workflow needs a purpose beyond "complex": critical multi-module work, where its plan and review pay.
  const purpose = answer?.strategy === 'engineering-workflow' && answer.complexity === 'complex' && env.risk.effective === 'critical' && answer.confidence >= 0.8 ? 'critical multi-module work: plan, build, verify and review' : null
  const strategy = choose({ hint, workflowPurpose: purpose, risk: env.risk.effective, designDecision: routed.tier === 'T3' && (answer?.complexity === 'complex'), main: routed.family, worker: 'haiku', cache: cacheState(), work, outputTokens: 1_500, prices: prices() }, answer?.confidence ?? 0.5)

  const injected = injection(env, reason, S.lastSummary)
  // An explicit user strategy (am:explore, am:run, am:direct) is final, like a model override.
  const chosen: Strategy = override?.strategy ?? strategy.chosen
  // The limit is state, not an event: a judged prompt sets or clears it, a follow-up that keeps the route keeps it.
  S.inadequate = null // the inadequate label belongs to policy auto
  // The decision's cost, as one total with its parts (estimates). Retries and rework are excluded: no outcome data exists
  // per configuration, and inventing a probability would decide by a made-up number. Subagents and a required review cost
  // the same whichever route the main session takes, so they inform the total but never the choice.
  const costTotal = opt ? {
    mainUsd: round6(opt.ranked.find((x) => x.family === routed.family && x.effort === routed.effort)?.attemptUsd ?? opt.best.attemptUsd),
    switchUsd: round6(routed.check?.estUsd ?? 0), judgeUsd: round6(judgeInfo?.usd ?? 0),
    reviewRequired: env.reviewRequired.value, consult: !!consult, basis: 'estimate' as const,
    excluded: 'retries and rework (no outcome data); subagents and reviews are route-independent',
  } : undefined
  return {
    route: routed, strategy: chosen, strategyChoice: strategy, method, judge: judgeInfo, answer, newTask: boundary, contextNote: injected, optimizer: opt, redo,
    ...(consult ? { consult } : {}),
    ...(costTotal ? { costTotal } : {}),
    ...(override ? { override: { source: /^am:/i.test(text) ? 'am-command' as const : 'typed-command' as const, scope: 'turn' as const } } : {}),
    ...(tr && tr.kind !== 'ambiguous' ? { transition: tr.kind } : {}),
    stage,
    ...(!S.cache && S.prefixEstimate ? { firstRequest: { tokens: S.prefixEstimate, source: S.prefixSource ?? 'unknown' } } : {}),
  }
}

// ---------------------------------------------------------------- policy auto (lib/auto.ts)
// One prompt, in the resolution order of docs/automode-auto.md: provider constraints, explicit commands, mandatory
// quality, stage transitions, the upstream shortcut, the joint optimizer, then application at the request.

// The record of one auto decision: every judge call, every candidate, the steps that fired.
interface AutoRecord {
  verdicts: Record<string, { model: string; effort: string; why: string; sure?: number; ms?: number; usd?: number; ok: boolean; cached: boolean; fallback?: string }>
  need?: NeedRecord               // the fixed-anchor answer eligibility read
  hm: { tier: string; complexity: string; ok: boolean; cached: boolean } | null
  candidates: { route: string; verdict?: string; eligibility: string; usd: number; why: string[] }[]
  rule: string
  steps: string[]                 // the resolution steps that fired, in order
  required: string[]              // why a new decision was required (step 4)
  fallback?: string               // a judge failed: what was used instead
  routeModels: boolean
}

// Anthropic defaults (effort docs, 2026-10): what a model runs at when nothing is set. The judge's "Current" line for
// a model that is not running names this, so each verdict is relative to that model as it would start.
const DEFAULT_EFFORT: Record<Family, Effort> = { haiku: 'medium', sonnet: 'high', opus: 'medium' }
const JUDGE_RETRY_MODEL = 'haiku' // upstream askHaiku's second attempt
const LOW_CONFIDENCE = 0.3 // jev-router config.mjs THRESHOLDS.minConfidence (commit 38da6b8)
// Judge breaker, adapted from claude-router lib/classifier-client.mjs (commit 168334f, MIT, Alexei Ledenev):
// FAILURES_TO_PAUSE = 3, PAUSE_MS = 60_000; one success resets it. Per judge kind, so a failing effortless judge does
// not pause the AutoMode judge. While paused, the router uses its fallbacks at once: no call, no wait, no cost.
const JUDGE_FAILURES_TO_PAUSE = 3
const JUDGE_PAUSE_MS = 60_000
function judgePaused(kind: 'effortless' | 'automode', t: number): boolean { return (S.judgeBreaker[kind]?.until ?? 0) > t }
function judgeOutcome(kind: 'effortless' | 'automode', ok: boolean, t: number) {
  const b = S.judgeBreaker[kind] ?? { failures: 0, until: 0 }
  const failures = ok ? 0 : Math.min(b.failures + 1, JUDGE_FAILURES_TO_PAUSE)
  const until = !ok && failures >= JUDGE_FAILURES_TO_PAUSE ? t + JUDGE_PAUSE_MS : ok ? 0 : b.until
  if (!ok && until > t && b.until <= t) S.records.push({ v: 1, kind: 'judge-pause', at: t, sessionId: S.sessionId, judge: kind, untilMs: JUDGE_PAUSE_MS })
  S.judgeBreaker = { ...S.judgeBreaker, [kind]: { failures, until } }
}
const effortSharedFor = (model: string) => effortSharesCache(S.penv, model)
const runningEffort = (): Effort | undefined => S.current ? S.lastEffective ?? S.current.effort : undefined

async function sessionMessages($: EngineInterface): Promise<{ role: string; text: string }[]> {
  try { return (await $.session.messages()).map((m: any) => ({ role: String(m.role), text: String(m.text ?? '') })) } catch { return [] }
}

// effortlessJudge asks the upstream judge (verbatim prompt and parser) about one model.
async function effortlessJudge($: EngineInterface, family: Family, prompt: string, o: { messages: { role: string; text: string }[]; midTurnEffort?: Effort; attachments?: readonly { type: string }[]; purpose?: string; newTask?: boolean }): Promise<{ verdict: FamilyVerdict | null; ms: number; usd?: number }> {
  const t0 = await now($)
  if (judgePaused('effortless', t0)) { S.records.push({ v: 1, kind: 'model-call', purpose: o.purpose ?? 'effortless-judge', family, at: t0, sessionId: S.sessionId, ok: false, ms: 0, attempts: 0, error: 'paused' }); return { verdict: null, ms: 0 } }
  // A7: the running effort is the judge's "Current" only while the cache is warm and the task is the same. Otherwise the
  // model is named at Anthropic's default effort: upstream's "keep the current pair" rule must not keep a stale xhigh.
  const fresh = !!S.cache?.lastRequestAt && (await now($)) - S.cache.lastRequestAt <= S.ttl && !o.newTask
  const effort = S.current?.family === family && fresh ? runningEffort()! : DEFAULT_EFFORT[family]
  const inputFor = (closing: boolean) => judgeInputFor(prompt, { family, effort, messages: o.messages, midTurnEffort: o.midTurnEffort, attachments: o.attachments, planMode: S.planMode, closing })
  const ask = (model: string, closing = false) => $.model.complete({ model, system: EFFORTLESS_SYSTEM, prompt: inputFor(closing), maxTokens: JUDGE_CALL.maxTokens, effort: JUDGE_CALL.effort, timeoutMs: (S.cfg as any).effortJudgeTimeoutMs ?? JUDGE_CALL.timeoutMs }).catch(() => null)
  // Upstream askHaiku: Haiku 5.5 by id, then the alias where 5.5 does not answer. A `$` call's time does not count
  // against the hook's budget, so the second attempt costs only latency.
  let r = await ask(JUDGE_CALL.model)
  let attempts = 1
  // Bounded: the alias is tried only after an error reply from the API (a status code). A timeout or a dropped
  // connection (status null) is not retried, so one judge never waits longer than its timeout.
  if (r && !r.isAnswered && (r as any).reason === 'api-error' && (r as any).status != null) { r = await ask(JUDGE_RETRY_MODEL); attempts = 2 }
  let ms = (await now($)) - t0
  const purpose = o.purpose ?? 'effortless-judge'
  if (!r || !r.isAnswered) { judgeOutcome('effortless', false, t0 + ms); S.records.push({ v: 1, kind: 'model-call', purpose, family, plan: S.planMode, at: t0, sessionId: S.sessionId, ok: false, ms, attempts, error: (r as any)?.error ?? (r ? (r as any).reason : 'threw') }); return { verdict: null, ms } }
  let tokens = usageOf(r.usage)
  let usd = usageUsd(tokens, ANTHROPIC.rates.haiku)
  noteJudge(usd)
  let v = parseVerdict(r.text)
  // A8: Haiku answered the message instead of judging it. One more call, with the closing line.
  if (!v) {
    const again = await ask(JUDGE_CALL.model, true)
    attempts += 1
    if (again?.isAnswered) {
      tokens = usageOf(again.usage)
      const more = usageUsd(tokens, ANTHROPIC.rates.haiku)
      noteJudge(more)
      usd += more
      v = parseVerdict(again.text)
    }
  }
  ms = (await now($)) - t0
  judgeOutcome('effortless', !!v, t0 + ms)
  S.records.push({ v: 1, kind: 'model-call', purpose, family, plan: S.planMode, at: t0, sessionId: S.sessionId, ok: !!v, ...(v ? {} : { error: 'unparsed reply' }), attempts, ms, model: (r.usage as any)?.model ?? JUDGE_CALL.model, usage: tokens, usd: { value: round6(usd), basis: 'measured', source: `${ANTHROPIC.provider} ${ANTHROPIC.checkedAt}` } })
  return { verdict: v ? { model: v.model, effort: v.effort, why: v.why, ...(v.sure !== undefined ? { sure: v.sure } : {}) } : null, ms, usd }
}

const normalizeText = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ')
const CHEAPER: Record<Family, Family[]> = { haiku: [], sonnet: ['haiku'], opus: ['haiku', 'sonnet'] }

// escalationStep: the defect escalation the task's failures ask for now, as one step from the running route.
function escalationStep(env: TaskEnvelope, allowed: Family[]): { family: Family; effort: Effort; band: number; because: string } | null {
  if (!S.current) return null
  let esc = escalation(env.failures, S.current.tier)
  const last = env.failures[env.failures.length - 1]
  if (esc.floor && last && S.consultCounts[last.fingerprint] !== undefined && env.failures.filter((f) => f.fingerprint === last.fingerprint).length <= S.consultCounts[last.fingerprint]) esc = { ...esc, floor: null }
  if (esc.floor && last && S.resolvedCounts[last.fingerprint] !== undefined && env.failures.filter((f) => f.fingerprint === last.fingerprint).length <= S.resolvedCounts[last.fingerprint]) esc = { ...esc, floor: null }
  if (!esc.floor) return null
  const running = { family: S.current.family, effort: runningEffort()! }
  const t = escalationTarget(running, esc.floor, allowed)
  if (BAND_OF[t.family][t.effort] <= BAND_OF[running.family][running.effort]) return null
  return { ...t, because: esc.because }
}

// autoFloors: the mandatory-quality step as constraints on the candidates, and the same as a tier floor for resolve().
function autoFloors(env: TaskEnvelope, complexity: Complexity, allowed: Family[], stage?: Stage): { floors: AutoFloors; tier: Floor; escalated: { family: Family; effort: Effort } | null } {
  const effortMin: Partial<Record<Family, Effort>> = {}
  const exclude: Partial<Record<Family, string>> = {}
  const because: string[] = []
  let tier: Floor = { tier: 'T0', because: [] }
  // Consequence: critical work that is not trivial gets at least Sonnet high, the v4 implementer floor, or Opus medium, its band.
  if (env.risk.effective === 'critical' && complexity !== 'trivial') {
    const why = `critical consequence: ${env.risk.prospective.reasons.slice(0, 2).join('; ') || 'observed'}`
    exclude.haiku = why
    effortMin.sonnet = 'high'
    effortMin.opus = 'medium'
    because.push(why)
    tier = { tier: 'T2', because: [why] }
  }
  // Defect escalation: one step up from the running route; every model must reach that step or it is out.
  const step = escalationStep(env, allowed)
  if (step) {
    for (const f of ['haiku', 'sonnet', 'opus'] as Family[]) {
      const e = EFFORTS.find((x) => BAND_OF[f][x] >= step.band)
      if (!e) exclude[f] = step.because
      else effortMin[f] = maxEffort(effortMin[f] ?? 'low', e)
    }
    because.push(step.because)
    const t = tierOf(step.family, step.effort)
    if (tierRank(t) >= tierRank(tier.tier)) tier = { tier: t, effort: step.effort, band: step.band, because: [step.because] }
  }
  // A challenge to finished work ("are you sure", "you missed") keeps at least the configuration of the work it
  // challenges (v4.1, kept as a floor: upstream only asks its judge to). A model that cannot reach it is out.
  const td = S.taskDecision && S.taskDecision.taskId === env.taskId ? S.taskDecision : null
  if (stage === 'reconsider' && td) {
    const band = BAND_OF[td.family][td.effort]
    const why = `a challenge keeps the work's ${td.family} ${td.effort}`
    for (const f of ['haiku', 'sonnet', 'opus'] as Family[]) {
      const e = EFFORTS.find((x) => BAND_OF[f][x] >= band)
      if (!e) exclude[f] ??= why
      else effortMin[f] = maxEffort(effortMin[f] ?? 'low', e)
    }
    because.push(why)
  }
  // Upstream redo: after a "that's wrong" the next prompts stay on the chat's model, never a cheaper one.
  if (S.stayUp > 0 && S.current) for (const f of CHEAPER[S.current.family]) exclude[f] ??= `a redo keeps the model for ${S.stayUp} more prompts`
  return { floors: { effortMin, exclude, because }, tier, escalated: step ? { family: step.family, effort: step.effort } : null }
}

// autoCost: one attempt of this task on a configuration, cache-neutral, from the token priors (labeled estimates).
function autoCost(complexity: Complexity, at: number) {
  const x = { cache: routingCache(), warm: S.warm, now: at, prices: prices(), priors: S.priors, neutral: true }
  return (family: Family, effort: Effort) => attemptCost({ family, effort, cap: { lo: 0, hi: 0 } }, { steps: TASK_STEPS[complexity] }, x).usd
}

const appFamily = (): Family => familyOf(S.appModel ?? '') ?? familyOf(S.sessionModel ?? '') ?? familyOf(S.current?.model ?? '') ?? 'sonnet'

// noteAppChoice reads the app's own model and effort, which ride on every main request. A change the mod did not make
// is the person's /model or /effort: it stands for the session, until am:reset.
function noteAppChoice($: EngineInterface, e: any) {
  const family = familyOf(String(e.model ?? ''))
  if (S.appModel && family && family !== familyOf(S.appModel) && family !== S.current?.family && family !== S.pinFamily) {
    S.pinFamily = family
    $.ui.toast(`AutoMode: you chose ${family}, so model routing is off. Type am:reset to turn it back on.`)
  }
  if (typeof e.model === 'string') S.appModel = e.model
  if (typeof e.effort !== 'string') return
  if (S.appEffort !== undefined && e.effort !== S.appEffort && e.effort !== S.lastEffective && e.effort !== S.pinEffort) {
    S.pinEffort = e.effort as Effort
    $.ui.toast(`AutoMode: you set effort to ${e.effort}, so effort routing is off. Type am:reset to turn it back on.`)
  }
  S.appEffort = e.effort as Effort
}

// pinned applies the person's /model and /effort to a route. They outrank every routing step.
function pinned<T extends { tier: Tier; family: Family; model: string; effort: Effort; owner: Owner }>(r: T, appModel: string): T {
  if (!S.pinFamily && !S.pinEffort) return r
  const family = S.pinFamily ?? r.family
  const effort = S.pinEffort ?? r.effort
  if (family === r.family && effort === r.effort) return r
  return { ...r, family, model: S.pinFamily ? appModel : r.model, effort, tier: tierOf(family, effort), owner: 'user-override' }
}
// allowedAuto: step 1, provider constraints. allowedFamilies (breakers, unknown first prompt) plus Haiku's context limit,
// which the legacy optimizer checks inside its own scoring.
function allowedAuto(at: number): Family[] {
  const ok = allowedFamilies(at).filter((f) => !(f === 'haiku' && routingCache().prefixTokens > DEFAULT_PARAMS.haikuMaxContext))
  return ok.length ? ok : ['sonnet']
}

function autoRecord(choice: AutoChoice, verdicts: AutoRecord['verdicts'], hm: AutoRecord['hm'], steps: string[], required: string[], fallback: string | undefined, need: NeedRecord): AutoRecord {
  return {
    verdicts, need, hm, rule: choice.rule, steps, required, ...(fallback ? { fallback } : {}), routeModels: (S.cfg as any).routeModels !== false,
    candidates: choice.candidates.map((c) => ({ route: `${c.family}/${c.effort}`, ...(c.verdictEffort ? { verdict: c.verdictEffort } : {}), eligibility: c.eligibility, usd: round6(Number.isFinite(c.attemptUsd) ? c.attemptUsd : -1), why: c.why.slice(0, 6) })),
  }
}

async function decideAuto($: EngineInterface, text: string, midTurn: boolean, attachList: readonly { type: string }[], at: number): Promise<Decision> {
  const steps: string[] = []
  // Signals first: the permission mode must be known before anything reads it.
  await syncSignals($)
  const override = parseOverride(text)
  const redo = !!S.current && looksLikeRedo(text)
  if (override?.reset) { S.stayUp = 0; S.pinFamily = undefined; S.pinEffort = undefined }
  if (!S.appModel && !S.sessionModel) S.sessionModel = await $.session.model().then((m) => m.trim() || undefined).catch(() => undefined)
  if (redo) S.stayUp = REDO_STAY_PROMPTS
  else if (S.stayUp > 0) S.stayUp -= 1
  S.redoFloor = null // under auto a redo keeps the model (upstream); it never raises the effort
  const tr = attachList.length ? null : transitionOf(text, S.lastReply)
  const messages = await sessionMessages($)
  const ctx = messages.length ? contextOf(messages) : S.lastReply ? `assistant: ${S.lastReply}` : ''

  // Step 1: provider constraints.
  const routeModels = (S.cfg as any).routeModels !== false
  const allowed = allowedAuto(at)
  // Step 2: explicit commands. A model command fixes the model; an effort command fixes the effort on the running model.
  const fixedFamily: Family | undefined = !routeModels ? appFamily() : override?.tier ? DEFAULT_LADDER.tiers[override.tier].family : override?.effort && S.current ? S.current.family : S.pinFamily
  const fixedEffort: Effort | undefined = override?.effort ?? (override?.tier === 'T4' ? 'max' : S.pinEffort)
  if (!routeModels) steps.push('routeModels false: the app model is kept')
  if (override?.tier || override?.effort) steps.push(`command: ${fixedFamily ?? 'model by policy'}${fixedEffort ? ` at ${fixedEffort}` : ''}`)
  // Step 4 (before judging): transitions known without a judge.
  const pendingEscalation = S.envelope ? escalationStep(S.envelope, allowed) : null
  const req = decisionRequired({ planEntered: S.planMode && !S.decidedPlanMode, planExited: S.planExited, escalation: !!pendingEscalation, command: !!override, compacted: S.compactedPending })
  // Step 5: the upstream shortcut, only with nothing required and for the same unfinished task.
  const td = S.taskDecision && S.envelope && S.taskDecision.taskId === S.envelope.taskId ? S.taskDecision : null
  // An approval ("yes" to a proposal or a hand-over) starts the work it approves: it is judged (deviation from upstream,
  // which keeps the pair for a "yes" that does not answer a question mark).
  const approves = tr?.kind === 'begin-approved'
  const followUp = keepsEffort(text, ctx)
  const shortcut = !!td && !redo && !approves && !attachList.length && shortcutApplies(followUp, text, req) && textConsequence(text).level !== 'critical'

  let answer: JudgeAnswer | null = null
  let anchor: Family = NEED_ANCHOR
  let cacheKey = ''
  let verdicts: Partial<Record<Family, FamilyVerdict | null>> = {}
  const verdictRec: AutoRecord['verdicts'] = {}
  let judgeInfo: Decision['judge'] = { called: false }
  let method = 'judge'
  let hmCached = false
  if (shortcut) { method = 'continuation'; steps.push('shortcut: upstream keepsEffort keeps the unfinished task') }
  else {
    // Call 1: the effortless judge with the fixed anchor (A9), in parallel with the AutoMode judge. The running model is
    // also asked, so a hold has an effort. A later effortless call is made only when another model could win.
    const families = firstCalls(fixedFamily, S.current && allowed.includes(S.current.family) ? S.current.family : undefined)
    anchor = families[0]
    const key = fnv1a([S.envelope?.taskId ?? 'none', S.workStage, String(S.planMode), normalizeText(text), fnv1a(S.lastReply.slice(-600)), S.envelope?.risk.effective ?? 'none', families.join(','), String(midTurn)].join('|'))
    cacheKey = key
    const hit = S.verdictCache[key]
    if (hit) {
      answer = hit.answer; verdicts = hit.verdicts; hmCached = true
      for (const [f, v] of Object.entries(verdicts)) if (v) verdictRec[f] = { ...v, ok: true, cached: true }
      steps.push('verdict cache: unchanged task state, no new judge call')
    } else {
      const midEffort = midTurn && S.current ? runningEffort() : undefined
      const [hmj, ...els] = await Promise.all([
        judge($, midTurn && S.current ? `${text}\n\n${midTurnNote(runningEffort()!)}` : text, midTurn, attachList.length),
        ...families.map((f) => effortlessJudge($, f, text, { messages, midTurnEffort: midEffort, attachments: attachList })),
      ])
      answer = hmj.answer
      let usd = hmj.usd ?? 0
      families.forEach((f, i) => {
        verdicts[f] = els[i].verdict
        usd += els[i].usd ?? 0
        verdictRec[f] = els[i].verdict ? { ...els[i].verdict!, ms: els[i].ms, usd: round6(els[i].usd ?? 0), ok: true, cached: false } : { model: '-', effort: '-', why: '', ms: els[i].ms, ok: false, cached: false }
      })
      judgeInfo = { called: true, ms: Math.max(hmj.ms, ...els.map((x) => x.ms)), ok: !!answer, usd: round6(usd) }
    }
  }

  // The need is the anchor's own answer: a fallback verdict added below never takes its place.
  const askedNeed = verdicts[anchor] ?? null

  // Task boundary and envelope (shared with legacy).
  // A short follow-up never opens a new task on the judge's word alone (an explicit am:new still does).
  const { boundary, reason } = taskBoundary($, text, answer, override, followUp && !!S.envelope, at)
  if (!answer && method === 'judge') raiseForFailedJudge()
  const env = S.envelope!
  const riskChanged = env.risk.effective !== S.lastRisk && !boundary
  const complexity = answer?.complexity ?? env.complexity
  const stage = stageOf({
    planMode: S.planMode, planJustExited: S.planExited, transition: tr?.kind, tier: answer?.tier, complexity: answer?.complexity,
    strategy: override?.strategy ?? answer?.strategy, text, previous: S.workStage, repeatedFailure: substantiveFailures(env) > 0, hasEdits: env.editedPaths.length > 0,
  })
  const required = decisionRequired({ ...req.required ? Object.fromEntries(req.why.map((w) => [w, true])) : {}, newTask: boundary, riskChanged, stageChanged: stage !== S.workStage })
  const previousStage = S.workStage
  S.workStage = stage

  // Step 3: mandatory quality, as constraints.
  const mq = autoFloors(env, complexity, allowed, stage)
  if (mq.floors.because.length) steps.push(`floors: ${mq.floors.because.join('; ')}`)
  const floors: AutoFloors = { ...mq.floors, ...(fixedFamily ? { fixedFamily } : {}), ...(fixedEffort ? { fixedEffort } : {}) }

  // Judge failures, state-aware. A failed verdict for the running model is replaced from the fallback table, so a
  // failed call never moves the session to another model. A failed AutoMode judge keeps the model as well.
  let fallback: string | undefined
  let ownFallback: string | undefined // only the running model's effort failed: the need still decides the model
  const hm = answer ? { tier: answer.tier, complexity: answer.complexity } : null
  if (!shortcut) {
    if (S.current && !verdicts[S.current.family] && (!fixedFamily || fixedFamily === S.current.family)) {
      const fb = fallbackEffort({ sameTask: !boundary, sameStage: stage === previousStage, riskChanged, planBoundary: req.why.includes('planExited') || req.why.includes('planEntered'), previous: { family: S.current.family, effort: runningEffort()! }, previousAdequate: true, appEffort: S.appEffort, escalation: mq.escalated, effortMin: mq.floors.effortMin?.[S.current.family] })
      verdicts = { ...verdicts, [S.current.family]: { model: S.current.family, effort: fb.effort, why: 'fallback' } }
      verdictRec[S.current.family] = { model: S.current.family, effort: fb.effort, why: '', ok: false, cached: false, fallback: fb.source }
      if (askedNeed) { ownFallback = fb.source; steps.push(`own verdict failed: ${fb.source}`) }
      else fallback = fb.source
    }
    // The need failed and the running model answered: nothing here can move the session.
    if (S.current && !askedNeed && !fixedFamily && !fallback) fallback = 'the need call failed: no model switch'
    if (!S.current && !Object.values(verdicts).some(Boolean)) {
      // No verdict at all on a first prompt: the app model (if available), never a model taken from the tier name.
      const f = fixedFamily ?? (allowed.includes(appFamily()) ? appFamily() : allowed[allowed.length - 1])
      const fb = fallbackEffort({ sameTask: false, sameStage: false, riskChanged: false, planBoundary: false, previous: null, previousAdequate: false, appEffort: S.appEffort, escalation: null, effortMin: mq.floors.effortMin?.[f] })
      verdicts = { [f]: { model: f, effort: fb.effort, why: 'fallback' } }
      floors.fixedFamily = f
      fallback = fb.source
    }
    if ((!answer || fallback) && S.current && !fixedFamily && allowed.includes(S.current.family)) { floors.fixedFamily = S.current.family; fallback = fallback ?? 'automode judge failed: no model switch' }
    if (!answer && !S.current && !fixedFamily && !floors.fixedFamily) { floors.fixedFamily = allowed.includes(appFamily()) ? appFamily() : allowed[allowed.length - 1]; fallback = fallback ?? 'automode judge failed on the first prompt: the app model' }
    // The effortless judge failed and the AutoMode judge answered: its model name is a minimum (fallbackModel).
    if (fallback && answer && floors.fixedFamily && !fixedFamily) {
      const fm = fallbackModel(floors.fixedFamily, { tier: answer.tier, effort: answer.effort, confidence: answer.confidence }, allowed, env.risk.effective, LOW_CONFIDENCE)
      if (fm.family !== floors.fixedFamily) {
        floors.fixedFamily = fm.family
        verdicts = { ...verdicts, [fm.family]: { model: fm.family, effort: maxEffort(fm.effort ?? 'high', mq.floors.effortMin?.[fm.family] ?? 'low'), why: 'fallback' } }
        verdictRec[fm.family] = { model: fm.family, effort: verdicts[fm.family]!.effort, why: '', ok: false, cached: false, fallback: fm.why }
      }
      fallback = `${fallback}; ${fm.why}`
    }
    if (fallback) { method = 'fallback'; steps.push(`fallback: ${fallback}`) }
    if (fallback && !S.toldJudgeDown && S.mode === 'auto') { S.toldJudgeDown = true; $.ui.toast('AutoMode: a judge did not answer, so routing keeps the current model until it does.') }
  }

  // Uncertainty never buys a cheaper model (jev-router policy.mjs `low-confidence-no-downgrade`, threshold 0.3 as
  // there): a low-confidence AutoMode verdict rules out every model cheaper than the running one.
  if (answer && S.current && answer.confidence < LOW_CONFIDENCE && !floors.fixedFamily) {
    const rankF: Record<Family, number> = { haiku: 0, sonnet: 1, opus: 2 }
    for (const f of ['haiku', 'sonnet', 'opus'] as Family[]) if (rankF[f] < rankF[S.current.family]) floors.exclude = { ...(floors.exclude ?? {}), [f]: `low judge confidence (${answer.confidence}): no downgrade` }
    steps.push('low confidence: no downgrade (jev-router)')
  }

  // Call 2, only when needed: one effortless call about the model that could win (cheaper than the anchor and
  // eligible, or the anchor is out). Its effort is valid for that model only.
  const consequence = env.risk.effective
  if (!shortcut && !fallback && !hmCached) {
    const second = secondCall({ allowed, verdicts, need: askedNeed, hm: answer ? { tier: answer.tier, complexity: answer.complexity } : null, consequence, floors, current: null, cost: () => 0 }, anchor)
    if (second) {
      const j2 = await effortlessJudge($, second, text, { messages, midTurnEffort: midTurn && S.current ? runningEffort() : undefined, attachments: attachList, purpose: 'effortless-judge:second' })
      verdicts = { ...verdicts, [second]: j2.verdict }
      verdictRec[second] = j2.verdict ? { ...j2.verdict, ms: j2.ms, usd: round6(j2.usd ?? 0), ok: true, cached: false } : { model: '-', effort: '-', why: '', ms: j2.ms, ok: false, cached: false }
      judgeInfo = { ...judgeInfo!, called: true, ms: (judgeInfo?.ms ?? 0) + j2.ms, usd: round6((judgeInfo?.usd ?? 0) + (j2.usd ?? 0)) }
      steps.push(`second effortless call: ${second}${j2.verdict ? ` -> ${j2.verdict.model}/${j2.verdict.effort}` : ' failed'}`)
    }
  }
  if (cacheKey && answer && Object.values(verdicts).every(Boolean) && !fallback && !ownFallback) S.verdictCache = Object.fromEntries([...Object.entries(S.verdictCache).slice(-40), [cacheKey, { verdicts, answer }]])

  // Step 6: the joint optimizer, or the shortcut's kept decision.
  const cost = autoCost(complexity, at)
  const current = S.current ? { family: S.current.family, effort: runningEffort()! } : null
  // After a failed judge the model is fixed, and its fallback verdict stands in for later triggers.
  const need = askedNeed ?? (floors.fixedFamily ? verdicts[floors.fixedFamily] ?? null : null)
  const kept: FamilyVerdict | null = shortcut ? { model: td!.family, effort: td!.effort, why: 'kept' } : null
  const choice: AutoChoice = kept
    ? optimizeAuto({ allowed, verdicts: { [kept.model]: kept }, need: kept, hm: null, floors: { ...floors, fixedFamily: allowed.includes(td!.family) ? td!.family : undefined }, current, cost })
    : optimizeAuto({ allowed, verdicts, need, hm, consequence, floors, current, cost })
  steps.push(`optimizer: ${choice.rule} -> ${choice.best.family}/${choice.best.effort}`)
  const own = S.current ? choice.candidates.find((c) => c.family === S.current!.family) : undefined
  // A hold keeps the model, never its old effort: the held model runs at its own verdict for this prompt (or its
  // fallback verdict), within its floors. Found in tests: a failed judge on a new task held Opus at the previous xhigh.
  const ownVerdict = S.current ? verdicts[S.current.family] : null
  const heldEffort = ownEffort(own) ?? (S.current && ownVerdict ? maxEffort(ownVerdict.effort, mq.floors.effortMin?.[S.current.family] ?? 'low') : undefined)
  const currentInadequate = runningRuledOut(S.current?.family, choice, floors, hm)
  const candidate = { tier: tierOf(choice.best.family, choice.best.effort), source: (shortcut ? 'continuation' : fallback ? 'fallback' : 'judge') as 'judge' | 'continuation' | 'fallback', confidence: answer?.confidence ?? 0.5, reason: `${shortcut ? 'short go-ahead keeps the task' : answer?.why || 'judges'}; ${choice.best.family} ${choice.best.effort} ${choice.best.eligibility}${choice.inadequate ? ' (inadequate)' : ''}` }
  S.votes = S.votes.tier === candidate.tier ? { tier: candidate.tier, n: S.votes.n + 1 } : { tier: candidate.tier, n: 1 }
  if (currentInadequate && S.current && tierRank(tierOf(choice.best.family, choice.best.effort)) > tierRank(mq.tier.tier))
    mq.tier = { tier: tierOf(choice.best.family, choice.best.effort), effort: choice.best.effort, because: [`${S.current.family} ${runningEffort()} is ruled out for this task (${own!.eligibility})`] }
  const commandRoute = override?.tier || override?.effort ? { tier: tierOf(choice.best.family, choice.best.effort), effort: choice.best.effort, reason: `user: ${text.trim().split(/\s/)[0]}` } : undefined
  const route = resolve({
    override: commandRoute, floor: mq.tier, candidate, effortHint: choice.best.effort, heldEffort, ...(currentInadequate ? { currentInadequate } : {}), effortCost, current: usableCurrent(at),
    switchInput: {
      cache: cacheState(), now: at, votes: S.votes.n, requestsSinceSwitch: S.requestsSinceSwitch, verifiedSinceSwitch: S.verifiedSinceSwitch,
      sameTask: !boundary && !S.planExited, risk: env.risk.effective, expectedOutputTokens: S.priors.outputPerStep[S.current?.family ?? 'sonnet'],
      prices: prices(), params: { ...DEFAULT_PARAMS, calibrated: S.priors.basis === 'calibrated' },
      requestsInPrompt: 0, newTaskSteps: boundary ? TASK_STEPS[complexity] : undefined, remainingTable: remainingTable(), switchesThisTask: S.switchesThisTask,
      targetWarm: warmFor(choice.best.family, at), targetWarmPrefix: S.warm[choice.best.family]?.prefixTokens, resetPrefixTokens: S.compactedAt ? S.basePrefix : undefined,
    },
  }, S.resetPending)
  steps.push(`authority: ${route.owner} ${route.family}/${route.effort}${route.check?.gate ? ` (${route.check.gate})` : ''}`)
  S.planExited = false

  // A challenge to finished hard work on a warm cheaper session: a scoped Opus consult instead of a switch (kept from v4.1).
  // The rules name Opus even when the gate holds the switch: the consult is how the reasoning arrives now.
  let consult: string | undefined
  let routed = route
  if (hm) S.lastWorkBand = stage === 'reconsider' ? S.lastWorkBand : TIER_BAND[hm.tier]
  const consultKey = `stage:${env.taskId}:${S.lastWorkBand ?? 0}`
  if (stage === 'reconsider' && S.current && S.current.family !== 'opus' && (route.family === 'opus' || choice.best.family === 'opus') && cacheState().prefixTokens >= DEFAULT_PARAMS.smallContext && !S.consulted.includes(consultKey)) {
    const packet = `Goal: ${env.spec.text.slice(0, 1500)}\n\nThe person now asks: ${text.slice(0, 600)}\n\nAcceptance: ${env.acceptance.map((a) => a.text).join('; ').slice(0, 400) || 'none stated'}\n\nFiles edited so far: ${env.editedPaths.slice(0, 30).join(', ') || 'none'}`
    const c = consultOrSwitch({ prefixTokens: cacheState().prefixTokens, remainingRequests: remainingFor({ requestsInPrompt: 0, remainingTable: remainingTable() }).median, outPerRequest: S.priors.outputPerStep.opus, packetTokens: Math.ceil(packet.length / 3.5), planTokens: 2_000, main: S.current.family, ttlMs: S.ttl, prices: prices() })
    S.records.push({ v: 1, kind: 'escalation', at, sessionId: S.sessionId, taskId: env.taskId, floor: null, action: c.choice === 'consult' ? 'consult-opus' : 'switch', via: c.choice === 'consult' ? 'architect' : 'switch', because: 'challenge to finished hard work', estimate: { consultUsd: round6(c.consultUsd), switchUsd: round6(c.switchUsd), basis: S.priors.basis } })
    if (c.choice === 'consult') {
      S.consulted = [...S.consulted, consultKey].slice(-20)
      const ownEffort = own?.effort ?? S.current.effort
      routed = { ...S.current, tier: tierOf(S.current.family, ownEffort), effort: ownEffort, owner: 'quality-escalation', reason: `consult Opus instead of a switch: ${c.why}`, floor: mq.tier, candidate: route.candidate, overridden: [...route.overridden, { owner: route.owner, reason: 'opus switch replaced by a consult' }] }
      consult = packet
      steps.push('consult: Opus architect instead of a switch')
    }
  }

  // The unfinished task's decision, for a later "continue". Closing remarks and repository steps do not replace it.
  // A gate that held the running model below the rules is a delay: a later "continue" keeps the route the rules chose.
  const heldBelow = own?.eligibility === 'ineligible' && routed.owner === 'cache-policy'
  const decided = heldBelow ? choice.best : routed
  if (!shortcut && stage !== 'complete' && stage !== 'repo-op' && stage !== 'reconsider') S.taskDecision = { taskId: env.taskId, family: decided.family, effort: decided.effort }
  S.lastAuto = shortcut ? S.lastAuto : { verdicts, need, hm, taskId: env.taskId }
  S.decidedPlanMode = S.planMode
  S.lastRisk = env.risk.effective
  if (answer) S.lastDemand = demandOf({ ...answer, consequence: env.risk.effective }, S.planMode, substantiveFailures(env))

  // Decision B, the header and the records: as legacy.
  const hint: Strategy | null = S.planMode ? 'direct' : override?.strategy ?? answer?.strategy ?? null
  const work = hint === 'isolated-worker' ? { p50: 40_000, p75: 80_000, source: 'estimate: judge marked large exploration' } : workFromFiles([], text.length)
  const purpose = answer?.strategy === 'engineering-workflow' && answer.complexity === 'complex' && env.risk.effective === 'critical' && answer.confidence >= 0.8 ? 'critical multi-module work: plan, build, verify and review' : null
  const strategy = choose({ hint, workflowPurpose: purpose, risk: env.risk.effective, designDecision: routed.tier === 'T3' && answer?.complexity === 'complex', main: routed.family, worker: 'haiku', cache: cacheState(), work, outputTokens: 1_500, prices: prices() }, answer?.confidence ?? 0.5)
  const injected = injection(env, reason, S.lastSummary)
  const chosen: Strategy = override?.strategy ?? strategy.chosen
  const needBand = hm ? TIER_BAND[hm.tier] : 0
  // The limit is state: a judged prompt sets or clears it, a kept follow-up keeps it (and its label and review).
  if (!shortcut) S.inadequate = choice.inadequate && routed.owner !== 'user-override' ? { need: needBand, shortfall: Math.max(0, needBand - BAND_OF[routed.family][routed.effort]), route: `${routed.family}/${routed.effort}` } : null
  const legacy = S.lastDemand && answer ? pick('legacy', S.lastDemand, { tier: mq.tier.tier }, at) : null
  const mainUsd = choice.candidates.find((c) => c.family === routed.family)?.attemptUsd
  return {
    route: routed, strategy: chosen, strategyChoice: strategy, method, judge: judgeInfo, answer, newTask: boundary, contextNote: injected, optimizer: null, redo,
    ...(consult ? { consult } : {}),
    costTotal: { mainUsd: round6(mainUsd !== undefined && Number.isFinite(mainUsd) ? mainUsd : choice.best.attemptUsd), switchUsd: round6(routed.check?.estUsd ?? 0), judgeUsd: round6(judgeInfo?.usd ?? 0), reviewRequired: env.reviewRequired.value, consult: !!consult, basis: 'estimate', excluded: 'retries and rework (no outcome data); subagents and reviews are route-independent' },
    ...(override ? { override: { source: /^am:/i.test(text) ? 'am-command' as const : 'typed-command' as const, scope: 'turn' as const } } : {}),
    ...(tr && tr.kind !== 'ambiguous' ? { transition: tr.kind } : {}),
    stage,
    ...(!S.cache && S.prefixEstimate ? { firstRequest: { tokens: S.prefixEstimate, source: S.prefixSource ?? 'unknown' } } : {}),
    ...(legacy ? { compare: { policy: 'legacy' as const, route: `${legacy.best.family}/${legacy.best.effort}` } } : {}),
    ...(S.inadequate ? { inadequate: S.inadequate } : {}),
    routing: { cheapestAdequate: `${choice.best.family}/${choice.best.effort}`, chosen: `${routed.family}/${routed.effort}`, overRouted: routed.family !== choice.best.family || routed.effort !== choice.best.effort ? ((choice.candidates.find((c) => c.family === routed.family)?.attemptUsd ?? 0) > choice.best.attemptUsd || EFFORTS.indexOf(routed.effort) > EFFORTS.indexOf(choice.best.effort) ? routed.owner : null) : null, underRouted: own && S.current && routed.family === S.current.family && own.eligibility !== 'eligible' && own.eligibility !== 'needs-verdict' ? routed.owner : null },
    auto: autoRecord(choice, verdictRec, hm ? { ...hm, ok: true, cached: hmCached } : shortcut ? null : { tier: '-', complexity: '-', ok: false, cached: false }, steps, required.why, fallback ?? ownFallback, needRecord(anchor, shortcut ? kept : askedNeed)),
  }
}

// reoptimizeAuto: an event between prompts (compaction, cache expiry, context growth, a passing check, plan enter or
// exit, scope growth) re-runs the joint choice on the stored verdicts, with no judge call.
function reoptimizeAuto(t: Trigger, event: string, at: number, turnId: string | undefined, reset = false) {
  if (!S.lastAuto || !S.envelope) return
  const env = S.envelope
  const complexity = S.lastAuto.hm?.complexity ?? env.complexity
  const allowed = allowedAuto(at)
  const mq = autoFloors(env, complexity, allowed, S.workStage)
  const routeModels = (S.cfg as any).routeModels !== false
  const current = S.current ? { family: S.current.family, effort: runningEffort()! } : null
  const floors = { ...mq.floors, ...(!routeModels ? { fixedFamily: appFamily() } : {}) }
  const choice = optimizeAuto({ allowed, verdicts: S.lastAuto.verdicts, need: S.lastAuto.need, hm: S.lastAuto.hm, consequence: env.risk.effective, floors, current, cost: autoCost(complexity, at) })
  let floor = mq.tier
  if (t.mandatory) { const lift = tierOf(choice.best.family, choice.best.effort); if (tierRank(lift) > tierRank(floor.tier)) floor = { tier: lift, effort: choice.best.effort, because: [t.reason] } }
  const own = S.current ? choice.candidates.find((c) => c.family === S.current!.family) : undefined
  const heldEffort = ownEffort(own)
  const currentInadequate = runningRuledOut(S.current?.family, choice, floors, S.lastAuto.hm)
  const candidate = { tier: tierOf(choice.best.family, choice.best.effort), source: 'rules' as const, confidence: 0.9, reason: `${t.reason}; ${choice.best.family} ${choice.best.effort} ${choice.best.eligibility}` }
  const route = resolve({
    floor, candidate, effortHint: choice.best.effort, heldEffort, ...(currentInadequate ? { currentInadequate } : {}), effortCost, current: usableCurrent(at),
    switchInput: {
      cache: cacheState(), now: at, votes: S.upgradeVotesFor(candidate.tier), requestsSinceSwitch: S.requestsSinceSwitch, verifiedSinceSwitch: S.verifiedSinceSwitch,
      sameTask: event !== 'plan-exit', risk: env.risk.effective, expectedOutputTokens: S.priors.outputPerStep[S.current?.family ?? 'sonnet'], prices: prices(),
      params: { ...DEFAULT_PARAMS, calibrated: S.priors.basis === 'calibrated' }, requestsInPrompt: S.requestsInPrompt, remainingTable: remainingTable(), switchesThisTask: S.switchesThisTask,
      targetWarm: warmFor(choice.best.family, at), targetWarmPrefix: S.warm[choice.best.family]?.prefixTokens, resetPrefixTokens: S.compactedAt ? S.basePrefix : undefined,
    },
  }, reset)
  S.pending = route
  S.inadequate = choice.inadequate ? { need: S.lastAuto.hm ? TIER_BAND[S.lastAuto.hm.tier] : 0, shortfall: 0, route: `${route.family}/${route.effort}` } : null
  pushDecision('trigger', { route, strategy: 'direct', strategyChoice: null, method: `trigger:${event}`, answer: null, newTask: false, contextNote: null, optimizer: null, redo: false, stage: S.workStage, auto: autoRecord(choice, {}, null, [`trigger ${event}: stored verdicts, no judge call`, `optimizer: ${choice.rule}`], [event], undefined, needRecord(NEED_ANCHOR, S.lastAuto.need)) }, true, at, turnId, undefined, { event, reason: t.reason, mandatory: t.mandatory })
}

// rejudgeAuto asks both judges again about the task (plan exit, plan enter after routing, scope growth), then
// re-runs the joint choice. A failed call keeps the stored verdict for that model.
async function rejudgeAuto($: EngineInterface, note: string, t: Trigger, event: string, turnId: string | undefined) {
  const env = S.envelope
  if (!env || !S.lastAuto) return
  const prompt = `${env.spec.text.slice(0, 3000)}\n\n${note}`
  const allowed = (S.cfg as any).routeModels !== false ? allowedAuto(await now($)) : [appFamily()]
  const messages = await sessionMessages($)
  // The same protocol as a prompt: the fixed anchor and the running model with the AutoMode judge, then at most one
  // targeted call. routeModels false asks only about the app model.
  const routeModels = (S.cfg as any).routeModels !== false
  const families = firstCalls(routeModels ? undefined : appFamily(), S.current && allowed.includes(S.current.family) ? S.current.family : undefined)
  const anchor = families[0]
  const [hmj, ...first] = await Promise.all([judge($, prompt, true, 0), ...families.map((f) => effortlessJudge($, f, prompt, { messages, purpose: `effortless-judge:${event}` }))])
  const verdicts: Partial<Record<Family, FamilyVerdict | null>> = Object.fromEntries(families.map((f, i) => [f, first[i].verdict]))
  const need = verdicts[anchor] ?? S.lastAuto.need
  const hmNow = hmj.answer ? { tier: hmj.answer.tier, complexity: hmj.answer.complexity } : S.lastAuto.hm
  const second = routeModels ? secondCall({ allowed, verdicts, need, hm: hmNow, consequence: env.risk.effective, floors: { because: [] }, current: null, cost: () => 0 }, anchor) : null
  if (second) verdicts[second] = (await effortlessJudge($, second, prompt, { messages, purpose: `effortless-judge:${event}:second` })).verdict
  // A fresh call that failed keeps that model's stored verdict; models not asked now carry no stale verdict.
  for (const f of [...families, second].filter(Boolean) as Family[]) if (!verdicts[f] && S.lastAuto.verdicts[f]) verdicts[f] = S.lastAuto.verdicts[f]
  S.lastAuto = { verdicts, need, hm: hmNow, taskId: env.taskId }
  if (hmj.answer) S.lastDemand = demandOf({ ...hmj.answer, consequence: env.risk.effective }, S.planMode, substantiveFailures(env))
  S.records.push({ v: 1, kind: 'rejudge', at: await now($), sessionId: S.sessionId, taskId: env.taskId, event, hm: S.lastAuto.hm, verdicts: Object.fromEntries(Object.entries(verdicts).map(([f, v]) => [f, v ? `${v.model}/${v.effort}` : null])) })
  reoptimizeAuto(t, event, await now($), turnId)
}

// helperPick: upstream "Helpers on". The judge reads the subagent's own task for the subagent's own model; the effort
// is at least medium (helperFloor). The parent's effort is never copied. A failed call gives the helper floor.
async function helperPick($: EngineInterface, e: any, model: string | undefined): Promise<{ effort: Effort; why: string } | null> {
  if (e.fork || e.isTeammate || e.workflow || e.resume) return null
  const family = familyOf(model ?? '') ?? familyOf(e.parentModel ?? '') ?? null
  if (!family) return null
  const floor = helperFloor('low', 'max')
  const j = await effortlessJudge($, family, helperQuestion(String(e.prompt ?? ''), String(e.subagentType ?? 'subagent')), { messages: await sessionMessages($), purpose: 'effortless-helper' })
  if (!j.verdict) return { effort: floor, why: 'helper judge failed: helper floor medium' }
  const effort = bounded(j.verdict.effort, floor, 'max')
  return { effort, why: `helper judge ${family}: ${j.verdict.effort}${effort !== j.verdict.effort ? ' (helpers start at medium)' : ''}` }
}

// pick runs the legacy interval optimizer (policy auto records its route as `compare`).
// optimizer. `family` pins the model (a held model re-picks only its effort). `keepRunning` is the fallback rule:
// when the judge failed, never pick below the running route.
function pick(_policy: 'legacy', demand: Demand, floor: { tier: Tier; band?: number }, at: number, family?: Family, keepRunning = false, _stageMin = 0): Choice {
  const x = { cache: routingCache(), warm: S.warm, now: at, prices: prices(), priors: S.priors, neutral: true }
  const common = { haikuMaxContext: DEFAULT_PARAMS.haikuMaxContext, allowed: allowedFamilies(at), ...(family ? { family } : {}) }
  return optimize(demand, x, { ...common, minCap: Math.max(FLOOR_CAPABILITY[floor.tier], keepRunning && S.current ? capOf(S.current) : 0) })
}

// heldEffortFor: when the model switch may be held, the held model still runs this prompt at the effort this prompt
// needs. Only an adequate configuration on the held model counts; otherwise the held effort stays as it is.
function heldEffortFor(demand: Demand, floor: { tier: Tier }, at: number, opt: Choice, stageMin = 0): Effort | undefined {
  if (!S.current || S.current.family === opt.best.family || !allowedFamilies(at).includes(S.current.family)) return undefined
  const held = pick(S.policy, demand, floor, at, S.current.family, false, stageMin)
  return held.best.feasible ? held.best.effort : undefined
}

// needsGuidance: guidance goes in only when it changes what the model should do.
function needsGuidance(d: Decision, env: TaskEnvelope): boolean {
  if (d.strategy !== 'direct') return true
  if (d.inadequate || d.consult) return true
  if (env.reviewRequired.value || env.risk.effective !== 'none') return true
  if (env.failures.length && escalation(env.failures, d.route.tier).action !== 'none') return true
  return d.route.owner === 'user-override' || d.route.owner === 'quality-escalation'
}

function routeHeader(d: Decision, env: TaskEnvelope): string {
  const r = d.route
  const lines = [`[AutoMode: ${r.tier} ${r.family} ${r.effort} · ${r.owner}: ${r.reason}]`]
  // Never present the strongest available route as sufficient: say what is missing and keep the checks.
  if (d.consult) lines.push(`The person challenged finished hard work. Before you answer or change code, call the Agent tool with subagent_type "automode:architect" (Opus, read-only) and wait for it, with this evidence:\n${d.consult}\nAsk it whether the work is right, what is missing, and the fix plan. Apply its findings, run the checks, and answer the person.`)
  if (d.inadequate) lines.push(`No available model meets this task's need (band ${d.inadequate.need}; ${d.inadequate.route} is ${d.inadequate.shortfall} band${d.inadequate.shortfall === 1 ? '' : 's'} short). Treat the result as unverified: run the checks and get the independent review before you call it done, and tell the user about this limit.`)
  if (d.strategy === 'isolated-worker' && S.cfg.workerTools) lines.push(delegation('discover', env))
  if (d.strategy === 'engineering-workflow') {
    const stages = S.lastDemand ? stagesFor(S.lastDemand, { userAsked: d.method === 'override' || /^am:run\b/i.test(env.spec.text.trim()) }) : undefined
    lines.push(`This is open-ended multi-module work. Run Workflow({ name: "${S.cfg.workflowName}", args: { task: "<the full task with every constraint>", tier: "${env.risk.effective === 'critical' ? 'critical' : 'complex'}", mode: "${S.cfg.standardMode}", reviewPolicy: "${env.reviewRequired.value ? 'always' : S.cfg.reviewPolicy}", maxConcurrency: ${S.cfg.maxConcurrency}${stages ? `, stages: ${JSON.stringify(stages)}` : ''} } }) and do not implement it yourself until it returns.`)
  }
  if (d.strategy !== 'engineering-workflow' && (env.complexity !== 'trivial' || env.risk.effective !== 'none')) lines.push('Before you call a change done, run the relevant tests or build and show that they pass.')
  if (env.reviewRequired.value && d.strategy !== 'engineering-workflow') lines.push('After your checks pass, call the Agent tool with subagent_type "automode:reviewer" (Opus, read-only) and wait for it. Give it the original request, the acceptance criteria, each check with its output, and the changed files. Fix every blocker, run the checks again, and do not call it a second time.')
  if (env.failures.length && escalation(env.failures, r.tier).action === 'report') lines.push(`The last check failed for an environment reason (${env.failures[env.failures.length - 1].command}). Tell the user what is missing instead of changing code.`)
  if (escalation(env.failures, r.tier).action === 'diagnose') lines.push(delegation('diagnose', env))
  lines.push('Commit or push only when the user asks you to.')
  return lines.join('\n')
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

function optimizerRecord(o: Choice) {
  const dm = S.lastDemand
  return {
    required: round6(o.required), acceptable: o.acceptable, basis: o.basis, capabilitySource: o.capabilitySource, best: `${o.best.family}/${o.best.effort}`,
    demand: dm ? { difficulty: dm.difficulty, reasoning: dm.reasoning, steps: dm.steps, consequence: dm.consequence, verification: dm.verification, confidence: dm.confidence, planning: !!dm.planning, failures: dm.failures ?? 0, ...(dm.band !== undefined ? { band: dm.band, unsure: !!dm.unsure, bandWhy: dm.bandWhy ?? [] } : {}) } : null,
    policy: S.policy,
    ...(o.inadequate ? { inadequate: true, shortfall: o.shortfall ?? 0 } : {}),
    top: o.ranked.slice(0, 4).map((x) => ({ route: `${x.family}/${x.effort}`, adequacy: x.adequacy, retry: x.retry, usd: round6(x.expectedUsd), usdRange: { lo: round6(x.expectedUsdRange.lo), hi: round6(x.expectedUsdRange.hi) }, feasible: x.feasible })),
  }
}

function floorFor(env: TaskEnvelope, complexity: string): { tier: Tier; band?: number; because: string[] } {
  let esc = escalation(env.failures, S.current?.tier ?? 'T1')
  // A consult is the remedy for this defect until it fails again after the consult: no floor before that.
  // Found live (L5B): a passing check right after the consult re-ran the floors and moved the session.
  const last = env.failures[env.failures.length - 1]
  if (esc.floor && last && S.consultCounts[last.fingerprint] !== undefined && env.failures.filter((f) => f.fingerprint === last.fingerprint).length <= S.consultCounts[last.fingerprint]) esc = { ...esc, floor: null }
  // The defect's own check passed again, so its floor has done its job (policy auto; legacy keeps the floor).
  if (S.policy === 'auto' && esc.floor && last && S.resolvedCounts[last.fingerprint] !== undefined && env.failures.filter((f) => f.fingerprint === last.fingerprint).length <= S.resolvedCounts[last.fingerprint]) esc = { ...esc, floor: null }
  const escBand = null as null | { band: number }
  const riskFloor: Tier = env.risk.effective === 'critical' && complexity !== 'trivial' ? 'T2' : 'T0'
  const floors: { tier: Tier; band?: number; because: string }[] = [{ tier: riskFloor, because: `critical consequence: ${env.risk.prospective.reasons.slice(0, 2).join('; ') || 'observed'}` }]
  if (esc.floor) floors.push({ tier: esc.floor, ...(escBand ? { band: escBand.band } : {}), because: esc.because })
  if (S.redoFloor) floors.push({ tier: S.redoFloor, because: `a redo asked for better (${S.stayUp} prompts left)` })
  const top = floors.reduce((a, b) => (tierRank(b.tier) > tierRank(a.tier) ? b : a))
  return { tier: top.tier, ...(top.band !== undefined ? { band: top.band } : {}), because: top.tier === 'T0' ? [] : [top.because] }
}

// reoptimize re-runs the optimizer on the stored demand after an event, with no model call, and sets the
// route for the next request through the same authority and switch check as a prompt decision.
function reoptimize(t: Trigger, event: string, at: number, turnId: string | undefined, reset = false) {
  if (S.policy === 'auto') return reoptimizeAuto(t, event, at, turnId, reset)
  if (!S.lastDemand || !S.envelope) return // before the first request there is no current route: nothing to protect, as in decide()
  const env = S.envelope
  const failures = substantiveFailures(env)
  // The band depends on plan mode and repeated failures, which events change: recompute it from the verdict's tier.
  const b = S.lastDemand.tier ? demandBand({ tier: S.lastDemand.tier, unsure: S.lastDemand.unsure, planning: S.planMode, failures, complexity: S.lastDemand.complexity }) : null
  const demand: Demand = { ...S.lastDemand, planning: S.planMode, failures, consequence: env.risk.effective, ...(b ? { band: b.band, bandWhy: b.why } : {}) }
  S.lastDemand = demand
  let floor = floorFor(env, env.complexity)
  const opt = pick(S.policy, demand, floor, at)
  // A mandatory trigger (the context no longer fits the route) makes the optimizer's choice the floor.
  const lift = t.mandatory ? tierOf(opt.best.family, opt.best.effort) : floor.tier
  if (tierRank(lift) > tierRank(floor.tier)) { floor.tier = lift; floor.because = [t.reason] }
  const currentInadequate = false
  floor = inadequateFloor(floor, opt)
  const heldEffort = heldEffortFor(demand, floor, at, opt)
  const candidate = { tier: tierOf(opt.best.family, opt.best.effort), source: 'rules' as const, confidence: demand.confidence, reason: `${t.reason}; ${opt.best.family} ${opt.best.effort} ${opt.best.adequacy}${opt.inadequate ? ' (inadequate)' : ''}` }
  const route = resolve({
    floor, candidate, effortHint: opt.best.effort, heldEffort, ...(currentInadequate ? { currentInadequate } : {}), current: usableCurrent(at),
    switchInput: {
      cache: cacheState(), now: at, votes: S.upgradeVotesFor(candidate.tier), requestsSinceSwitch: S.requestsSinceSwitch, verifiedSinceSwitch: S.verifiedSinceSwitch,
      sameTask: event !== 'plan-exit', risk: env.risk.effective, expectedOutputTokens: S.priors.outputPerStep[S.current?.family ?? 'sonnet'], prices: prices(),
      params: { ...DEFAULT_PARAMS, calibrated: S.priors.basis === 'calibrated' }, requestsInPrompt: S.requestsInPrompt, remainingTable: remainingTable(), switchesThisTask: S.switchesThisTask,
      targetWarm: warmFor(opt.best.family, at), targetWarmPrefix: S.warm[opt.best.family]?.prefixTokens, resetPrefixTokens: S.compactedAt ? S.basePrefix : undefined,
    },
  }, reset)
  S.pending = route
  pushDecision('trigger', { route, strategy: 'direct', strategyChoice: null, method: `trigger:${event}`, answer: null, newTask: false, contextNote: null, optimizer: opt, redo: false, stage: S.workStage }, true, at, turnId, undefined, { event, reason: t.reason, mandatory: t.mandatory })
}

// rejudge asks the judge again, once per task stage, when the task itself changed; the route then
// follows from the new demand through the normal switch check.
async function rejudge($: EngineInterface, t: Trigger, at: number) {
  if (!S.envelope) return
  S.judgedThisStage = true
  const env = S.envelope
  const note = `[The task grew: ${t.reason}. Files edited so far: ${env.editedPaths.length}.]`
  if (S.policy === 'auto') return rejudgeAuto($, note, t, 'scope-change', undefined)
  const j = await judge($, `${env.spec.text.slice(0, 3000)}\n\n${note}`, true, 0)
  if (!j.answer) return
  S.lastDemand = demandOf({ ...j.answer, consequence: env.risk.effective }, S.planMode, substantiveFailures(env))
  reoptimize(t, 'scope-change', at, undefined)
}

// undoFailure takes one counted failure back (a cancel, or an error that is not the model's fault) and closes the
// breaker if it falls below its threshold.
function undoFailure(key: string, _why: string) {
  const b = S.breakers[key]
  if (!b) return
  const failures = Math.max(0, b.failures - 1)
  S.breakers = { ...S.breakers, [key]: { ...b, failures, openUntil: failures < (b.threshold ?? BREAKER_FAILURES) ? 0 : b.openUntil } }
}

// reconcileErrors matches each StopFailure word (read from the signals file) to the latest unclassified no-response
// request before it, and applies that class's action: undo the count, notify, mark effort unsupported, or set the
// breaker's own threshold and cooldown. A word with no request to match is dropped after ERROR_MATCH_MS.
async function reconcileErrors($: EngineInterface, t: number) {
  const left: typeof S.pendingErrors = []
  for (const err of S.pendingErrors) {
    const f = [...S.failures].reverse().find((x) => x.cls === 'pending' && x.at <= err.at + 5_000 && err.at - x.at < ERROR_MATCH_MS)
    if (!f) { if (t - err.at < ERROR_MATCH_MS) left.push(err); continue }
    const act = classifyError(err.error, err.detail)
    S.failures = S.failures.map((x) => (x === f ? { ...x, cls: err.error } : x))
    if (f.effortOnly) {
      // Only the request's effort was rewritten: the model is not at fault. An unsupported-effort word turns effort
      // changes off; every other class is recorded and leaves the model alone.
      if (act.kind === 'effort-unsupported') S.effortUnsupported = true
      if (act.kind === 'effort-unsupported' && S.toldErrorClass !== err.error) { S.toldErrorClass = err.error; $.ui.toast('AutoMode: the API refused a request with a rewritten effort. Effort changes are off for this session; the model route still applies.') }
    } else if (act.kind === 'breaker') {
      const b = S.breakers[f.key]
      if (b) S.breakers = { ...S.breakers, [f.key]: { ...b, class: err.error, threshold: act.threshold, cooldownMs: act.cooldownMs, openUntil: b.failures >= act.threshold ? f.at + act.cooldownMs : 0 } }
    } else {
      undoFailure(f.key, act.kind)
      // Context recovery: the prompt did not fit. On Haiku that is its limit: Haiku stays out until a compaction makes
      // the context smaller. Every 5.5 model has the same window, so on Sonnet or Opus the engine's own compaction recovers.
      if (act.kind === 'context' && familyOf(f.model) === 'haiku') S.haikuOutUntilCompaction = true
      if (S.lastNoResponse?.key === f.key) S.lastNoResponse = null // undone once: a cancel at the turn's end must not undo it again
      if (act.kind === 'effort-unsupported') S.effortUnsupported = true
      if (act.kind === 'notify' && S.toldErrorClass !== err.error) { S.toldErrorClass = err.error; $.ui.toast(act.toast) }
      if (act.kind === 'effort-unsupported' && S.toldErrorClass !== err.error) { S.toldErrorClass = err.error; $.ui.toast('AutoMode: the API refused a rerouted request. Effort changes are off for this session; the model route still applies.') }
    }
    S.records.push({ v: 1, kind: 'provider-error', at: t, sessionId: S.sessionId, model: f.model, class: err.error, action: act.kind, why: act.why }) // no error text: an API 400 can echo the prompt
  }
  S.pendingErrors = left
}

// allowedFamilies: the families routing may pick now. A family is out while a circuit breaker for one of its models
// is open (see the provider error handling in v4TurnStep), and Haiku is out while the prompt size is unknown.
function allowedFamilies(at: number): Family[] {
  const all: Family[] = ['haiku', 'sonnet', 'opus']
  const open = (f: Family) => Object.entries(S.breakers).some(([k, b]) => b.openUntil > at && familyOf(k.slice(k.indexOf(':') + 1)) === f)
  const ok = all.filter((f) => !open(f) && !(f === 'haiku' && (prefixUnknown() || S.haikuOutUntilCompaction)))
  // Every family out: ignore the breakers, never the unknown prompt size.
  return ok.length ? ok : all.filter((f) => !(f === 'haiku' && prefixUnknown()))
}

// warmFor: another family's own cache is still warm (effortless markWarm), so moving back to it reads its
// prefix instead of writing it.
function warmFor(f: Family, at: number): boolean {
  const w = S.warm[f]
  return !!w && w.until > at && familyOf(S.cache?.model ?? '') !== f
}

// hashFiles reads covered files and hashes their content (FNV-1a, for change detection only). A file it
// cannot read gets no hash, and the edit log alone decides for it. Capped to keep the hook cheap.
async function hashFiles($: EngineInterface, paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const p of paths.slice(0, 40)) {
    try { const text = await fsRead($, p); if (text.length <= 400_000) out[p] = fnv1a(text) } catch {}
  }
  return out
}

function routingRecord(d: Decision) {
  const best = d.optimizer!.best
  const bands = false // legacy only: policy auto records its candidates instead
  const chosen = bands ? bandOf(d.route.family, d.route.effort) : mid(CAPABILITY[d.route.family][d.route.effort])
  const target = bands ? bandOf(best.family, best.effort) : mid(best.cap)
  const tol = bands ? 0 : 0.05
  // A cache hold on a pricier family than the cheapest adequate one is over-routing by price even when the held
  // effort now matches the need: the cache policy chose to pay for that model.
  const heldPricier = d.route.owner === 'cache-policy' && d.route.family !== best.family
  const over = chosen > target + tol || heldPricier
  const under = chosen < target - tol
  return { cheapestAdequate: `${best.family}/${best.effort}`, chosen: `${d.route.family}/${d.route.effort}`, overRouted: over ? d.route.owner : null, underRouted: under ? d.route.owner : null }
}

// inadequateFloor: when the running route is not adequate for the task's demand, moving up is a quality
// need, not a discretionary upgrade: the optimizer's choice becomes the floor, so the switch is mandatory
// and no vote or dwell gate can hold it. Found live in VS Code (A3): an implementation task stayed on Haiku
// behind the two-vote upgrade gate until the context outgrew Haiku.
function inadequateFloor(floor: { tier: Tier; because: string[] }, opt: Choice): { tier: Tier; because: string[] } {
  if (!S.current || currentAdequate(opt)) return floor
  const tier = tierOf(opt.best.family, opt.best.effort)
  const why = false
    ? `${S.current.family} ${S.current.effort} is below band ${opt.required} for this task`
    : `${S.current.family} ${S.current.effort} is ${adequacy(CAPABILITY[S.current.family][S.current.effort], opt.required)} for this task (need ${opt.required.toFixed(2)})`
  return tierRank(tier) > tierRank(floor.tier) ? { tier, because: [why] } : floor
}

// effortCost: output and steps per request by configuration, from the priors and the effort ratios. The auto switch
// check prices the running and the target configuration each as it will run, not by model price alone.
const effortCost = {
  output: (r: Route) => S.priors.outputPerStep[r.family] * S.priors.effortOutput[r.effort],
  steps: (r: Route) => DEFAULT_PRIORS.effortSteps[r.effort],
}
// remainingTable: under policy auto, the work left is read from the stage's own table when the person's calibration has one.
const remainingTable = () => (S.policy === 'auto' ? S.priors.remainingByStage?.[S.workStage] ?? S.priors.remaining : S.priors.remaining)

// usableCurrent: the running route, unless its family is out (a breaker is open). A route on an unavailable model is
// never held for its warm cache: with no usable current route the switch is a first route.
function usableCurrent(at: number): Route | null {
  return S.current && allowedFamilies(at).includes(S.current.family) ? S.current : null
}

// currentAdequate: the running configuration meets the need under the active policy.
function currentAdequate(opt: Choice): boolean {
  if (!S.current) return true
  return opt.acceptable.includes(adequacy(CAPABILITY[S.current.family][S.current.effort], opt.required))
}

// substantiveFailures counts defect failures that repeated after an edit: real evidence that the task is
// harder than its route.
function substantiveFailures(env: TaskEnvelope): number {
  const defects = env.failures.filter((f) => f.class === 'defect' && f.editedSince)
  return Math.max(0, defects.length - 1)
}

function pushDecision(point: 'prompt' | 'compact' | 'escalation' | 'spawn' | 'trigger', d: Decision | null, applied: boolean, at: number, turnId: string | undefined, actual?: { model: string; effort?: string }, trig?: { event: string; reason: string; mandatory: boolean }) {
  const env = S.envelope
  const c = cacheState()
  S.records.push(decisionRecord({
    at, sessionId: S.sessionId, turnId, taskId: env?.taskId ?? 'none', point, mode: S.mode, applied, method: d?.method ?? point,
    effective: d ? { tier: d.route.tier, model: d.route.model, effort: d.route.effort, owner: d.route.owner, reason: d.route.reason, floor: d.route.floor.tier, check: d.route.check, overridden: d.route.overridden } : { tier: S.current?.tier ?? 'T1', model: S.current?.model ?? '', effort: S.current?.effort ?? 'medium', owner: 'fallback', reason: point, floor: 'T0', overridden: [] },
    candidate: d?.route.candidate ? { tier: d.route.candidate.tier, source: d.route.candidate.source, confidence: d.route.candidate.confidence } : undefined,
    risk: env ? { prospective: env.risk.prospective.level, effective: env.risk.effective, reviewRequired: env.reviewRequired.value } : undefined,
    strategy: d ? {
      chosen: d.strategy, reason: d.strategyChoice?.reason ?? '', confidence: d.answer?.confidence ?? 0, basis: d.strategyChoice?.basis ?? 'estimate',
      estimates: (d.strategyChoice?.estimates ?? []).map((x) => ({ strategy: x.strategy, p50: round6(x.usd.p50), p75: round6(x.usd.p75) })),
    } : undefined,
    optimizer: d?.optimizer ? optimizerRecord(d.optimizer) : undefined,
    ...(d?.override ? { override: d.override } : {}),
    ...(d?.transition ? { transition: d.transition } : {}),
    ...(d?.stage ? { stage: d.stage } : {}),
    ...(d?.firstRequest ? { firstRequest: d.firstRequest } : {}),
    ...(d?.costTotal ? { costTotal: d.costTotal } : {}),
    ...(d?.compare ? { compare: d.compare } : {}),
    ...(d?.inadequate ? { inadequate: d.inadequate } : {}),
    ...(d?.auto ? { auto: d.auto } : {}),
    policy: S.policy,
    // Over-routing: the route that runs is stronger than the cheapest adequate one, and why (a floor,
    // the cache policy holding a warm stronger model, or an override). Measured per decision, not hidden.
    routing: d?.optimizer ? routingRecord(d) : d?.routing,
    judge: d?.judge ? { ...d.judge, basis: 'measured' } : undefined,
    cache: { model: c.model, effort: c.effort, prefixTokens: c.prefixTokens, effortSharesCache: c.effortSharesCache, warm: c.lastRequestAt !== null && at - c.lastRequestAt <= c.ttlMs },
    actual,
    ...(trig ? { trigger: trig } : {}),
  }))
}

// ---------------------------------------------------------------- workers
// Supported delegation (spike S2): this Claude Code refuses a mod running the Agent tool, and a hook
// may not wait minutes for a $.agent.spawn answer. So the main model calls the Agent tool itself,
// with the prompt the router gives it; the hooks pin the worker to Haiku, guard it read-only, bound
// its reads, validate its report when it returns, and drop a report whose task revision is stale.

const WORKERS: Record<string, 'discovery' | 'diagnosis'> = { 'automode:explorer': 'discovery', 'automode:diagnoser': 'diagnosis' }

function delegation(kind: 'discover' | 'diagnose', env: TaskEnvelope): string {
  if (kind === 'diagnose') {
    const last = env.failures[env.failures.length - 1]
    const prompt = diagnosePrompt(last?.command ?? '', last?.evidence ?? '', env.editedPaths)
    return `Before changing more code, call the Agent tool with subagent_type "automode:diagnoser" and wait for it, with this prompt:\n<<<\n${prompt}\n>>>\nUse its cause and fix plan.`
  }
  return 'Before reading many files yourself, call the Agent tool once with subagent_type "automode:explorer" (read-only, Haiku) and wait for it. ' +
    `Give it the scope (a directory or area), the question, and ask for this report:\n${DISCOVERY_REPORT.replace(/\n/g, ' ')}\n` +
    'Then use the report: read a file yourself only for what it did not cover or listed under omitted.'
}

// ---------------------------------------------------------------- hooks

export async function v4SessionStart($: EngineInterface, e: any, next: any) {
  if (typeof e?.cwd === 'string') S.cwd = e.cwd
  await loadV4($)
  S.resetPending = true
  return next(e)
}

export async function v4PromptSubmit($: EngineInterface, e: any, next: any) {
  if (!isTask(e.text, e)) return next(e)
  const byPerson = e.origin?.kind === 'composer' || e.origin?.kind === 'bridge' || e.origin?.kind === 'sdk'
  // Each person prompt rereads config.json and AUTOMODE_ROUTER: a mode change (off, shadow, auto) or
  // an edited config takes effect on the next prompt, with no restart.
  if (byPerson) S.loaded = false
  if (!byPerson || !(await activeV4($))) { if (byPerson) await publish($); return next(e) }
  const at = await now($)
  const text = e.text.trim()
  // The previous turn's outcome gets the satisfaction signal from this prompt.
  // Under-routing signal: the person corrects or retries the previous answer. Kept with the route it ran on.
  if (S.lastOutcome) {
    const signal = nextSignal(text)
    S.records.push({ v: 1, kind: 'signal', at, sessionId: S.sessionId, turnId: S.lastOutcome.turnId, taskId: S.lastOutcome.taskId, next: signal, route: S.current ? `${S.current.family}/${S.current.effort}` : null, underRouting: signal !== 'moved-on' })
    S.lastOutcome = null
  }
  if (S.providerGuard && !S.toldGuard) {
    S.toldGuard = true
    S.records.push({ v: 1, kind: 'guard', at, sessionId: S.sessionId, provider: S.provider, reason: 'auto mode is unverified on this provider: observing only (shadow)' })
    $.ui.toast(`AutoMode: auto routing is not verified on ${S.provider}; observing only. Claude Code runs as usual.`)
  }
  if (S.mode === 'shadow') { S.lastPromptText = text; S.turnPrompt.set('next', { text, at }); await publish($); return next(e) }

  await syncSignals($)
  const midTurn = e.turnId !== undefined
  if (!midTurn) S.requestsInPrompt = 0
  const attachList = Array.isArray(e.attachments) ? e.attachments.map((a: any) => ({ type: String(a?.type ?? 'file') })) : []
  U.judging = true
  await publish($)
  const d = await decide($, text, midTurn, attachList.length, at, attachList).finally(() => { U.judging = false })
  // A message typed mid-turn reaches the model with the next request: that request carries new input.
  if (midTurn) S.newInput = true
  // This prompt's decision already priced the compaction (a partial reset on the surviving prefix). The compacted trigger
  // must not route a second time at the first step, where it would read the new task as the old one and hold.
  if (!midTurn && S.compactedPending) S.compactionPricedAt = S.compactedAt
  // effortless heldPick: a message typed mid-turn may raise the running route at once, but a lower
  // pick waits for the turn to end, so a steer never weakens the work in progress.
  if (midTurn && S.pending && capOf(d.route) < capOf(S.pending)) S.heldRoute = d.route
  else { S.pending = d.route; S.heldRoute = null }
  // An inadequate route keeps the review required. The envelope is updated before the header and the task state are built.
  if (d.inadequate && S.envelope && !S.envelope.reviewRequired.because.includes(INADEQUATE_REVIEW)) S.envelope = { ...S.envelope, reviewRequired: { value: true, because: [...S.envelope.reviewRequired.because, INADEQUATE_REVIEW] }, revision: S.envelope.revision + 1 }
  const env = S.envelope!
  // Ordinary bounded work gets no injected text, so V4 costs what the chosen model costs.
  const guide = needsGuidance(d, env)
  const header = guide ? routeHeader(d, env) : null
  // Task state: with guidance, or after a reset in the middle of a task (compaction, reload); never as
  // overhead on an ordinary new task.
  const state = d.contextNote && (guide || !d.newTask) ? d.contextNote : null
  const parts = [header, state].filter(Boolean) as string[]
  if (state) {
    S.lastSummary = summaryOf(env); S.envelope = { ...env, injectedRevision: env.revision }
    S.records.push({ v: 1, kind: 'envelope', at, sessionId: S.sessionId, taskId: env.taskId, reason: d.newTask ? 'new-task' : 'reset', acceptance: env.acceptance.length, reviewRequired: env.reviewRequired.value })
  }
  S.resetPending = false
  if (d.inadequate && S.toldInadequateTask !== env.taskId) {
    S.toldInadequateTask = env.taskId // told once per task
    $.ui.toast(`AutoMode: no available model fully meets this task (${d.inadequate.shortfall} band short). Running ${d.inadequate.route}. Checks and review stay required.`)
  }
  statusLine($, d.route)
  pushDecision('prompt', d, true, at, e.turnId)
  noteVerdict(d)
  await publish($)
  return next({ ...e, context: [...(e.context ?? []), ...parts] })
}

const INADEQUATE_REVIEW = 'no available model met the need for this task'

// statusLine: the route in the status row, with plan mode and a pending review.
function statusLine($: EngineInterface, r: Route) {
  $.ui.status(`AutoMode · ${r.family} ${r.effort}${S.planMode ? ' · plan' : S.policy === 'auto' && S.workStage !== 'implement' ? ` · ${S.workStage === 'plan-approved' ? 'approved' : S.workStage}` : ''}${S.envelope?.reviewRequired.value ? ' · review pending' : ''}`)
}

// capOf places a route on the optimizer's capability scale, for mid-turn comparisons.
const capOf = (r: Route) => S.policy === 'auto' ? bandOf(r.family, r.effort) + EFFORT_ORDER.indexOf(r.effort) / 10 : mid(CAPABILITY[r.family][r.effort])
const EFFORT_ORDER: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

function trigState() {
  return { haikuMaxContext: DEFAULT_PARAMS.haikuMaxContext, longContextAt: 100_000, scopeThreshold: 4, judgedThisStage: S.judgedThisStage, verifiedAfterPlan: S.verifiedAfterPlan }
}

// usageOf reads the hook's usage into token fields; usdOf prices it at the answering model's row.
// Cache writes: the API's own 5-minute and 1-hour split when the usage carries it; otherwise the session's
// cache lifetime decides (Claude Code writes 1-hour cache on a Claude plan, which costs 2x input, not 1.25x).
// Subagents always write the 5-minute cache (measured live: L6 subagents 100% 5m, main 100% 1h).
function usageOf(u: any, subagent = false): TokenUsage {
  const total = u.cache_creation_input_tokens ?? 0
  const split = u.cache_creation as { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | undefined
  const w1h = split ? split.ephemeral_1h_input_tokens ?? 0 : !subagent && S.ttl >= 3_600_000 ? total : 0
  const w5m = split ? split.ephemeral_5m_input_tokens ?? Math.max(0, total - w1h) : total - w1h
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite5m: w5m, cacheWrite1h: w1h }
}
function usdOf(model: string, u: TokenUsage) {
  const fam = familyOf(model) ?? 'sonnet'
  return { value: round6(usageUsd(u, prices().rates[fam])), basis: 'measured' as const, source: `${prices().provider} ${prices().checkedAt}` }
}

type RequestApplication = { requested: Effort | null; effective: Effort; legalAt: string; deferred: boolean }

// pushRequest records one request: app model and effort, what this hook sent, and what came back.
function pushRequest(e: any, sent: { model: string; effort: unknown }, owner: string, applied: boolean, why: string, res: any, at: number, application?: RequestApplication | null) {
  const u = res?.usage ? usageOf(res.usage, e.agentId !== undefined) : null
  const answered = res?.usage?.model ?? null
  const price = u ? usdOf(answered ?? sent.model, u) : null
  if (u && price) noteLedger(answered ?? sent.model, u, price.value, e.agentId)
  S.records.push(requestRecord({
    at, sessionId: S.sessionId, turnId: e.turnId, index: e.index, agentId: e.agentId, taskId: S.envelope?.taskId ?? 'none',
    app: { model: e.model, effort: e.effort ?? null }, sent: { model: sent.model, effort: (sent.effort as Effort | number | undefined) ?? null },
    owner, effortApplied: applied, effortWhy: why,
    answered: { model: answered, thinking: thinkingOf(res?.usage) }, usage: u, usd: price,
    ...(application ? { application } : {}),
  }))
}

export async function* v4TurnStep($: EngineInterface, e: any, next: any): AsyncGenerator<any, any, any> {
  if (e.agentId !== undefined) {
    const w = S.workers.get(e.agentId)
    const a = S.agents.get(e.agentId)
    if (!w || S.mode !== 'auto') {
      // A routed subagent (general-purpose on Sonnet) gets the task's effort; every subagent request in
      // an active session goes into the ledger with the engine's final usage.
      const routedEffort = S.mode === 'auto' && (a?.routed || a?.judged) && a.effort && takesEffort(e.model) ? a.effort : undefined
      const res = yield* next(routedEffort ? { ...e, effort: routedEffort } : e)
      if (S.mode !== 'off' && (w || a || (await activeV4($)))) {
        pushRequest(e, { model: e.model, effort: routedEffort ?? e.effort }, a?.routed ? 'subagent-policy' : 'app', !!routedEffort, a ? `subagent ${a.type}` : 'subagent', res, await now($))
        // A background subagent can finish after the main turn's last flush (live L6C: ledger 7.9% short).
        if (res?.stopReason && res.stopReason !== 'tool_use') await flush($)
        await publish($)
      }
      return res
    }
    // effortless helperFloor: a AutoMode worker's report goes back unchecked, so it never runs below medium.
    const judged = S.agents.get(e.agentId)
    const effort = takesEffort(e.model) ? (judged?.judged && judged.effort ? judged.effort : helperEffort(undefined, typeof e.effort === 'string' ? e.effort : undefined)) : e.effort
    const res = yield* next({ ...e, ...(effort !== undefined ? { effort } : {}) })
    if (res?.usage) w.tokens = (res.usage.input_tokens ?? 0) + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0)
    if (w.tokens >= HAIKU_BUDGET.stopAt) w.stop = true
    pushRequest(e, { model: e.model, effort }, 'worker', effort !== e.effort, 'worker effort floor medium', res, await now($))
    if (res?.stopReason && res.stopReason !== 'tool_use') await flush($)
    await publish($)
    return res
  }
  if (S.mode === 'off' || !(await activeV4($))) return yield* next(e)
  const t = await now($)
  if (e.index === 0) await syncSignals($, { turnId: e.turnId })
  S.turnRequests.set(e.turnId, (S.turnRequests.get(e.turnId) ?? 0) + 1)
  if (S.mode === 'shadow' || !S.pending) {
    // Shadow: no rewrite. The request is still recorded, for calibration and replay.
    const res = yield* next(e)
    pushRequest(e, { model: e.model, effort: e.effort }, 'app', false, S.mode === 'shadow' ? 'shadow: app route' : 'no route yet', res, t)
    if (res?.stopReason && res.stopReason !== 'tool_use') await flush($)
    markWarm(familyOf(res?.usage?.model ?? e.model), typeof e.effort === 'string' ? e.effort : null, res, t)
    await publish($)
    return res
  }
  S.requestsInPrompt += 1
  // Observable compaction: the request carries far fewer messages than the last one. This works in every
  // mode, also where no compaction hook reaches the mod (print-mode /compact, live L7 and L7H).
  if (S.lastMessageCount && typeof e.messageCount === 'number' && e.messageCount + 2 < S.lastMessageCount) await noteCompaction($, `message count ${S.lastMessageCount} -> ${e.messageCount}`)
  if (typeof e.messageCount === 'number') S.lastMessageCount = e.messageCount
  // Events between prompts: a compaction since the last request, or a cache left to expire mid-turn.
  if (S.compactedPending) { S.compactedPending = false; if (S.compactionPricedAt !== S.compactedAt) reoptimize(trigger(trigState(), { kind: 'compacted' }), 'compacted', t, e.turnId, true) }
  else if (e.index > 0 && S.cache?.lastRequestAt) {
    const tr = trigger(trigState(), { kind: 'step-start', idleMs: t - S.cache.lastRequestAt, ttlMs: S.ttl })
    if (tr.action === 'reoptimize') reoptimize(tr, 'cache-expired', t, e.turnId, true)
  }
  noteAppChoice($, e)
  const r = pinned(S.pending!, e.model)
  S.pending = r
  const sameFamily = familyOf(e.model) === r.family
  const model = sameFamily ? e.model : r.model
  const w = S.warm[r.family]
  const ef = effortFor({ model, appEffort: e.effort, routeEffort: r.effort, owner: r.owner, effortShared: effortSharedFor(model), cacheEffort: w?.effort ?? null, resetPending: S.resetPending, warm: !!w && w.until > t, ...(S.effortUnsupported ? { off: 'effort changes are off: the API refused a rerouted request' } : S.thinkingRisk ? { off: 'effort changes are off: the thinking mode may reject a per-message effort change' } : {}) })
  // Requested, legal and effective effort (lib/auto.ts legalEffort): a per-message change after a tool-result-only
  // turn waits for the next new input, so the effort in effect can lag the one sent.
  const requested = typeof ef.sent === 'string' ? (ef.sent as Effort) : null
  const modelChanged = !!S.cache?.model && familyOf(S.cache.model) !== familyOf(model)
  const lg = requested ? legalEffort({ index: e.index, newInput: S.newInput, perMessage: effortSharedFor(model), requested, lastEffective: S.lastEffective, modelChanged }) : null
  S.newInput = false
  const application = lg ? { requested, effective: lg.effective, legalAt: lg.legalAt, deferred: lg.deferred } : null
  const res = yield* next({ ...e, model, ...(ef.sent !== undefined ? { effort: ef.sent } : {}) })
  if (lg && (res?.usage || res?.stopReason != null)) S.lastEffective = lg.effective
  U.deferred = lg?.deferred ? requested : null
  // A rerouted request that got no response at all (no usage, no stop reason). Counted as unclassified now and
  // corrected when its class arrives (see the comment on BREAKER_FAILURES). The request goes back to the app's own
  // model for the rest of the turn.
  // A request whose only rewrite was the effort is not blamed on the model: its failure is kept so that an
  // `invalid_request` word can turn effort changes off, and it opens no breaker.
  const effortOnlyRewrite = sameFamily && ef.applied && typeof ef.sent === 'string' && ef.sent !== e.effort
  if ((!sameFamily || effortOnlyRewrite) && !res?.usage && res?.stopReason == null) {
    const key = `${S.provider}:${model}`
    const tEnd = await now($) // when the request failed, not when it started: a retried 429 can take minutes
    if (effortOnlyRewrite) {
      S.failures = [...S.failures, { key, model, at: tEnd, turnId: e.turnId, cls: 'pending', effortOnly: true }].slice(-10)
      S.lastNoResponse = null
      S.records.push({ v: 1, kind: 'provider-failure', at: tEnd, sessionId: S.sessionId, turnId: e.turnId, model, family: r.family, provider: S.provider, class: 'no-response', breaker: 'not-counted', rewrote: 'effort' })
      try { await reconcileErrors($, tEnd) } catch { /* a class that cannot be applied leaves the failure unclassified */ }
      pushRequest(e, { model, effort: ef.sent }, r.owner, ef.applied, ef.why, res, tEnd, application)
      return res
    }
    const b = { ...(S.breakers[key] ?? { failures: 0, openUntil: 0 }) }
    // Failures far apart are not "in a row": a count older than three cooldowns starts over.
    if (b.lastAt !== undefined && tEnd - b.lastAt > 3 * (b.cooldownMs ?? BREAKER_COOLDOWN_MS)) b.failures = 0
    // Half-open: the cooldown ended and this is the one probe. It counts as the threshold, so a failure reopens the
    // breaker and a cancel (which takes one back) closes it again.
    const threshold = b.threshold ?? BREAKER_FAILURES
    if (b.failures >= threshold && b.openUntil <= tEnd) b.failures = threshold - 1
    b.lastAt = tEnd
    b.failures += 1
    b.turnId = e.turnId
    if (b.failures >= threshold) b.openUntil = tEnd + (b.cooldownMs ?? BREAKER_COOLDOWN_MS)
    S.breakers = { ...S.breakers, [key]: b }
    S.lastNoResponse = { key, turnId: e.turnId, at: tEnd }
    S.failures = [...S.failures, { key, model, at: tEnd, turnId: e.turnId, cls: 'pending' }].slice(-10)
    S.records.push({ v: 1, kind: 'provider-failure', at: tEnd, sessionId: S.sessionId, turnId: e.turnId, model, family: r.family, provider: S.provider, class: 'no-response', consecutive: b.failures, breaker: b.openUntil > tEnd ? 'open' : 'counting' })
    try { await reconcileErrors($, tEnd) } catch { /* a class that cannot be applied leaves the failure unclassified */ }
    const open = S.breakers[key]
    if (open.openUntil > tEnd && !S.toldBreaker) { S.toldBreaker = true; $.ui.toast(`AutoMode: ${model} did not answer ${open.failures} request${open.failures === 1 ? '' : 's'} in a row (${open.class ?? 'unclassified'}). Routing without it for ${Math.round(((open.cooldownMs ?? BREAKER_COOLDOWN_MS)) / 60_000)} minutes.`) }
    const back = familyOf(e.model) ?? 'sonnet'
    S.pending = { ...routeFor(back === 'haiku' ? 'T0' : back === 'opus' ? 'T3' : 'T1'), model: e.model, owner: 'fallback', reason: `${r.family} did not answer`, floor: { tier: 'T0', because: [] }, overridden: [] }
    pushRequest(e, { model, effort: ef.sent }, r.owner, ef.applied, ef.why, res, tEnd, application)
    return res
  }
  // An answer closes the breaker for that model.
  if (res?.usage) S.lastNoResponse = null // a later answer in the turn: an abort at its end is not about the earlier failure
  if (res?.usage && S.breakers[`${S.provider}:${model}`]) { S.breakers = { ...S.breakers, [`${S.provider}:${model}`]: { failures: 0, openUntil: 0 } }; S.toldBreaker = false; S.failures = S.failures.filter((f) => f.key !== `${S.provider}:${model}`) }
  const sentEffort: Effort | null = typeof ef.sent === 'string' ? (ef.sent as Effort) : null
  const prevModel = S.current?.model
  // When effort changes are off, the effort that ran is the app's, not the route's: adequacy is judged on what ran.
  const effortOff = S.effortUnsupported || S.thinkingRisk
  S.current = { tier: r.tier, family: r.family, model: r.model, effort: sentEffort ?? (effortOff ? S.current?.effort ?? 'medium' : r.effort) }
  if (prevModel && prevModel !== r.model) {
    S.requestsSinceSwitch = 0
    S.verifiedSinceSwitch = false
    // Only discretionary switches count toward the anti-oscillation cap.
    if (r.owner !== 'quality-escalation' && r.owner !== 'user-override') S.switchesThisTask += 1
  } else S.requestsSinceSwitch += 1
  let shrank = false
  if (res?.usage) {
    const u = res.usage
    const prefix = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    // Hook-independent compaction signal: the prompt fell to under half of the last one. The engine may
    // compact without this mod's session.compact hook (or in another process), and the route should still
    // be re-evaluated on the smaller context.
    shrank = !!S.cache && S.cache.prefixTokens > 20_000 && prefix < S.cache.prefixTokens / 2
    // The part that survives compaction: measured as the cache read of the first request after one,
    // estimated before that as three quarters of the session's first prompt (system prompt and tools).
    if (S.compactedAt && !S.basePrefixMeasured) { S.basePrefix = u.cache_read_input_tokens ?? S.basePrefix; S.basePrefixMeasured = true }
    else if (!S.basePrefix) S.basePrefix = Math.round(prefix * 0.75)
    // The first request of a fresh session: its size is the estimate for the next session's first prompt.
    if (!S.cache && !S.firstPrefixSaved) { S.firstPrefixSaved = true; await saveFirstPrefix($, prefix) }
    S.cache = { model: u.model ?? model, effort: sentEffort, prefixTokens: prefix, lastRequestAt: t, ttlMs: S.ttl, effortSharesCache: S.effortShared }
  }
  markWarm(r.family, sentEffort, res, t)
  pushRequest(e, { model, effort: ef.sent }, r.owner, ef.applied, ef.why, res, t, application)
  // The turn's last step (no tool call follows): flush now. A print-mode process can exit right after
  // the turn, before a later flush, and the last request would be lost from the ledger.
  if (res?.stopReason && res.stopReason !== 'tool_use') await flush($)
  const ctx = trigger(trigState(), { kind: 'context', prefixTokens: S.cache?.prefixTokens ?? 0, family: r.family })
  if (ctx.action === 'reoptimize') reoptimize(ctx, 'context-growth', t, e.turnId)
  else if (shrank) reoptimize(trigger(trigState(), { kind: 'compacted' }), 'compacted', t, e.turnId, true)
  if (res?.answer) S.lastReply = res.answer
  await publish($)
  return res
}

// markWarm (effortless): a main response keeps its model's prefix cached for the cache lifetime.
function markWarm(fam: Family | null, effort: Effort | null, res: any, t: number) {
  if (!fam || !res?.usage) return
  const u = res.usage
  S.warm = { ...S.warm, [fam]: { effort, until: t + S.ttl, prefixTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) } }
}

export async function v4TurnComplete($: EngineInterface, e: any, next: any) {
  const out = await next(e)
  if (e.agentId !== undefined) {
    const ua = U.agents.get(e.agentId)
    if (ua) { U.agents.set(e.agentId, { ...ua, status: e.isAborted || e.reason === 'aborted' ? 'failed' : 'done' }); await publish($) }
    // A AutoMode worker finished: validate its report here, where its final answer is. The Agent tool
    // does not pass through tool.call, so this is the one place the parent's copy can be annotated.
    const w = S.workers.get(e.agentId)
    const kind = w && w.validate !== false ? WORKERS[w.type] : undefined
    if (S.cfg.debugLog) { S.records.push({ v: 1, kind: 'debug-sub-complete', agentId: e.agentId, known: !!w, type: w?.type, answerLen: String(e.answer ?? '').length, mode: S.mode, env: !!S.envelope }); await flush($) }
    if (!kind || S.mode !== 'auto' || !S.envelope) return out
    const v = validateReport(String(e.answer ?? ''), kind)
    const at = await now($)
    const vr = U.agents.get(e.agentId)
    if (vr) U.agents.set(e.agentId, { ...vr, result: v.status === 'ok' ? 'ok' : v.report ? 'partial' : 'failed' })
    if (kind === 'discovery' && v.report) {
      const files = Array.isArray(v.report.relevant_files) ? (v.report.relevant_files as unknown[]).map(String) : []
      S.envelope = { ...S.envelope, discovery: [...S.envelope.discovery, { scope: w!.type, paths: files, complete: v.status === 'ok', omitted: v.omitted, head: null, hashes: await hashFiles($, files), at, agentId: e.agentId }].slice(-10) }
    }
    S.records.push({ v: 1, kind: 'worker', at, sessionId: S.sessionId, taskId: S.envelope.taskId, agent: w!.type, agentId: e.agentId, status: v.status, omitted: v.omitted.length, tokens: w!.tokens, stopped: w!.stop })
    // The parent's copy is annotated by the Agent tool.call hook; here the run is only recorded.
    return out
  }
  if (S.mode === 'off' || !(await activeV4($))) { await publish($); return out }
  const at = await now($)
  const requests = S.turnRequests.get(e.turnId) ?? 0
  S.turnRequests.delete(e.turnId)
  // The turn was aborted by the person: a no-response request in it was an interrupt, not a refusal.
  if ((e.isAborted || e.reason === 'aborted') && S.lastNoResponse && S.lastNoResponse.turnId === e.turnId) {
    const k = S.lastNoResponse.key
    undoFailure(k, 'cancel')
    S.failures = S.failures.map((f) => (f.key === k && f.cls === 'pending' && f.turnId === e.turnId ? { ...f, cls: 'cancel' } : f))
    S.records.push({ v: 1, kind: 'interrupt', at, sessionId: S.sessionId, turnId: e.turnId, model: k.slice(k.indexOf(':') + 1), undone: true })
    S.lastNoResponse = null
  }
  // A lower pick typed mid-turn applies from the next turn (effortless heldPick).
  if (S.heldRoute) { S.pending = S.heldRoute; S.heldRoute = null }
  if (S.mode === 'shadow') {
    // What actually ran, from the turn's usage; the router's decision for the prompt, unapplied.
    const p = S.turnPrompt.get('next')
    S.turnPrompt.delete('next')
    if (e.usage) S.cache = { model: e.usage.model, effort: null, prefixTokens: (e.usage.input_tokens ?? 0) + (e.usage.cache_read_input_tokens ?? 0) + (e.usage.cache_creation_input_tokens ?? 0), lastRequestAt: at, ttlMs: S.ttl, effortSharesCache: S.effortShared }
    if (p) {
      const d = await decide($, p.text, false, 0, p.at).catch(() => null)
      S.resetPending = false
      if (d) { S.current = routeFor(d.route.tier, DEFAULT_LADDER, d.route.effort); pushDecision('prompt', d, false, at, e.turnId, e.usage ? { model: e.usage.model } : undefined) }
    }
  } else if (e.usage) {
    const u = e.usage
    const tokens = usageOf(u)
    S.records.push(outcomeRecord({
      at, sessionId: S.sessionId, turnId: e.turnId, taskId: S.envelope?.taskId ?? 'none', reason: e.isAborted || e.reason === 'aborted' ? 'aborted' : 'answer', requests,
      ...(typeof e.durationMs === 'number' ? { durationMs: e.durationMs } : {}),
      usage: { [u.model ?? 'unknown']: tokens },
      usd: usdOf(u.model ?? 'unknown', tokens),
      checks: { pass: S.lastCheck?.passed ? 1 : 0, fail: S.lastCheck && !S.lastCheck.passed ? 1 : 0 },
      ...(S.current ? { route: `${S.current.family}/${runningEffort()}` } : {}),
      ...(S.lastAuto?.hm ? { tier: S.lastAuto.hm.tier } : {}),
    }))
    S.lastOutcome = { turnId: e.turnId, taskId: S.envelope?.taskId ?? 'none' }
  }
  await flush($)
  await persist($)
  await publish($)
  return out
}

export async function v4AgentSpawn($: EngineInterface, e: any, next: any) {
  if (S.mode === 'off') return next(e)
  if (!(await activeV4($))) return S.cfg.subagentsEverySession && S.mode === 'auto' ? spawnOutsideAutoMode($, e, next) : next(e)
  if (S.mode === 'shadow') {
    // Shadow: no redirect, no model change; the agent is only noted for the request ledger.
    const res = await next(e)
    if (res?.agentId) S.agents.set(res.agentId, { type: e.subagentType, routed: false })
    noteAgent(res, e, e.model, false)
    return res
  }
  // Only the built-in Explore, only without an explicit model, only while AutoMode is active.
  if (S.cfg.redirectExplore && e.subagentType === 'Explore' && !e.model) {
    const hp = S.policy === 'auto' ? await helperPick($, e, 'claude-haiku-5-5') : null
    const res = await next({ ...e, subagentType: 'automode:explorer', model: 'haiku' })
    if (res && 'agentId' in res && res.agentId) {
      S.workers.set(res.agentId, { type: 'automode:explorer', tokens: 0, stop: false, validate: false })
      S.agents.set(res.agentId, { type: 'automode:explorer', effort: hp?.effort ?? 'medium', routed: true, judged: !!hp })
      noteAgent(res, { ...e, subagentType: 'automode:explorer' }, 'haiku', true, hp?.effort ?? 'medium')
      if (hp) S.records.push({ v: 1, kind: 'spawn', at: await now($), sessionId: S.sessionId, taskId: S.envelope?.taskId ?? 'none', type: 'automode:explorer', to: 'haiku', effort: hp.effort, why: hp.why, agentId: res.agentId })
    }
    return res
  }
  // Built-in general-purpose subagents of an Opus session run on Sonnet at the task's effort.
  const sr = subagentRoute({ type: e.subagentType, explicitModel: e.model, parentFamily: familyOf(e.parentModel ?? S.current?.model ?? ''), demand: S.lastDemand })
  if (sr) {
    // Policy auto: the subagent's own task is judged for its own model (upstream helpers); the thresholds stay legacy's.
    const hp = S.policy === 'auto' ? await helperPick($, e, sr.model === 'haiku' ? 'claude-haiku-5-5' : 'claude-sonnet-5-5') : null
    const effort = hp?.effort ?? sr.effort
    const res = await next({ ...e, model: sr.model })
    if (res?.agentId) S.agents.set(res.agentId, { type: e.subagentType, effort, routed: true, judged: !!hp })
    noteAgent(res, e, sr.model, true, effort)
    S.records.push({ v: 1, kind: 'spawn', at: await now($), sessionId: S.sessionId, taskId: S.envelope?.taskId ?? 'none', type: e.subagentType, from: e.parentModel ?? null, to: sr.model, effort, why: hp?.why ?? sr.why, agentId: res?.agentId })
    return res
  }
  const hp = S.policy === 'auto' ? await helperPick($, e, e.model) : null
  const res = await next(e)
  if (res?.agentId) S.agents.set(res.agentId, { type: e.subagentType, routed: false, ...(hp ? { effort: hp.effort, judged: true } : {}) })
  noteAgent(res, e, e.model, false, hp?.effort)
  if (hp && res?.agentId) S.records.push({ v: 1, kind: 'spawn', at: await now($), sessionId: S.sessionId, taskId: S.envelope?.taskId ?? 'none', type: e.subagentType, to: e.model ?? null, effort: hp.effort, why: hp.why, agentId: res.agentId })
  // Every agent the session starts is recorded with its type, so required-review completion can be measured.
  if (res?.agentId) S.records.push({ v: 1, kind: 'agent', at: await now($), sessionId: S.sessionId, taskId: S.envelope?.taskId ?? 'none', type: e.subagentType, agentId: res.agentId })
  if (S.cfg.debugLog) S.records.push({ v: 1, kind: 'debug-spawn', type: e.subagentType, model: e.model, resKeys: res ? Object.keys(res) : null, agentId: res?.agentId })
  if (res && 'agentId' in res && res.agentId && READ_ONLY_AGENTS.includes(e.subagentType)) {
    // Workflow agents use the workflow's own report schema: guard them, but validate only workers the
    // main session started through the Agent tool.
    const mainWorker = S.expectWorker > 0 && e.agentId === undefined
    if (mainWorker) S.expectWorker -= 1
    S.workers.set(res.agentId, { type: e.subagentType, tokens: 0, stop: false, validate: mainWorker })
  }
  return res
}

export async function v4ToolCall($: EngineInterface, e: any, next: any) {
  if (S.mode !== 'auto' || !(await activeV4($))) return next(e)
  const input = e as unknown as Record<string, unknown>
  if (e.agentId !== undefined) {
    if (S.cfg.blockGitWritesWhenActive && e.tool === 'Bash' && subagentBlocked(String(input.command ?? ''))) {
      return { deny: `AutoMode agents do not run git writes or destructive commands. Leave the changes in the working tree for the user to review.` }
    }
    let w = S.workers.get(e.agentId)
    if (!w) {
      const info = (await $.agent.list().catch(() => [])).find((a) => a.id === e.agentId)
      if (info && READ_ONLY_AGENTS.includes(info.type)) { w = { type: info.type, tokens: 0, stop: false }; S.workers.set(e.agentId, w) }
    }
    if (!w) return next(e)
    const g = guardTool(e.tool, input)
    if (!g.allow) return { deny: `AutoMode ${w.type} is read-only: ${g.why}.` }
    if (w.stop && ['Read', 'Grep', 'Glob'].includes(e.tool)) return { deny: BUDGET_STOP }
    if (w.type === 'automode:explorer' || w.type === 'automode:diagnoser') {
      if (e.tool === 'Read') { const c = clampRead(input, HAIKU_BUDGET); if (c) return next({ ...e, ...c } as never) }
      if (e.tool === 'Grep') { const c = clampGrep(input, HAIKU_BUDGET); if (c) return next({ ...e, ...c } as never) }
    }
    return next(e)
  }
  // Main session: the worker calls the router asked for.
  // Discovery reuse (advisory): a new exploration is told what the task's earlier discoveries covered.
  const exploring = e.tool === 'Agent' && (input.subagent_type === 'Explore' || input.subagent_type === 'automode:explorer') && S.envelope
  const covered = exploring ? [...new Set(S.envelope!.discovery.filter((d) => d.complete).flatMap((d) => d.paths))] : []
  const reuse = exploring ? priorCoverage(S.envelope!.discovery, S.editLog, await hashFiles($, covered)) : { paths: [], note: null }
  if (reuse.note) S.records.push({ v: 1, kind: 'reuse', at: await now($), sessionId: S.sessionId, taskId: S.envelope!.taskId, paths: reuse.paths.length })
  const withReuse = reuse.note ? { prompt: `${String(input.prompt ?? '')}\n\n${reuse.note}` } : {}
  if (e.tool === 'Agent' && WORKERS[String(input.subagent_type)] && S.envelope) {
    const kind = WORKERS[String(input.subagent_type)]
    const taskId = S.envelope.taskId
    // Foreground, so the report is this tool's result (this Claude Code starts agents in the background).
    S.expectWorker += 1
    const out = await next({ ...e, ...withReuse, model: 'haiku', run_in_background: false } as never)
    if (S.cfg.debugLog) S.records.push({ v: 1, kind: 'debug-agent', keys: Object.keys(out), resultType: typeof out.result, sample: JSON.stringify(out.result ?? out.text ?? '').slice(0, 200) })
    if (out.deny) return out
    const text = resultText(out)
    if (!S.envelope || S.envelope.taskId !== taskId) return { ...out, context: [...(out.context ?? []), '[AutoMode: this worker report belongs to an earlier task; do not apply it.]'] }
    const v = validateReport(text, kind)
    const at = await now($)
    if (kind === 'discovery' && v.report) {
      const files = Array.isArray(v.report.relevant_files) ? (v.report.relevant_files as unknown[]).map(String) : []
      S.envelope = { ...S.envelope, discovery: [...S.envelope.discovery, { scope: String(input.description ?? 'discovery'), paths: files, complete: v.status === 'ok', omitted: v.omitted, head: null, hashes: await hashFiles($, files), at }].slice(-10) }
    }
    const note = v.status === 'invalid' ? '[AutoMode: the worker did not return the report format; treat its answer as unverified notes and read what you need yourself.]'
      : v.status === 'partial' ? `[AutoMode: the worker report is partial; these were not covered: ${v.omitted.slice(0, 10).join('; ')}]` : null
    return note ? { ...out, context: [...(out.context ?? []), note] } : out
  }

  if (reuse.note) return next({ ...e, ...withReuse } as never)

  // Main session: track edits (paths and changed lines) and checks.
  if ((e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'MultiEdit') && S.envelope) {
    const out = await next(e)
    const p = String(input.file_path ?? '')
    if (p && !out.deny) {
      S.editedSinceCheck = true
      S.editLog = [...S.editLog, { path: p, at: await now($) }].slice(-200)
      const edited = [...new Set([...S.envelope.editedPaths, p])]
      const lines = (S.envelope.changedLines ?? 0) + changedLines(e.tool, input)
      const ifaces = (S.envelope.interfacesChanged ?? 0) + interfacesOf(e.tool, input)
      S.envelope = observe({ ...S.envelope, editedPaths: edited, changedLines: lines, interfacesChanged: ifaces }, observedRisk({ editedPaths: edited, changedFiles: edited.length, changedLines: lines, verification: 'none', interfacesChanged: ifaces }))
      S.envelope = withReview(S.envelope, 'none', edited.length > 8 || lines > 400)
      // Scope change: edits well outside what discovery mapped mean the task is not what was judged.
      const known = new Set(S.envelope.discovery.flatMap((d) => d.paths))
      if (known.size) {
        const tr = trigger(trigState(), { kind: 'scope', outsidePaths: edited.filter((x) => !known.has(x)).length })
        if (tr.action === 'judge') await rejudge($, tr, await now($))
      }
    }
    return out
  }
  if (e.tool === 'Bash' && S.envelope && isCheck(String(input.command ?? ''))) {
    // A piped check gets pipefail so its exit code tells the truth (found live: `go test | head` exited 0
    // while tests failed). The output is unchanged.
    const pf = withPipefail(String(input.command))
    const out = await next(pf ? ({ ...e, command: pf } as never) : e)
    if (out.deny) return out
    const command = pf ?? String(input.command)
    if (S.cfg.debugLog) {
      const r = out.result as Record<string, unknown> | undefined
      S.records.push({ v: 1, kind: 'debug-bash', keys: Object.keys(out), resultType: typeof out.result, resultKeys: r && typeof r === 'object' ? Object.keys(r) : null, isError: out.isError, sample: JSON.stringify(out.result ?? out.text ?? '').slice(0, 300) })
    }
    const text = resultText(out)
    const exit = text.match(/Exit code (\d+)/)
    const exitCode = exit ? Number(exit[1]) : out.isError === true ? 1 : 0
    // A reliable exit code decides; a masked one falls back to the runner's own summary lines.
    const passed = checkPassed(command, exitCode, out.isError === true, text)
    const at = await now($)
    S.lastCheck = { command, passed }
    if (passed) {
      S.envelope = { ...S.envelope, failures: markFlaky(S.envelope.failures, command, true, S.editedSinceCheck), verified: true }
      if (S.policy === 'auto') for (const f of S.envelope.failures) if (f.command === command.slice(0, 200)) S.resolvedCounts = { ...S.resolvedCounts, [f.fingerprint]: S.envelope.failures.filter((x) => x.fingerprint === f.fingerprint).length }
      S.verifiedSinceSwitch = true
      const tr = trigger(trigState(), { kind: 'check-pass', implementing: S.stage === 'implement' && S.editedSinceCheck })
      S.verifiedAfterPlan = true
      if (tr.action === 'reoptimize') reoptimize(tr, 'check-pass', at, undefined)
    } else {
      const f = failureOf(command, exitCode || 1, text.slice(-8000), at, S.editedSinceCheck)
      if (f) {
        S.envelope = { ...S.envelope, failures: [...S.envelope.failures, f].slice(-20), verified: false }
        const step = escalation(S.envelope.failures, S.current?.tier ?? 'T1')
        // Opus reasoning, two ways: switch the main session, or keep it and consult a read-only Opus
        // architect with the evidence. The consult wins when the warm prefix makes a switch expensive.
        const fp = f.fingerprint
        if (step.action === 'consult-opus' && S.current && S.current.family !== 'opus' && !S.consulted.includes(fp)) {
          const packet = evidencePacket(S.envelope.spec.text.slice(0, 1500), S.envelope.acceptance.map((a) => a.text), S.envelope.failures, S.envelope.editedPaths)
          const c = consultOrSwitch({ prefixTokens: cacheState().prefixTokens, remainingRequests: S.priors.remainingRequests, outPerRequest: S.priors.outputPerStep.opus, packetTokens: Math.ceil(packet.length / 3.5), planTokens: 2_000, main: S.current.family, ttlMs: S.ttl, prices: prices() })
          if (c.choice === 'consult') {
            S.consulted = [...S.consulted, fp].slice(-20)
            S.consultCounts = { ...S.consultCounts, [fp]: S.envelope.failures.filter((x) => x.fingerprint === fp).length }
            S.envelope = { ...S.envelope, escalations: S.envelope.escalations + 1 }
            S.records.push({ v: 1, kind: 'escalation', at, sessionId: S.sessionId, taskId: S.envelope.taskId, floor: null, action: 'consult-opus', via: 'architect', because: step.because, estimate: { consultUsd: round6(c.consultUsd), switchUsd: round6(c.switchUsd), basis: S.priors.basis } })
            await flush($)
            $.ui.toast(`AutoMode: ${step.because}. Asking an Opus architect instead of moving the session.`)
            return { ...out, context: [...(out.context ?? []), `[AutoMode: the same check failed twice after an edit. Before changing more code, call the Agent tool with subagent_type "automode:architect" (Opus, read-only) and wait for it, with this evidence:\n${packet}\nAsk it for the cause and a fix plan. Apply its plan, then run the check again.]`] }
          }
        }
        if (step.floor && S.current && TIER_ORDER.indexOf(step.floor) > TIER_ORDER.indexOf(S.current.tier)) {
          // Mandatory escalation: legacy moves to the escalation tier. Policy auto raises the running route one step
          // (escalationTarget), so Opus high goes to xhigh and only a repeat on xhigh reaches max. The note returned with
          // this tool result is new input, so a per-message effort change takes effect at the next request (newInput).
          const step41 = S.policy === 'auto' ? escalationTarget({ family: S.current.family, effort: runningEffort()! }, step.floor, allowedFamilies(at)) : null
          const e41 = step41 ? { tier: tierOf(step41.family, step41.effort), band: step41.band } : null
          const target = step41 ? routeFor(e41!.tier, DEFAULT_LADDER, step41.effort) : routeFor(step.floor)
          if (step41) S.newInput = true
          S.pending = { ...target, owner: 'quality-escalation', reason: step.because, floor: { tier: e41?.tier ?? step.floor, ...(e41 ? { band: e41.band, effort: target.effort } : {}), because: [step.because] }, overridden: [] }
          // A defect that outlived a repair (and a consult) gets the independent review once it passes.
          S.envelope = withReview({ ...S.envelope, escalations: S.envelope.escalations + 1 }, 'fail', false)
          const moveTo = e41 ? `${e41.tier} (${target.family} ${target.effort})` : step.floor
          S.records.push({ v: 1, kind: 'escalation', at, sessionId: S.sessionId, taskId: S.envelope.taskId, floor: e41?.tier ?? step.floor, ...(e41 ? { band: e41.band, route: `${target.family}/${target.effort}` } : {}), action: step.action, via: 'switch', because: step.because })
          await flush($)
          $.ui.toast(`AutoMode: ${step.because}. Moving to ${moveTo}.`)
          const packet = step.action === 'consult-opus' ? `\n\nEvidence for the next step:\n${evidencePacket(S.envelope.spec.text.slice(0, 1500), S.envelope.acceptance.map((a) => a.text), S.envelope.failures, S.envelope.editedPaths)}` : ''
          const consulted = S.consulted.includes(f.fingerprint) ? ' An Opus consult on this defect already ran; the session itself now moves to the stronger model.' : ''
          return { ...out, context: [...(out.context ?? []), `[AutoMode: escalated to ${moveTo} after a repeated failing check.${consulted} When the check passes, the independent review (automode:reviewer) is required before you call it done.]${packet}`] }
        }
      }
    }
    S.editedSinceCheck = false
    return out
  }
  return next(e)
}

// resultText: a tool result's raw text. Live, Bash returns an object ({ stdout, stderr, ... }); turning
// it into JSON escapes the newlines, and line-anchored failure markers (`^--- FAIL`) never match. Found
// live (L5): a piped `go test | head` printed FAIL with exit 0 and was recorded as a pass.
function resultText(out: any): string {
  const r = out?.result
  if (typeof r === 'string') return r
  if (r && typeof r === 'object') {
    const parts = [r.stdout, r.stderr, r.output, r.content].filter((x) => typeof x === 'string')
    if (parts.length) return parts.join('\n')
  }
  return typeof out?.text === 'string' && out.text ? out.text : JSON.stringify(r ?? '')
}

// changedLines counts the lines an edit adds or replaces: the larger side of each replacement.
function changedLines(tool: string, input: Record<string, unknown>): number {
  const n = (v: unknown) => (typeof v === 'string' && v.length ? v.split('\n').length : 0)
  if (tool === 'Write') return n(input.content)
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) return (input.edits as Record<string, unknown>[]).reduce((a, x) => a + Math.max(n(x.old_string), n(x.new_string)), 0)
  return Math.max(n(input.old_string), n(input.new_string))
}

// interfacesOf counts exported declarations an Edit or MultiEdit changes (a Write of a new file adds no
// changed interface: nothing depended on it yet).
function interfacesOf(tool: string, input: Record<string, unknown>): number {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) return (input.edits as Record<string, unknown>[]).reduce((a, x) => a + interfaceChanges(str(x.old_string), str(x.new_string)), 0)
  if (tool === 'Edit') return interfaceChanges(str(input.old_string), str(input.new_string))
  return 0
}

// Plan mode: planning raises the demand for reasoning; leaving it lets the route step down to
// implementation without the dwell gate (the opusplan pattern, decided per task). Two sources feed it: the
// engine's prompt.attachment, and the signals file where the engine skips that hook.
// rejudgePlanExit asks the judge what the approved plan's implementation needs, and stores that as the demand the
// plan-exit re-optimization reads. A failed judge leaves the stored demand, as before.
// rejudgePlanExit (policy auto): both judges read what the approved plan's implementation needs (adaptation A5: one
// note says implementation starts), and the joint choice re-runs on those verdicts. A failed call keeps the stored one.
const PLAN_EXIT_NOTE = (acceptance: string) => `[The plan was approved and implementation starts. Judge the IMPLEMENTATION work the plan starts, not the planning. Acceptance: ${acceptance}]`
async function rejudgePlanExit($: EngineInterface, turnId: string | undefined) {
  const env = S.envelope
  if (!env || S.mode !== 'auto') return
  const acceptance = env.acceptance.map((a) => a.text).join('; ').slice(0, 400) || 'none stated'
  await rejudgeAuto($, PLAN_EXIT_NOTE(acceptance), trigger(trigState(), { kind: 'plan-exit' }), 'plan-exit', turnId)
}

async function applyPlanMode($: EngineInterface, entering: boolean, via: 'attachment' | 'signal', late?: { turnId: string | undefined }) {
  if (entering !== S.planMode) S.records.push({ v: 1, kind: 'plan-mode', at: await now($), sessionId: S.sessionId, on: entering, via })
  const exiting = !entering && S.planMode
  if (exiting) S.planExited = true
  S.planMode = entering
  S.stage = entering ? 'plan' : 'implement'
  S.workStage = entering ? 'plan' : 'plan-approved'
  if (entering) S.verifiedAfterPlan = false
  S.judgedThisStage = false
  // The plan is approved: implementation may need less than planning did. Re-optimize now, no judge.
  // A signal read before routing (late is unset) leaves the exit to decide(): it routes this prompt next, and a
  // re-optimization here would run from the previous task's state.
  // The implementation is judged on its own (one cheap Haiku call), so an Opus plan can move to Sonnet when the cache
  // math allows and the work needs less, and stays when the implementation still needs the reasoning.
  if (exiting && (via === 'attachment' || late)) {
    if (S.policy === 'auto' && S.lastAuto) await rejudgePlanExit($, late?.turnId)
    else reoptimize(trigger(trigState(), { kind: 'plan-exit' }), 'plan-exit', await now($), late?.turnId)
  }
  // The signal came after this prompt was routed (the command hook ends after the mod's prompt.submit): route it
  // again with the plan demand, unless the person named the model: an explicit override wins.
  if (entering && late && S.pending && S.pending.owner !== 'user-override') {
    // Policy auto: the verdicts were made without the plan line, so both judges read the task again in plan mode.
    if (S.policy === 'auto' && S.lastAuto) await rejudgeAuto($, '', trigger(trigState(), { kind: 'plan-enter' }), 'plan-enter', late.turnId)
    else reoptimize(trigger(trigState(), { kind: 'plan-enter' }), 'plan-enter', await now($), late.turnId)
  }
  // The status row was drawn before the signal arrived: draw it again with the new plan state and route.
  if (late && S.pending) statusLine($, S.pending)
}

export async function v4Attachment($: EngineInterface, e: any, next: any) {
  if (e.agentId === undefined && (e.type === 'plan_mode' || e.type === 'plan_mode_reentry' || e.type === 'plan_mode_exit') && S.mode !== 'off' && (await activeV4($))) {
    await applyPlanMode($, e.type !== 'plan_mode_exit', 'attachment')
  }
  return next(e)
}

// signalsFile: a fixed path under the config dir, the same one an external signals writer writes. It does not use
// CLAUDE_PLUGIN_DATA: a mod cannot see that variable, and the script's copy of it can name another folder.
async function signalsFile($: EngineInterface): Promise<string> {
  let home: string | undefined
  // An empty CLAUDE_CONFIG_DIR means the default folder, as in the command hook (`||` there).
  try { home = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude` } catch {}
  return `${home ?? '.'}/plugins/data/automode/signals/${S.sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`
}

// syncSignals reads the signals file (an external signals writer writes it for an active session).
// The engine skips prompt.attachment, session.compact, and the compaction rows of session.append for a
// user-installed plugin on a Team or Enterprise login; command hooks still run. Only entries newer than
// the last seq apply, and both state changes are idempotent, so the engine's own hooks and this file can
// both fire. The file name uses the script's sanitizer. Called from prompt.submit and the first turn.step,
// so the result does not depend on which of the module hook and the command hook ran first.
async function syncSignals($: EngineInterface, late?: { turnId: string | undefined }) {
  if (S.mode !== 'auto' || !S.signalsOn || S.sessionId === 'unknown') return
  try {
    const file = await signalsFile($)
    if (!(await $.fs.exists(file))) return
    const sig = JSON.parse(await fsRead($, file))
    // A different seq, not a higher one: a pruned or deleted file starts over at 1. A replay has the same seq.
    if (!sig || typeof sig.seq !== 'number' || sig.seq === S.signalSeq) return
    S.signalSeq = sig.seq
    // The mode is applied when it CHANGES in the file, not on every write: a StopFailure or a compaction rewrites the file
    // with the old mode, which must not re-enter plan mode after the attachment left it.
    if (typeof sig.permissionMode === 'string' && sig.permissionMode !== S.signalMode) {
      S.signalMode = sig.permissionMode
      const entering = sig.permissionMode === 'plan'
      if (entering !== S.planMode) await applyPlanMode($, entering, 'signal', late)
    }
    for (const er of Array.isArray(sig.errors) ? sig.errors : []) {
      if (typeof er?.at !== 'number' || er.at <= S.signalErrorAt) continue
      S.signalErrorAt = er.at
      S.pendingErrors.push({ at: er.at, error: String(er.error ?? 'unknown').slice(0, 40), detail: String(er.detail ?? '') })
    }
    if (S.pendingErrors.length) await reconcileErrors($, await now($))
    for (const c of Array.isArray(sig.compactions) ? sig.compactions : []) {
      if (typeof c?.at !== 'number' || c.at <= S.signalCompactAt) continue
      S.signalCompactAt = c.at
      // The message-count signal may have counted this compaction already (and the next request cleared its
      // flag): an entry within a minute of the last counted compaction is the same event.
      if (!(S.compactedAt && Math.abs(c.at - S.compactedAt) < 60_000)) await noteCompaction($, `signal ${String(c.via ?? 'unknown').slice(0, 40)}`)
      // The engine never called session.compact: the chat's own model wrote the summary. Say so once.
      if (!S.compactHookSeen && !S.toldUserTier && S.cfg.compactWith === 'haiku') {
        S.toldUserTier = true
        $.ui.toast("AutoMode: this Mac runs AutoMode as a user plugin, so Claude's own model wrote the compaction summary. For Haiku summaries, ask IT to list it as an organization plugin (see the AutoMode README).")
      }
    }
    await persist($)
  } catch { /* a bad file or a failed apply must never block the prompt or the request */ }
}

// noteCompaction: the main conversation was compacted. The next request re-optimizes with the partial-reset
// pricing, the next prompt re-attaches the task envelope, and the flag survives a new process.
async function noteCompaction($: EngineInterface, via: string) {
  if (S.compactedPending && S.compactedAt && (await now($)) - S.compactedAt < 60_000) return // one compaction, two signals
  S.resetPending = true
  S.compactedPending = true
  S.compactedAt = await now($)
  S.basePrefixMeasured = false
  S.haikuOutUntilCompaction = false
  S.warm = {} // the summary replaced the history those caches held
  S.records.push({ v: 1, kind: 'compaction', at: S.compactedAt, sessionId: S.sessionId, via })
  await persist($)
  await flush($)
}

// Fallback signal: the engine's compact_boundary notice, seen through session.append. Live runs showed
// print-mode /compact compacting without reaching this mod's session.compact hook (L7, L7H).
export async function v4Append($: EngineInterface, e: any, next: any) {
  const out = await next(e)
  const m = e.message
  if (e.agentId === undefined && (e.door === 'compaction' || (m?.type === 'system' && m?.name === 'compact_boundary')) && S.mode === 'auto' && (await activeV4($))) await noteCompaction($, `session.append ${e.door}`)
  return out
}

export async function v4Compact($: EngineInterface, e: any, next: any) {
  S.compactHookSeen = true // the engine reaches this hook: no user-tier notice
  // Telemetry first, before any early return: whether the engine calls this hook at all, and how.
  if (S.mode !== 'off' && e.agentId === undefined && (await activeV4($))) { S.records.push({ v: 1, kind: 'compact-hook', at: await now($), sessionId: S.sessionId, trigger: e.trigger, mode: S.mode }); await flush($) }
  if (e.agentId !== undefined || S.mode !== 'auto' || !(await activeV4($))) return next(e)
  const instructions = [e.instructions?.trim(), S.envelope ? compactInstructions(S.envelope) : ''].filter(Boolean).join('\n\n')
  if (e.trigger !== 'precompute') await noteCompaction($, `session.compact ${e.trigger}`) // print mode may exit right after /compact
  if (S.cfg.compactWith !== 'haiku' || e.trigger === 'precompute') return next({ ...e, instructions })
  const messages = Array.isArray(e.messages) && e.messages.length ? e.messages : await $.session.messages().catch(() => [])
  const r = await $.model.complete({
    model: S.cfg.compactModel, system: COMPACT_SYSTEM, maxTokens: 16000, effort: 'medium', timeoutMs: 240000,
    prompt: `${transcriptOf(messages)}\n\n---\nWrite the summary now.\n${instructions}`,
  }).catch(() => null)
  if (r?.usage) S.records.push({ v: 1, kind: 'model-call', purpose: 'compaction', at: await now($), sessionId: S.sessionId, ok: !!r.isAnswered, model: (r.usage as any).model ?? S.cfg.compactModel, usage: usageOf(r.usage), usd: { value: round6(usageUsd(usageOf(r.usage), ANTHROPIC.rates.haiku)), basis: 'measured', source: `${ANTHROPIC.provider} ${ANTHROPIC.checkedAt}` } })
  await flush($) // a manual /compact has no turn.complete after it: write the compaction record now
  if (!r || !r.isAnswered || r.text.trim().length < 200) return next({ ...e, instructions })
  return { messages: [{ role: 'user' as const, text: `This session continues from an earlier conversation that ran out of context. The summary below, written by Haiku for AutoMode, covers it.\n\n${r.text.trim()}\n\nContinue from where it left off without asking the user further questions.`, toolUses: [] }] }
}

const TIER_ORDER: Tier[] = ['T0', 'T1', 'T2', 'T3', 'T4']

// ---------------------------------------------------------------- the UI's view of the router (hooks/ui)

// noteJudge and noteLedger keep running sums of prices already computed for the records; noteAgent and noteVerdict
// copy what a spawn and a decision already carry. None of them is read by routing.
function noteJudge(usd: number) {
  S.ledger = { ...S.ledger, judgeUsd: round6(S.ledger.judgeUsd + usd), judgeCalls: S.ledger.judgeCalls + 1 }
}
function noteLedger(model: string, u: TokenUsage, usd: number, agentId?: string) {
  const L = S.ledger
  const row = L.byModel[model] ?? { usd: 0, requests: 0 }
  S.ledger = {
    ...L, requests: L.requests + 1, byModel: { ...L.byModel, [model]: { usd: round6(row.usd + usd), requests: row.requests + 1 } },
    cacheRead: L.cacheRead + u.cacheRead, cacheWrite: L.cacheWrite + u.cacheWrite5m + u.cacheWrite1h,
    subagentUsd: agentId !== undefined ? round6(L.subagentUsd + usd) : L.subagentUsd,
  }
  const a = agentId !== undefined ? U.agents.get(agentId) : undefined
  if (a) U.agents.set(agentId!, { ...a, model, usd: round6((a.usd ?? 0) + usd) })
}
const MAX_UI_AGENTS = 40
function noteAgent(res: any, e: any, model: string | undefined, routed: boolean, effort?: Effort) {
  if (!res?.agentId) return
  U.agents.set(res.agentId, {
    id: res.agentId, type: String(e.subagentType ?? 'agent'), model: model ?? e.model ?? null, effort: effort ?? null, routed, explicit: !!e.model,
    status: 'running', result: null, workflow: e.workflow?.runId ? { runId: String(e.workflow.runId), index: Number(e.workflow.agentIndex) || 0 } : null,
    label: typeof e.description === 'string' ? e.description.slice(0, 60) : null, usd: null, startedAt: Date.now(),
  })
  if (U.agents.size > MAX_UI_AGENTS) U.agents.delete(U.agents.keys().next().value as string)
}
function noteVerdict(d: Decision) {
  const chosen = d.auto?.verdicts?.[d.route.family]
  const by = d.route.owner === 'user-override' || d.override ? 'You' : chosen?.ok || d.answer ? 'Judge' : 'Rule'
  U.verdict = { by, why: (chosen?.ok && chosen.why) || d.route.reason || '', confidence: d.answer?.confidence ?? null }
  U.candidates = (d.auto?.candidates ?? []).slice(0, 6).map((c) => ({ route: c.route, eligibility: c.eligibility, usd: Number.isFinite(c.usd) ? c.usd : null, why: (c.why ?? []).join('; ') }))
}

// v4Snapshot: the router's state as the UI reads it. Copies; computes nothing.
export function v4Snapshot(sessionModel: string | null, now: number): RouterSnap {
  const r = S.pending
  return {
    enabled: S.cfg.router === 'v4', killed: U.killed, activation: S.cfg.activation === 'picker' ? 'picker' : 'always',
    active: S.cfg.activation !== 'picker' || (!!sessionModel && sessionModel.trim() === S.cfg.pickerModel),
    mode: S.mode, configMode: U.configMode, sessionMode: S.sessionMode, policy: S.policy, providerGuard: S.providerGuard, provider: S.provider,
    routeModels: (S.cfg as { routeModels?: boolean }).routeModels !== false, subagentsEverySession: !!(S.cfg as { subagentsEverySession?: boolean }).subagentsEverySession, sessionModel,
    requested: r ? { family: r.family, model: r.model, effort: r.effort, owner: r.owner, reason: r.reason, floor: r.floor?.tier ?? '—' } : null,
    held: S.heldRoute ? { family: S.heldRoute.family, effort: S.heldRoute.effort } : null,
    effective: { model: S.cache?.model ?? null, effort: S.lastEffective ?? S.cache?.effort ?? null, at: S.cache?.lastRequestAt ?? null },
    deferredEffort: U.deferred, verdict: U.verdict, judging: U.judging,
    judgeDown: Object.entries(S.judgeBreaker).filter(([, b]) => (b?.until ?? 0) > now).map(([k]) => k),
    breakers: Object.entries(S.breakers).filter(([, b]) => b.openUntil > now).map(([k, b]) => ({ model: k.slice(k.indexOf(':') + 1), until: b.openUntil, cls: b.class ?? null })),
    inadequate: S.inadequate ? { shortfall: S.inadequate.shortfall, route: S.inadequate.route } : null,
    stage: S.workStage, planMode: S.planMode,
    review: { required: !!S.envelope?.reviewRequired.value, because: [...(S.envelope?.reviewRequired.because ?? [])] },
    lastCheck: S.lastCheck, ttlMs: S.ttl,
    warm: Object.fromEntries(Object.entries(S.warm).map(([f, w]) => [f, { until: w!.until, effort: w!.effort }])),
    candidates: U.candidates, agents: [...U.agents.values()], ledger: S.ledger,
  }
}

// setSessionMode: the bar's on/off switch, for this session only (never written to config). 'off' stops routing here;
// null returns to the configured mode. Restores first, so a reloaded module never saves fresh state over the snapshot.
export async function setSessionMode($: EngineInterface, m: Mode | null) {
  try { if (!S.restored) { S.sessionId = await sid($); await restore($) } } catch {}
  S.sessionMode = m
  S.loaded = false
  await loadV4($)
  if (S.restored) await persist($)
  await publish($)
}

// freshSession is the per-session routing state; config, mode, provider and priors are per process.
function freshSession() {
  return {
    current: null, pending: null, envelope: null, lastSummary: '', resetPending: true,
    votes: { tier: null, n: 0 }, requestsSinceSwitch: 0, verifiedSinceSwitch: false, cache: null, lastReply: '', lastPromptText: '',
    turnPrompt: new Map(), workers: new Map(), agents: new Map(), lastCheck: null, editedSinceCheck: false,
    toldJudgeDown: false, taskSeq: 0, lastOutcome: null, sessionId: 'unknown', restored: false, expectWorker: 0,
    warm: {}, turnRequests: new Map(), stayUp: 0, redoFloor: null, heldRoute: null, planMode: false, planExited: false, editLog: [],
    consulted: [], consultCounts: {}, resolvedCounts: {}, switchesThisTask: 0, lastDemand: null, stage: 'implement', workStage: 'implement', verifiedAfterPlan: false, judgedThisStage: false,
    compactedPending: false, requestsInPrompt: 0, basePrefix: 0, compactedAt: 0, basePrefixMeasured: false, lastMessageCount: 0,
    signalSeq: 0, signalCompactAt: 0, compactHookSeen: false, toldUserTier: false, sessionMode: null, ledger: emptyLedger(),
    judgeBreaker: {}, lastAuto: null, verdictCache: {}, taskDecision: null, decidedPlanMode: false, lastRisk: 'none', newInput: false, lastEffective: null, appEffort: undefined, appModel: undefined, sessionModel: undefined, pinFamily: undefined, pinEffort: undefined, judgeRiskTask: undefined,
    preflight: undefined, breakers: {}, lastNoResponse: null, failures: [], pendingErrors: [], signalErrorAt: 0, signalMode: '', compactionPricedAt: 0, haikuOutUntilCompaction: false, lastWorkBand: undefined, effortUnsupported: false, thinkingRisk: false, toldErrorClass: '', toldBreaker: false, firstPrefixSaved: false, inadequate: null, toldInadequateTask: '',
  }
}

// Test seam: the module state, for mod tests only.
export const __reset = () => {
  Object.assign(S, freshSession(), { cfg: V4_DEFAULTS, loaded: false, mode: 'off', records: [], priors: DEFAULT_PRIORS })
  resetU(); U.killed = false; U.configMode = 'off'
}

export async function useV4($: EngineInterface): Promise<boolean> {
  if (!S.loaded) await loadV4($)
  return S.cfg.router === 'v4'
}
