// Policy auto keeps its records when its route moves into hooks/lib/auto-route.ts. A fixed corpus of sessions runs
// through the mocked engine, and every record it writes must match the snapshot in tests/golden/auto-route-records.ts.
// The mock clock is fixed, so the records are exact; only the session id is replaced.
// A change that moves a route on purpose updates the snapshot: set SNAPSHOT to null, run `claude plugin test .`,
// and collect the printed AUTO-ROUTE-SNAPSHOT lines, one [name, records] pair per case, into the file.
import { describe, expect, test } from 'claude-code/testing'
import { harness, judge, perModel, records, says } from './harness.ts'
import { SNAPSHOT } from './golden/auto-route-records.ts'

const auto = (o: Record<string, unknown> = {}) => ({ policy: 'auto', ...o })
const hard = judge({ tier: 'T3', complexity: 'complex' })
const round = async ($: any, h: any, text: string, turnId: string, model = 'claude-sonnet-5-5') => {
  await h.submit($, text)
  await h.step($, model, undefined, { turnId })
  await h.complete($, model, undefined, 'done', { turnId })
}
const failingCheck = async ($: any) => {
  await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
  await $.tool.call({ tool: 'Edit', file_path: 'parser.go', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
}

type Case = { name: string; setup: Record<string, unknown>; prefix?: number; run: ($: any, h: any) => Promise<void> }

const CASES: Case[] = [
  { name: 'second call for the model that can win', setup: auto({ judge: hard, effortJudge: perModel({ opus: ['opus', 'medium'], sonnet: ['opus', 'high'], haiku: ['opus', 'high'] }) }), run: async ($, h) => { await round($, h, 'design the cache layer for the decision records', 't1') } },
  { name: 'critical floor', setup: auto({ judge: judge({ tier: 'T3', complexity: 'complex', risk: 'critical', riskWhy: 'payment path' }), effortJudge: perModel({ sonnet: ['sonnet', 'high'], opus: ['opus', 'low'] }) }), run: async ($, h) => { await round($, h, 'change how the payment webhook retries', 't1') } },
  { name: 'simple task, one call', setup: auto({ judge: judge({ tier: 'T1', complexity: 'standard' }), effortJudge: perModel({ sonnet: ['sonnet', 'low'] }) }), run: async ($, h) => { await round($, h, 'add a --verbose flag to the usage script', 't1') } },
  { name: 'haiku lookup with both judges agreeing', setup: auto({ judge: judge({ tier: 'T0', complexity: 'trivial' }), effortJudge: says('haiku', 'low') }), run: async ($, h) => { await round($, h, 'what does the --dry-run flag do', 't1') } },
  {
    name: 'warm hold, then continue keeps the upgrade', prefix: 120_000,
    setup: auto({ judge: (p: string) => judge(p.includes('rename') ? { tier: 'T1', complexity: 'standard' } : { tier: 'T3', complexity: 'complex' }), effortJudge: (p: string) => (/Next message:\nrename/.test(p) ? perModel({ sonnet: ['sonnet', 'medium'] })(p) : perModel({ sonnet: ['opus', 'high'], opus: ['opus', 'high'] })(p)) }),
    run: async ($, h) => { await round($, h, 'rename the helper', 't1'); await round($, h, 'redesign the cache eviction', 't2'); await round($, h, 'continue', 't3') },
  },
  {
    name: 'T4 on a warm session moves at once', prefix: 120_000,
    setup: auto({ judge: (p: string) => judge(p.includes('rename') ? { tier: 'T1', complexity: 'standard' } : { tier: 'T4', complexity: 'complex' }), effortJudge: (p: string) => (/Next message:\nrename/.test(p) ? perModel({ sonnet: ['sonnet', 'medium'] })(p) : perModel({ sonnet: ['sonnet', 'low'], opus: ['opus', 'medium'] })(p)) }),
    run: async ($, h) => { await round($, h, 'rename the helper', 't1'); await round($, h, 'the eviction fix failed again', 't2') },
  },
  { name: 'failed effort judge on the first prompt', setup: auto({ judge: hard, effortJudge: null }), run: async ($, h) => { await round($, h, 'design the retry policy for the queue', 't1') } },
  { name: 'failed AutoMode judge on the first prompt', setup: auto({ judge: null }), run: async ($, h) => { await round($, h, 'add a health endpoint', 't1') } },
  { name: 'both judges fail', setup: auto({ judge: null, effortJudge: null }), run: async ($, h) => { await round($, h, 'add a health endpoint', 't1') } },
  {
    name: 'running model verdict fails mid-session', setup: auto({ judge: judge({ tier: 'T2', newTask: false }), effortJudge: (p: string) => (/Next message:\nnow/.test(p) && /Current: sonnet/.test(p) ? 'garbage' : says('sonnet', 'high')(p)) }),
    run: async ($, h) => { await round($, h, 'add a retry counter to the client', 't1'); await round($, h, 'now cover the timeout path too', 't2') },
  },
  {
    name: 'low confidence never downgrades', setup: auto({ judge: (p: string) => judge(p.includes('typo') ? { tier: 'T0', complexity: 'trivial', confidence: 0.2, newTask: true } : { tier: 'T3', complexity: 'complex' }), effortJudge: (p: string) => (/typo/.test(p) ? says('haiku', 'low')(p) : says('opus', 'high')(p)) }),
    run: async ($, h) => { await round($, h, 'design the sharding plan', 't1', 'claude-opus-5-5'); await round($, h, 'fix the typo in the readme', 't2', 'claude-opus-5-5') },
  },
  { name: 'am:opus fixes the model', setup: auto({ judge: hard, effortJudge: perModel({ opus: ['opus', 'high'] }) }), run: async ($, h) => { await round($, h, 'am:opus outline the cache layer', 't1') } },
  { name: 'effort command on the running model', setup: auto({ effortJudge: says('sonnet', 'medium') }), run: async ($, h) => { await round($, h, 'add a flag', 't1'); await round($, h, 'use high effort: now wire the flag through', 't2') } },
  { name: 'redo keeps the model', setup: auto({ judge: judge({ tier: 'T2' }), effortJudge: says('sonnet', 'high') }), run: async ($, h) => { await round($, h, 'add a retry counter to the client', 't1'); await round($, h, 'that is wrong, it still fails', 't2'); await round($, h, 'and log each retry', 't3') } },
  {
    name: 'repeated defect escalates', setup: auto({ judge: judge({ tier: 'T2', complexity: 'standard', newTask: false }), effortJudge: says('sonnet', 'high') }),
    run: async ($, h) => { await h.submit($, 'fix the failing parser test'); await h.step($); await failingCheck($); await $.tool.call({ tool: 'Edit', file_path: 'parser.go', old_string: 'b', new_string: 'c' }); await $.tool.call({ tool: 'Bash', command: 'go test ./...' }); await h.complete($); await round($, h, 'keep going on the parser', 't2') },
  },
  {
    name: 'challenge to finished hard work', prefix: 120_000,
    setup: auto({ judge: (p: string) => judge(p.includes('sure') ? { tier: 'T3', complexity: 'complex', newTask: false } : { tier: 'T3', complexity: 'complex' }), effortJudge: (p: string) => (/sure/.test(p) ? perModel({ sonnet: ['opus', 'high'], opus: ['opus', 'high'] })(p) : perModel({ sonnet: ['sonnet', 'high'], opus: ['opus', 'high'] })(p)) }),
    run: async ($, h) => { await round($, h, 'refactor the gateway id helpers', 't1'); await round($, h, 'are you sure? you missed the edge cases in the id parser', 't2') },
  },
  { name: 'executor shadow route', setup: auto({ config: { executor: 'sonnet', activation: 'always' }, judge: hard, effortJudge: perModel({ sonnet: ['opus', 'high'], opus: ['opus', 'high'] }) }), run: async ($, h) => { await round($, h, 'design the cache layer', 't1'); await round($, h, 'continue', 't2') } },
  { name: 'routeModels false keeps the app model', setup: { policy: 'auto', model: 'claude-opus-5-5', config: { routeModels: false }, judge: hard }, run: async ($, h) => { await round($, h, 'design the cache layer', 't1', 'claude-opus-5-5') } },
  {
    name: 'learned buckets start on opus', setup: auto({ config: { learning: true }, judge: judge({ tier: 'T2', newTask: true, confidence: 0.9 }), effortJudge: says('sonnet', 'high') }),
    run: async ($, h) => { await round($, h, 'add a retry counter to the client', 't1'); await round($, h, 'that is wrong, it still fails', 't2'); await round($, h, 'write a parser for the config format', 't3'); await round($, h, 'no, that broke the build', 't4'); await round($, h, 'add a cache layer to the fetcher', 't5') },
  },
]

describe('Policy auto records stay the same', () => {
  for (const [i, c] of CASES.entries()) {
    test(c.name, async ($, on) => {
      const id = `eq-${i}`
      const h = harness(on, { sessionId: id, ...c.setup })
      if (c.prefix) h.setPrefix(c.prefix)
      await c.run($, h)
      const got = JSON.parse(JSON.stringify(records(h.writes)).replaceAll(id, 'SESSION'))
      if (SNAPSHOT === null) console.log(`AUTO-ROUTE-SNAPSHOT ${JSON.stringify([c.name, got])}`)
      else expect(got).toEqual((SNAPSHOT as Record<string, unknown[]>)[c.name])
    })
  }
})
