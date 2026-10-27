// The UI's named states, shared by the view tests (tests/ui-view.test.mjs), the kit tests (tests/ui.test.tsx) and the
// gallery (tools/render-band). Each state is the snapshots the router and the guardian would hand over, plus the UI's own
// state where the case is about the UI (the settings panel, a confirm card, minimal, Focus Mode, reduced motion).
export const NOW = 1_793_000_000_000
const MIN = 60_000

export const LEDGER = { requests: 14, byModel: { 'claude-sonnet-5-5': { usd: 0.98, requests: 11 }, 'claude-haiku-5-5': { usd: 0.06, requests: 3 } }, cacheRead: 412_000, cacheWrite: 61_000, judgeUsd: 0.031, judgeCalls: 6, subagentUsd: 0.06 }

export function router(over = {}) {
  return {
    enabled: true, killed: false, active: true, mode: 'auto', configMode: 'auto', sessionMode: null, policy: 'auto', providerGuard: false, provider: 'anthropic',
    routeModels: true, subagentsEverySession: true, sessionModel: 'claude-sonnet-5-5[1m]',
    requested: { family: 'sonnet', model: 'claude-sonnet-5-5', effort: 'high', owner: 'optimizer', reason: 'cheapest adequate', floor: 'T1' },
    held: null, effective: { model: 'claude-sonnet-5-5', effort: 'high', at: NOW - 2 * MIN }, deferredEffort: null,
    verdict: { by: 'Haiku', why: 'multi-file change with tests', confidence: 0.82 }, judging: false, judgeDown: [], breakers: [], inadequate: null,
    stage: 'implement', planMode: false, review: { required: false, because: [] }, lastCheck: null,
    warm: { sonnet: { until: NOW + 42 * MIN + 15_000, effort: 'high' } }, ttlMs: 60 * MIN,
    candidates: [{ route: 'haiku/medium', eligibility: 'ineligible', usd: 0.004, why: 'only one judge named Haiku' }, { route: 'sonnet/high', eligibility: 'eligible', usd: 0.021, why: 'cheapest eligible' }, { route: 'opus/medium', eligibility: 'eligible', usd: 0.058, why: '' }],
    agents: [], ledger: LEDGER,
    ...over,
  }
}
export function guard(over = {}) {
  return {
    enabled: true, killed: false, mode: 'auto', everySession: true, level: 'normal', reasons: [], outcomes: 2, sinceOutcome: { requests: 6, usd: 0.41 },
    gates: { requests: 55, usd: 4.5 }, turnUsd: 0.18, checkpoint: null, offer: null, restored: null, paused: null, continued: false, last: null,
    hardPause: true, autoCompact: true, reduceOutputs: true,
    ...over,
  }
}
export function usage(over = {}) {
  return { costUsd: 1.24, contextTokens: 76_000, window: 200_000, percent: 38, limits: [], ...over }
}
const agent = (over) => ({ id: over.id, type: 'automode:implementer', model: 'claude-sonnet-5-5', effort: 'medium', routed: true, explicit: false, status: 'done', result: 'ok', workflow: { runId: 'wf_7a1', index: 1 }, label: null, usd: 0.12, startedAt: NOW - 10 * MIN, ...over })

