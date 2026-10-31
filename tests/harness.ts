// Shared mod-test harness for the V4 router: the test's hooks stand for the engine (config, model, judge,
// requests, spawns, tools, files). `setPrefix` sets the prompt size each request reports, so tests can
// build a warm large context; the clock is the kit's mock clock.
import { mock } from 'claude-code/testing'
import { __reset, projectKey } from '../hooks/v4.ts'
import { __resetGuardian } from '../hooks/guardian.ts'

export const HM = 'claude-sonnet-5-5[1m]'
export const usage = (model: string, prompt = 30000) => ({ input_tokens: 500, output_tokens: 300, cache_read_input_tokens: prompt - 500, cache_creation_input_tokens: 0, model })
export const judge = (o: Record<string, unknown> = {}) => JSON.stringify({ tier: 'T1', complexity: 'standard', risk: 'none', riskWhy: '', strategy: 'direct', newTask: true, effort: 'medium', confidence: 0.9, why: 'feature', ...o })

// The model the effortless judge is asked about: its "Current: <model> / <effort>" line.
export const currentOf = (prompt: string) => (prompt.match(/Current: (\w+) \/ (\w+)/) ?? [])[1] ?? 'sonnet'
// The default effortless verdict: Sonnet at medium, upstream's answer for normal work, whatever model is asked about.
export const effortVerdict = (_prompt: string, effort = 'medium', model = 'sonnet') => JSON.stringify({ model, effort, sure: 0.9, why: 'x' })
// says: an effortless judge that names this model and effort for every question. A test that needs both judges to
// agree (for example on Haiku for a lookup) states it with says(), so the agreement is part of the test, not a default.
export const says = (model: string, effort = 'medium') => (p: string) => effortVerdict(p, effort, model)
// A per-model effortless judge for tests: `per` maps the model asked about to its [model, effort] verdict.
export const perModel = (per: Record<string, [string, string]>) => (p: string) => { const v = per[currentOf(p)] ?? ['sonnet', 'medium']; return effortVerdict(p, v[1], v[0]) }

export type Setup = { ratios?: number[]; preflight?: { systemChars: number; tools: number }; firstPrefixes?: Record<string, number[]>; firstPrefix?: number | null; policy?: string; config?: Record<string, unknown>; bash?: (command: string) => unknown; sessionId?: string; mode?: string; model?: string; judge?: string | null | ((p: string) => string); effortJudge?: string | null | ((p: string) => string); env?: Record<string, string>; workerAnswer?: string; tools?: Record<string, () => unknown>; failWrites?: RegExp; agentList?: () => unknown }

// The policy the suite runs under when a test names none. The test runtime has no process.env, so this is a constant.
const DEFAULT_POLICY: string | undefined = undefined

let harnesses = 0

