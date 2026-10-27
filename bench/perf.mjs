#!/usr/bin/env node
// Router overhead, measured locally at $0: CPU time of the pure decision path per prompt and per
// trigger, record and snapshot sizes, and memory growth over many decisions. The judge's network
// latency is the separate A7 measurement (p50 1.40 s, p95 2.82 s), not repeated here.
import { performance } from 'node:perf_hooks'
import { ANTHROPIC } from '../hooks/lib/prices.ts'
import { demandOf, FLOOR_CAPABILITY, optimize, tierOf } from '../hooks/lib/optimizer.ts'
import { resolve } from '../hooks/lib/authority.ts'
import { DEFAULT_PARAMS } from '../hooks/lib/policy.ts'
import { prospectiveRisk } from '../hooks/lib/risk.ts'
import { trigger } from '../hooks/lib/triggers.ts'
import { newEnvelope } from '../hooks/lib/envelope.ts'

const cache = { model: 'claude-sonnet-5-5', effort: 'medium', prefixTokens: 80_000, lastRequestAt: 0, ttlMs: 300_000, effortSharesCache: true }
const text = 'the integration test deadlocks under load; find and fix the cause in src/setup/plugins.go'
function decision(i) {
  const v = { tier: ['T0', 'T1', 'T2', 'T3', 'T4'][i % 5], complexity: ['trivial', 'standard', 'complex'][i % 3], risk: 'none', effort: 'medium' }
  const consequence = prospectiveRisk(text, { risk: v.risk, why: '' }).level
  const d = demandOf({ ...v, consequence })
  const opt = optimize(d, { cache, warm: {}, now: 1, prices: ANTHROPIC, neutral: true }, { minCap: FLOOR_CAPABILITY.T0 })
  return resolve({ floor: { tier: 'T0', because: [] }, candidate: { tier: tierOf(opt.best.family, opt.best.effort), source: 'judge', confidence: 0.9, reason: 'x' }, effortHint: opt.best.effort, current: null,
    switchInput: { cache, now: 1, votes: 1, requestsSinceSwitch: 0, verifiedSinceSwitch: false, sameTask: false, risk: consequence, expectedOutputTokens: 600, prices: ANTHROPIC, params: DEFAULT_PARAMS } })
}
const time = (n, f) => { for (let i = 0; i < 200; i++) f(i); const t0 = performance.now(); for (let i = 0; i < n; i++) f(i); return (performance.now() - t0) / n }
const heap0 = process.memoryUsage().heapUsed
const perDecisionMs = time(5_000, decision)
const s = { haikuMaxContext: 80_000, longContextAt: 100_000, scopeThreshold: 4, judgedThisStage: false, verifiedAfterPlan: false }
const perTriggerMs = time(100_000, (i) => trigger(s, { kind: 'step-start', idleMs: i, ttlMs: 300_000 }))
const heap1 = process.memoryUsage().heapUsed
const env = newEnvelope('task-1', 'turn-1', text.repeat(20), 0, 'standard', prospectiveRisk(text, null))
const record = JSON.stringify({ kind: 'decision', effective: decision(1), optimizer: optimize(demandOf({ tier: 'T2', complexity: 'standard', risk: 'none' }), { cache, warm: {}, now: 1, prices: ANTHROPIC, neutral: true }).ranked.slice(0, 4) })
const report = {
  cost: '$0, local CPU only', node: process.version,
  perPromptDecisionMs: +perDecisionMs.toFixed(3), perTriggerMs: +perTriggerMs.toFixed(5),
  heapGrowthKbAfter105kCalls: Math.round((heap1 - heap0) / 1024),
  decisionRecordBytes: record.length, envelopeSnapshotBytes: JSON.stringify(env).length,
  hookBudgetMs: 10_000,
  note: 'The judge call (network, ~1.4 s p50) runs in flight and does not count against the 10 s hook budget; the CPU path above does.',
}
console.log(JSON.stringify(report, null, 2))