export const STATES = {
  'first-run': { router: router({ effective: { model: null, effort: null, at: null }, requested: null, verdict: null, warm: {}, ledger: { ...LEDGER, requests: 0, byModel: {} } }), guard: guard({ outcomes: 0, turnUsd: null }), usage: usage({ costUsd: null, contextTokens: null, percent: null }), ui: { welcome: true } },
  'auto-normal': {},
  'plain-opus': { router: router({ active: false, sessionModel: 'claude-opus-5-5', requested: null, effective: { model: 'claude-opus-5-5', effort: 'high', at: NOW - MIN }, verdict: null, warm: { opus: { until: NOW + 51 * MIN, effort: 'high' } } }) },
  'model-switch': { router: router({ requested: { family: 'opus', model: 'claude-opus-5-5', effort: 'high', owner: 'optimizer', reason: 'design decision across modules', floor: 'T3' }, verdict: { by: 'Haiku', why: 'architecture change across 4 modules', confidence: 0.9 } }), ui: { flashSince: NOW - 150 } },
  'effort-pending': { router: router({ requested: { family: 'sonnet', model: 'claude-sonnet-5-5', effort: 'high', owner: 'optimizer', reason: 'cheapest adequate', floor: 'T1' }, effective: { model: 'claude-sonnet-5-5', effort: 'medium', at: NOW - MIN }, deferredEffort: 'high' }) },
  'cache-warm': { router: router({ requested: { family: 'opus', model: 'claude-opus-5-5', effort: 'high', owner: 'cache-hold', reason: 'cache warm: switching rewrites 140k tokens', floor: 'T2' }, effective: { model: 'claude-opus-5-5', effort: 'high', at: NOW - MIN }, warm: { opus: { until: NOW + 57 * MIN, effort: 'high' } } }) },
  'cache-cold': { router: router({ warm: { sonnet: { until: NOW - 4 * MIN, effort: 'high' } } }), usage: usage({ contextTokens: 142_000, percent: 71 }) },
  'large-context': { usage: usage({ contextTokens: 176_000, percent: 88, costUsd: 6.81 }) },
  'quality-escalation': { router: router({ requested: { family: 'opus', model: 'claude-opus-5-5', effort: 'high', owner: 'quality-escalation', reason: 'same check failed twice', floor: 'T3' }, effective: { model: 'claude-opus-5-5', effort: 'high', at: NOW - 20_000 }, warm: { opus: { until: NOW + 59 * MIN, effort: 'high' } } }) },
  'judge-failure': { router: router({ judgeDown: ['effortless', 'automode'], verdict: null }) },
  'workflow-plan': { router: router({ stage: 'plan', agents: [agent({ id: 'a1', type: 'automode:explorer', model: 'claude-haiku-5-5', label: 'discover:interfaces', index: 1 }), agent({ id: 'a2', type: 'automode:explorer', model: 'claude-haiku-5-5', label: 'discover:tests' }), agent({ id: 'a3', type: 'automode:architect', model: 'claude-opus-5-5', status: 'running', result: null, label: 'plan', usd: null })] }) },
  'parallel-build': { router: router({ stage: 'implement', agents: [agent({ id: 'a1', type: 'automode:explorer', model: 'claude-haiku-5-5', label: 'discover:interfaces' }), agent({ id: 'a3', type: 'automode:architect', model: 'claude-opus-5-5', label: 'plan', usd: 0.44 }), agent({ id: 'a4', status: 'running', result: null, label: 'build:ui-bar', usd: null }), agent({ id: 'a5', status: 'running', result: null, label: 'build:settings', usd: null }), agent({ id: 'a6', label: 'build:tokens' })] }) },
  'verify-review': { router: router({ stage: 'review', review: { required: true, because: ['plugin config change'] }, lastCheck: { command: 'make test-plugin', passed: true }, agents: [agent({ id: 'a3', type: 'automode:architect', model: 'claude-opus-5-5', label: 'plan' }), agent({ id: 'a4', label: 'build:ui-bar' }), agent({ id: 'a7', type: 'automode:verifier', label: 'verify:1', result: 'failed', status: 'failed' }), agent({ id: 'a8', type: 'automode:verifier', label: 'verify:2' }), agent({ id: 'a9', type: 'automode:reviewer', model: 'claude-opus-5-5', status: 'running', result: null, label: 'review', usd: null })] }) },
  'guardian-warning': { guard: guard({ level: 'warning', reasons: ['the same Bash call ran 3 times'], sinceOutcome: { requests: 58, usd: 4.71 }, outcomes: 1 }) },
  'guardian-pause': { guard: guard({ level: 'pause', paused: { at: NOW - 30_000, reasons: ['third identical failure of make test'] }, sinceOutcome: { requests: 112, usd: 9.4 }, checkpoint: { at: NOW - 30_000, status: 'open', sum: '9f3a2c41', written: true } }) },
  'compact-advised': { guard: guard({ offer: { action: 'compact', at: NOW - 10_000, contextTokens: 168_000, saves: 'about $1.90 over the next requests' } }), usage: usage({ contextTokens: 168_000, percent: 84 }) },
  'handoff-confirm': { guard: guard({ offer: { action: 'clear', at: NOW - 10_000, contextTokens: 171_000, saves: 'about $2.40 over the next requests' }, checkpoint: { at: NOW - 10_000, status: 'closed', sum: '51c0de77', written: true } }), ui: { card: 'handoff' } },
  'checkpoint-restored': { guard: guard({ restored: { from: '4f1e2a9b-77c1', at: NOW - 5_000 }, outcomes: 0 }), usage: usage({ contextTokens: 31_000, percent: 16, costUsd: 0.12 }) },
  'settings': { ui: { settings: true } },
  'minimal': { ui: { layout: 'minimal' } },
  'focus-mode': { router: router({ agents: [agent({ id: 'a4', status: 'running', result: null, label: 'build:ui-bar', usd: null })] }), ui: { focus: true, working: true } },
  'routing-off': { router: router({ mode: 'off', sessionMode: 'off', requested: null, verdict: null }) },
  'router-disabled': { router: router({ killed: true }) },
  'reduced-motion': { router: router({ requested: { family: 'opus', model: 'claude-opus-5-5', effort: 'high', owner: 'optimizer', reason: 'design decision', floor: 'T3' } }), ui: { motion: 'reduced', flashSince: NOW - 150 } },
  'unknown-usage': { usage: usage({ costUsd: null, contextTokens: null, window: null, percent: null }), guard: guard({ turnUsd: null }) },
}

// stateOf: the snapshots of one named state, defaults filled in.
export function stateOf(name) {
  const s = STATES[name]
  if (!s) throw new Error(`no UI state ${name}`)
  return { name, router: s.router ?? router(), guard: s.guard ?? guard(), usage: s.usage ?? usage(), ui: s.ui ?? {}, now: NOW }
}
