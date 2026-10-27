#!/usr/bin/env node
// Guardian hot-path cost, $0: the pure work done per request and per tool call, and memory over a very long turn.
// The engine calls ($.session.usage, $.session.id, $.session.model) are host round-trips that this cannot time; it
// reports how many each event makes so they can be read against a live trace.
import { GUARDIAN_DEFAULTS as C, newTurn, observeTool, observeRequest, observeOutcome, assess, noteFor, reduceOutput, sealCheckpoint, buildCheckpoint } from '../hooks/lib/guardian.ts'

const N = Number(process.argv[2] ?? 5000)
const t = newTurn('perf', 0)
const before = process.memoryUsage().heapUsed
const t0 = performance.now()
for (let i = 0; i < N; i++) {
  observeRequest(t, 0.05)
  const o = observeTool(t, i % 25 === 24
    ? { tool: 'Bash', input: { command: 'npm test' }, isError: false, text: 'pass' }
    : { tool: i % 3 ? 'Read' : 'Edit', input: { file_path: `/repo/src/f${i % 400}.ts`, new_string: `v${i}` }, isError: false, text: 'x'.repeat(200) })
  if (o) observeOutcome(t, o, i)
  noteFor(t, assess(t, C))
}
const perEvent = (performance.now() - t0) / N
const heap = (process.memoryUsage().heapUsed - before) / 1024
const log = Array.from({ length: 20_000 }, (_, i) => `line ${i} ${'z'.repeat(40)}`).join('\n')
const r0 = performance.now(); reduceOutput(log, C.reduceAboveChars, '/x'); const reduceMs = performance.now() - r0
const cp = buildCheckpoint({ sessionId: 's', cwd: '/repo', at: 1, objective: 'x', closed: false, turn: t, filesRead: [], checks: [], approvals: [], restrictions: [], git: { branch: 'b', dirty: [] }, next: 'n' })
const s0 = performance.now(); const sealed = sealCheckpoint(cp); const sealMs = performance.now() - s0
console.log(JSON.stringify({
  events: N, msPerRequestAndTool: +perEvent.toFixed(4), heapGrowthKB: Math.round(heap), distinctCallKeys: Object.keys(t.calls).length,
  reduce1MBms: +reduceMs.toFixed(2), checkpointBytes: sealed.length, sealMs: +sealMs.toFixed(3),
  engineCallsPerEvent: { 'turn.step': 'session.id, session.model (activation), session.usage', 'tool.call': 'session.id, session.model', 'turn.complete': 'session.usage, 2 git reads when a checkpoint is due', 'prompt.submit': 'config.json read, env read' },
}, null, 1))