export function harness(on: any, setup: Setup) {
  __reset()
  __resetGuardian()
  const judged: string[] = []
  const effortJudged: string[] = []
  let lastTier = 'T1'
  const steps: { model: string; effort?: unknown; agentId?: string }[] = []
  const spawned: { subagentType: string; model?: string }[] = []
  const registered: string[] = []
  const toolsRun: string[] = []
  const writes: Record<string, string> = {}
  const toasts: string[] = []
  const statuses: string[] = []
  const agentPrompts: string[] = []
  const commands: string[] = []
  let prefix = 30000
  harnesses += 1
  // A unique id per harness: the router keys its state by session id, so tests never share state.
  let sessionId = setup.sessionId ?? `sess-${harnesses}`
  let sessionModel = setup.model ?? HM
  const env: Record<string, string> = { ...(setup.env ?? {}) }
  // A fixed plugin data folder, so a test can seed the first-request prompt-size estimate that an earlier session
  // would have left there (policy: an unknown first prompt size never picks Haiku). `firstPrefix: null` is a first run.
  env.CLAUDE_PLUGIN_DATA ??= '/data'
  // Sizes are kept per project: the shared key (no working directory known) and the harness's own project.
  if (setup.firstPrefixes) writes[`${env.CLAUDE_PLUGIN_DATA}/first-prefix.json`] = JSON.stringify({ byProject: setup.firstPrefixes, ratios: setup.ratios ?? [] })
  else if (setup.firstPrefix !== null) writes[`${env.CLAUDE_PLUGIN_DATA}/first-prefix.json`] = JSON.stringify({ byProject: { unknown: [setup.firstPrefix ?? 60_000], [projectKey('/repo')]: [setup.firstPrefix ?? 60_000] } })
  // DEFAULT_POLICY runs the whole suite under one policy; a test that names a policy keeps it.
  // `policy: 'config'` sets no environment value, so the test reads the policy from config.json alone.
  if (setup.policy && setup.policy !== 'config') env.AUTOMODE_POLICY = setup.policy
  else if (DEFAULT_POLICY && setup.policy !== 'config') env.AUTOMODE_POLICY = DEFAULT_POLICY
  mock.env(on, env)
  let mode = setup.mode ?? 'auto'
  let failModel: string | null = null
  mock.store(on)
  on('session.id', () => ({ value: sessionId }))
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.model', () => ({ value: sessionModel }))
  on('ui.status', (_$: unknown, e: unknown) => { statuses.push(JSON.stringify(e)); return { value: undefined } })
  on('ui.toast', (_$: unknown, e: unknown) => { toasts.push(JSON.stringify(e)); return { value: undefined } })
  on('fs.read', (_$: unknown, e: { path: string }) => String(e.path).endsWith('config.json')
    ? { value: JSON.stringify({ router: 'v4', mode, activation: 'picker', pickerModel: HM, recordDecisions: true, ...(setup.config ?? {}) }) }
    : { value: writes[e.path] ?? '' })
  on('fs.exists', (_$: unknown, e: { path: string }) => ({ value: e.path in writes }))
  on('fs.write', (_$: unknown, e: { path: string; text: string }) => { if (setup.failWrites?.test(e.path)) throw new Error('disk full'); writes[e.path] = e.text; return { value: undefined } })
  // The status line's figures: context size and the session's priced cost (the guardian reads both).
  let contextTokens = 10000, usd = 0, usageFails = false
  on('session.usage', () => { if (usageFails) throw new Error('usage unavailable'); return { value: { startedAt: 0, context: { tokens: contextTokens, window: 1000000 }, rateLimits: [], cost: { usd } } } })
  const suggestions: string[] = []
  const aborts: string[] = []
  on('prompt.suggest', (_$: unknown, e: { text: string }) => { suggestions.push(e.text); return { isShown: true } })
  on('turn.abort', (_$: unknown, e: { turnId: string }) => { aborts.push(e.turnId); return { value: undefined } })
  on('session.messages', () => ({ value: [] }))
  on('session.start', () => ({ cwd: '/repo' }))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'engine summary', toolUses: [] }] }))
  on('agent.list', () => ({ value: setup.agentList ? setup.agentList() : [] }))
  // Preflight: the composed system prompt and the tool list, when a test gives them (else the calls fail, as on a host without them).
  if (setup.preflight) {
    const p = setup.preflight
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x'.repeat(p.systemChars), scope: 'shared' }] }))
    on('tool.list', () => ({ value: Array.from({ length: p.tools }, (_, i) => ({ name: `T${i}`, description: 'd'.repeat(36), mcp: false })) }))
  }
  on('tool.register', (_$: unknown, e: { name: string }) => { registered.push(e.name); return { value: { tool: `mcp__automode__${e.name}` } } })
  on('model.complete', (_$: unknown, e: { prompt: string; system?: string }) => {
    if (String(e.system).startsWith('You compact')) return { value: { isAnswered: true, text: 'S'.repeat(400), usage: usage('claude-haiku-5-5', 1000) } }
    // The effortless judge (policy auto): answered per model from its "Current: <model> / <effort>" line.
    if (String(e.system).startsWith('You choose which Claude model')) {
      effortJudged.push(String(e.prompt))
      const ej = typeof setup.effortJudge === 'function' ? setup.effortJudge(String(e.prompt)) : setup.effortJudge
      if (ej === null) return { value: { isAnswered: false, reason: 'api-error', status: 529 } }
      // Default: a fixed verdict (Sonnet at medium) that does not depend on the AutoMode judge's tier. The two judges
      // are independent, so a test that needs them to agree or disagree scripts the effortless verdict itself.
      return { value: { isAnswered: true, text: ej ?? effortVerdict(String(e.prompt)), usage: usage('claude-haiku-5-5', 900) } }
    }
    judged.push(String(e.prompt))
    const j = typeof setup.judge === 'function' ? setup.judge(String(e.prompt)) : setup.judge
    try { lastTier = JSON.parse(j ?? judge()).tier ?? lastTier } catch { /* an unparsed reply leaves the tier */ }
    return j === null
      ? { value: { isAnswered: false, reason: 'api-error', status: 529 } }
      : { value: { isAnswered: true, text: j ?? judge(), usage: usage('claude-haiku-5-5', 900) } }
  })
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => ({ text: e.text, context: e.context ?? [] }))
  on('prompt.attachment', (_$: unknown, e: { text: string }) => ({ text: e.text }))
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number; model: string; effort?: unknown; agentId?: string }) {
    steps.push({ model: e.model, effort: e.effort, agentId: e.agentId })
    if (failModel && e.model === failModel) return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: usage(e.model, prefix) }
  })
  on('turn.complete', (_$: unknown, e: { answer: string; usage?: unknown }) => ({ text: e.answer, usage: e.usage }))
  let nextAgent = 0
  on('agent.spawn', (_$: unknown, e: { subagentType: string; model?: string }) => { spawned.push({ subagentType: e.subagentType, model: e.model }); nextAgent += 1; return { model: e.model ?? 'x', agentId: `w${nextAgent}` } })
  on('tool.call', (_$: unknown, e: { tool: string; command?: string }) => {
    toolsRun.push(e.tool)
    if (e.command !== undefined) commands.push(e.command)
    if (setup.tools?.[e.tool]) return setup.tools[e.tool]()
    if (setup.bash && e.tool === 'Bash') return setup.bash(String(e.command))
    if (e.tool === 'Bash' && /go test/.test(String(e.command))) return { result: 'Error: Exit code 1\n--- FAIL: TestX (0.00s)\n    x_test.go:9: got 1 want 2\nFAIL', isError: true, text: '' }
    if (e.tool === 'Agent') agentPrompts.push(String((e as any).prompt))
    if (e.tool === 'Agent') { spawned.push({ subagentType: String((e as any).subagent_type), model: (e as any).model }); return { result: setup.workerAnswer ?? 'not json' } }
    return { result: {}, text: 'ok' }
  })
  return {
    judged, effortJudged, steps, spawned, registered, toolsRun, writes, toasts, statuses, clock, agentPrompts, commands, suggestions, aborts,
    setUsage: (o: { usd?: number; context?: number; fails?: boolean }) => { if (o.usd !== undefined) usd = o.usd; if (o.context !== undefined) contextTokens = o.context; if (o.fails !== undefined) usageFails = o.fails },
    // The engine fires turn.start itself; the guardian also starts a turn at its first request, so tests need nothing here.
    turnStart: async (_$: any) => {},
    setPrefix: (n: number) => { prefix = n },
    setMode: (m: string) => { mode = m },
    // The provider refuses this model (no response): for provider-unavailability tests.
    failModel: (m: string | null) => { failModel = m },
    // A second session in the same process: new id, optional model; module state starts over.
    setSession: (id: string, model?: string) => { sessionId = id; if (model) sessionModel = model; __reset(); __resetGuardian() },
    start: async ($: any, surface: string | null = null) => $.session.start({ cwd: '/repo', surface, isInteractive: true }),
    submit: async ($: any, text: string, over: Record<string, unknown> = {}) => (await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...over })) as { context: string[] },
    step: async ($: any, model = 'claude-sonnet-5-5', agentId?: string, over: Record<string, unknown> = {}) => {
      const s = $.turn.step({ turnId: 't1', index: 0, model, effort: 'medium', messageCount: 3, ...(agentId ? { agentId } : {}), ...over })
      for await (const _ of s) { /* drain */ }
      return s.result
    },
    complete: async ($: any, model = 'claude-sonnet-5-5', agentId?: string, answer = 'done', over: Record<string, unknown> = {}) =>
      $.turn.complete({ answer, durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer', usage: usage(model), ...(agentId ? { agentId } : {}), ...over }),
  }
}

export const records = (writes: Record<string, string>) => Object.entries(writes).filter(([k]) => /\/records\/[^/]+\.jsonl$/.test(k) || k.endsWith('decisions.jsonl')).flatMap(([, v]) => v.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)))

