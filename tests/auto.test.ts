// AutoMode Auto (policy `auto`) end to end in the mocked engine: the effortless judge per model, the AutoMode
// judge, one joint choice, the resolution order, application at the request, helpers, fallbacks and rollback.
// The effortless judge is faked per model from its "Current: <model> / <effort>" line (harness perModel).
import { describe, expect, test } from 'claude-code/testing'
import { harness, judge, perModel, records } from './harness.ts'

const decisions = (r: any[]) => r.filter((x) => x.kind === 'decision')
const prompts = (r: any[]) => decisions(r).filter((x) => x.point === 'prompt')
const requests = (r: any[]) => r.filter((x) => x.kind === 'request' && x.agentId === undefined)
const hard = judge({ tier: 'T3', complexity: 'complex' })
const auto = (o: Record<string, unknown> = {}) => ({ policy: 'auto', ...o })

describe('Two judges, one joint choice', () => {
  test('call 1 uses the fixed anchor; a second call only for the model that can win; every call is recorded', async ($, on) => {
    const h = harness(on, auto({ judge: hard, effortJudge: perModel({ opus: ['opus', 'medium'], sonnet: ['opus', 'high'], haiku: ['opus', 'high'] }) }))
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' })
    expect(h.judged.length).toBe(1)
    // The app model (Sonnet) first; it names Opus, so Sonnet is out and Opus is asked for its own effort. Haiku never.
    expect(h.effortJudged.map((p) => p.match(/Current: (\w+)/)?.[1])).toEqual(['sonnet', 'opus'])
    const d = prompts(records(h.writes))[0]
    expect(d.policy).toBe('auto')
    expect(d.compare.policy).toBe('legacy')
    expect(Object.keys(d.auto.verdicts).sort()).toEqual(['opus', 'sonnet'])
    expect(d.auto.candidates.find((c: any) => c.route.startsWith('sonnet')).eligibility).toBe('ineligible')
    expect(d.auto.candidates.find((c: any) => c.route.startsWith('haiku')).eligibility).toBe('ineligible')
    const calls = records(h.writes).filter((x) => x.kind === 'model-call')
    expect(calls.filter((x) => String(x.purpose).startsWith('effortless-judge')).length).toBe(2)
    expect(calls.every((x) => x.usd?.basis === 'measured' && x.usage && typeof x.ms === 'number' && x.model)).toBe(true)
    expect(d.costTotal.judgeUsd).toBeGreaterThan(0) // judge overhead is part of the decision's cost
  })

  test('critical work gets an Opus floor: an Opus low verdict runs at medium', async ($, on) => {
    const h = harness(on, auto({ judge: judge({ tier: 'T3', complexity: 'complex', risk: 'critical', riskWhy: 'payment path' }), effortJudge: perModel({ sonnet: ['sonnet', 'high'], opus: ['opus', 'low'] }) }))
    await h.submit($, 'change how the payment webhook retries')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' })
  })

  test('a simple task in a new conversation: one effortless call, no Opus', async ($, on) => {
    const h = harness(on, auto({ judge: judge({ tier: 'T1', complexity: 'standard' }), effortJudge: perModel({ sonnet: ['sonnet', 'low'] }) }))
    await h.submit($, 'add a --verbose flag to the usage script')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' })
    expect(h.effortJudged.length).toBe(1)
  })

  test('no automatic T3 to Opus: Sonnet at high runs when effortless says Sonnet does the job', async ($, on) => {
    const h = harness(on, auto({ judge: hard, effortJudge: perModel({ sonnet: ['sonnet', 'high'], opus: ['opus', 'high'] }) }))
    await h.submit($, 'refactor the gateway id helpers')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
    const d = prompts(records(h.writes))[0]
    expect(d.auto.candidates.find((c: any) => c.route.startsWith('sonnet')).eligibility).toBe('eligible')
    expect(d.auto.candidates.find((c: any) => c.route.startsWith('sonnet')).why.join(' ')).toContain('no rule requires opus')
    expect(h.effortJudged.length).toBe(1)
  })

  test('T3 with Sonnet at medium stays on Sonnet: the rule table has no effort test, and Sonnet\'s own verdict sets the effort', async ($, on) => {
    const h = harness(on, auto({ judge: hard, effortJudge: perModel({ sonnet: ['sonnet', 'medium'], opus: ['opus', 'high'] }) }))
    await h.submit($, 'design the cache layer')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
    expect(h.effortJudged.map((p) => p.match(/Current: (\w+)/)?.[1])).toEqual(['sonnet'])
  })

  test('a difficult task never reaches Haiku from an effort verdict', async ($, on) => {
    const h = harness(on, auto({ firstPrefix: 30_000, judge: judge({ tier: 'T2', complexity: 'complex' }), effortJudge: perModel({ sonnet: ['haiku', 'high'], haiku: ['haiku', 'high'] }) }))
    await h.submit($, 'fix the flaky pipeline in the release job')
    await h.step($)
    expect(h.steps[0].model).toBe('claude-sonnet-5-5')
    expect(prompts(records(h.writes))[0].auto.candidates.find((c: any) => c.route.startsWith('haiku')).eligibility).toBe('ineligible')
  })

  test('a lookup both judges call Haiku goes to Haiku at Haiku\'s own effort', async ($, on) => {
    const h = harness(on, auto({ firstPrefix: 30_000, judge: judge({ tier: 'T0', complexity: 'trivial' }), effortJudge: perModel({ sonnet: ['haiku', 'low'], haiku: ['haiku', 'medium'] }) }))
    await h.submit($, 'where is the output folder written?')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'medium' })
    expect(h.effortJudged.map((p) => p.match(/Current: (\w+)/)?.[1])).toEqual(['sonnet', 'haiku'])
  })

  test('the AutoMode tier never picks the effort, and a model without its own verdict is never priced', async ($, on) => {
    const h = harness(on, auto({ judge: judge({ tier: 'T2' }), effortJudge: perModel({ sonnet: ['sonnet', 'xhigh'], opus: ['opus', 'low'] }) }))
    await h.submit($, 'make the importer keep the record order')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'xhigh' })
    const c = prompts(records(h.writes))[0].auto.candidates
    expect(c.find((x: any) => x.route.startsWith('opus')).eligibility).toBe('needs-verdict') // no effort borrowed from Sonnet
  })
})

describe('The task decides the route, not the start model', () => {
  const start = (model: string) => ({ model, config: { activation: 'always' } }) // a session that starts on this model
  const ROUTINE = { judge: judge({ tier: 'T1', complexity: 'standard' }), effortJudge: perModel({ sonnet: ['sonnet', 'medium'], opus: ['opus', 'medium'] }) }
  for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5']) {
    test(`a routine first prompt on ${model}: one anchored call, Sonnet at its own verdict`, async ($, on) => {
      const h = harness(on, auto({ ...ROUTINE, ...start(model) }))
      await h.submit($, 'add a --verbose flag to the usage script')
      await h.step($, model)
      expect(h.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
      expect(h.effortJudged.map((p) => p.match(/Current: (\w+)/)?.[1])).toEqual(['sonnet'])
      expect(prompts(records(h.writes))[0].auto.need).toEqual({ anchor: 'sonnet', verdict: 'sonnet/medium' })
    })
    test(`one judge naming Opus over T1 on ${model} does not force Opus`, async ($, on) => {
      const h = harness(on, auto({ ...start(model), judge: judge({ tier: 'T1', complexity: 'standard' }), effortJudge: perModel({ sonnet: ['opus', 'medium'], opus: ['opus', 'medium'] }) }))
      await h.submit($, 'parse the xml attribute order')
      await h.step($, model)
      expect(h.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
    })
  }

  test('a hard first prompt on Opus: the anchor is asked first, both judges name Opus, and Opus runs at its own verdict', async ($, on) => {
    const h = harness(on, auto({ ...start('claude-opus-5-5'), judge: hard, effortJudge: perModel({ sonnet: ['opus', 'high'], opus: ['opus', 'xhigh'] }) }))
    await h.submit($, 'design the cache layer')
    await h.step($, 'claude-opus-5-5')
    expect(h.effortJudged.map((p) => p.match(/Current: (\w+)/)?.[1])).toEqual(['sonnet', 'opus'])
    expect(h.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh' })
  })

  test('a cold Opus session asks the anchor and Opus, and routes as a Sonnet session does', async ($, on) => {
    const h = harness(on, auto({ judge: (p: string) => judge(p.includes('design') ? { tier: 'T4', complexity: 'complex' } : { tier: 'T1', complexity: 'standard', newTask: true }), effortJudge: perModel({ sonnet: ['sonnet', 'medium'], opus: ['opus', 'high'] }) }))
    h.setPrefix(120_000)
    await h.submit($, 'design the cache layer')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.clock.advance(2 * 3_600_000)
    h.effortJudged.length = 0
    await h.submit($, 'add a --verbose flag to the usage script')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(h.effortJudged.map((p) => p.match(/Current: (\w+)/)?.[1])).toEqual(['sonnet', 'opus'])
    expect(h.steps[1]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
  })

  test('a warm Opus session that holds runs at the verdict asked about Opus', async ($, on) => {
    const h = harness(on, auto({ judge: (p: string) => judge(p.includes('design') ? { tier: 'T4', complexity: 'complex' } : { tier: 'T1', complexity: 'standard' }), effortJudge: perModel({ sonnet: ['sonnet', 'medium'], opus: ['opus', 'low'] }) }))
    h.setPrefix(120_000)
    await h.submit($, 'design the cache layer')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'and a small helper for it')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(h.steps[1]).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' })
    expect(prompts(records(h.writes))[1].effective.owner).toBe('cache-policy')
  })

  test('an upgrade only the judges ask for waits for the vote gate on a warm session', async ($, on) => {
    const h = harness(on, auto({ judge: (p: string) => judge(p.includes('rename') ? { tier: 'T1', complexity: 'standard' } : { tier: 'T3', complexity: 'complex' }), effortJudge: (p: string) => (/Next message:\nrename/.test(p) ? perModel({ sonnet: ['sonnet', 'medium'] })(p) : perModel({ sonnet: ['opus', 'high'], opus: ['opus', 'high'] })(p)) }))
    h.setPrefix(120_000)
    await h.submit($, 'rename the helper')
    await h.step($)
    await h.complete($)
    await h.submit($, 'redesign the cache eviction')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    expect(h.steps[1].model).toBe('claude-sonnet-5-5')
    const held = prompts(records(h.writes))[1]
    expect(held.effective.check.gate).toBe('votes')
    expect(held.routing.underRouted).toBe('cache-policy') // the record still says the route runs below the rules
    await h.complete($, 'claude-sonnet-5-5', undefined, 'done', { turnId: 't2' })
    await h.submit($, 'now redesign the cache admission too')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't3' })
    expect(h.steps[2]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
  })

  test('"continue" after a held upgrade keeps the upgrade, not the hold', async ($, on) => {
    const h = harness(on, auto({ judge: (p: string) => judge(p.includes('rename') ? { tier: 'T1', complexity: 'standard' } : { tier: 'T3', complexity: 'complex' }), effortJudge: (p: string) => (/Next message:\nrename/.test(p) ? perModel({ sonnet: ['sonnet', 'medium'] })(p) : perModel({ sonnet: ['opus', 'high'], opus: ['opus', 'high'] })(p)) }))
    h.setPrefix(120_000)
    await h.submit($, 'rename the helper')
    await h.step($)
    await h.complete($)
    await h.submit($, 'redesign the cache eviction')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    expect(h.steps[1].model).toBe('claude-sonnet-5-5')
    await h.complete($, 'claude-sonnet-5-5', undefined, 'done', { turnId: 't2' })
    await h.submit($, 'continue')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't3' })
    expect(h.steps[2]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
  })

  test('T4 on a warm Sonnet session moves at once: a focused attempt already failed', async ($, on) => {
    const h = harness(on, auto({ judge: (p: string) => judge(p.includes('rename') ? { tier: 'T1', complexity: 'standard' } : { tier: 'T4', complexity: 'complex' }), effortJudge: (p: string) => (/Next message:\nrename/.test(p) ? perModel({ sonnet: ['sonnet', 'medium'] })(p) : perModel({ sonnet: ['sonnet', 'low'], opus: ['opus', 'medium'] })(p)) }))
    h.setPrefix(120_000)
    await h.submit($, 'rename the helper')
    await h.step($)
    await h.complete($)
    await h.submit($, 'the eviction fix failed again')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    expect(h.steps[1]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    expect(prompts(records(h.writes))[1].effective.owner).toBe('quality-escalation')
  })

  test('a held T3 task never runs at low: the hold takes the effort the optimizer gave the running model', async ($, on) => {
    const h = harness(on, auto({ judge: (p: string) => judge(p.includes('rename') ? { tier: 'T1', complexity: 'standard' } : { tier: 'T3', complexity: 'complex' }), effortJudge: (p: string) => (/Next message:\nrename/.test(p) ? perModel({ sonnet: ['sonnet', 'medium'] })(p) : perModel({ sonnet: ['opus', 'low'], opus: ['opus', 'high'] })(p)) }))
    h.setPrefix(120_000)
    await h.submit($, 'rename the helper')
    await h.step($)
    await h.complete($)
    await h.submit($, 'redesign the cache eviction')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    expect(h.steps[1]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
  })

  test('the own-verdict call fails and the need answered: the rules still decide, and Haiku still needs both judges', async ($, on) => {
    const effortJudge = (p: string) => (p.includes('where is') && p.includes('Current: opus') ? 'no verdict' : perModel({ sonnet: ['sonnet', 'medium'], opus: ['opus', 'high'] })(p))
    const h = harness(on, auto({ judge: (p: string) => judge(p.includes('where is') ? { tier: 'T0', complexity: 'trivial', newTask: true } : { tier: 'T4', complexity: 'complex' }), effortJudge }))
    h.setPrefix(30_000)
    await h.submit($, 'design the cache layer')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.clock.advance(2 * 3_600_000)
    await h.submit($, 'where is the output folder written?')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(h.steps[1]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
    const d = prompts(records(h.writes))[1]
    expect(d.auto.need).toEqual({ anchor: 'sonnet', verdict: 'sonnet/medium' })
    expect(d.auto.fallback).toBeTruthy()
  })

  test('the need call fails and the running model answers: the model stays', async ($, on) => {
    const effortJudge = (p: string) => (p.includes('hour later') && p.includes('Current: sonnet') ? 'no verdict' : perModel({ sonnet: ['opus', 'high'], opus: ['opus', 'high'] })(p))
    const h = harness(on, auto({ judge: (p: string) => judge(p.includes('hour later') ? { tier: 'T1', complexity: 'standard' } : { tier: 'T3', complexity: 'complex' }), effortJudge }))
    h.setPrefix(120_000)
    await h.submit($, 'design the cache layer')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'an hour later, one more tweak')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(h.steps[1].model).toBe('claude-opus-5-5')
    const d = prompts(records(h.writes))[1]
    expect(d.auto.fallback).toContain('the need call failed')
    expect(d.auto.need).toEqual({ anchor: 'sonnet', verdict: null })
  })

  test('an outcome names the route and the AutoMode tier', async ($, on) => {
    const h = harness(on, auto(ROUTINE))
    await h.submit($, 'add a --verbose flag to the usage script')
    await h.step($)
    await h.complete($)
    const o = records(h.writes).find((x) => x.kind === 'outcome')
    expect(o.route).toBe('sonnet/medium')
    expect(o.tier).toBe('T1')
  })
})

describe('The six required transitions', () => {
  test('Opus xhigh, then Opus medium for a simple follow-up on the warm cache', async ($, on) => {
    let n = 0
    const h = harness(on, auto({
      judge: () => judge(n++ === 0 ? { tier: 'T3', complexity: 'complex' } : { tier: 'T1', complexity: 'standard', newTask: true }),
      effortJudge: (p: string) => (p.includes('deadlock') && !p.includes('which file') ? perModel({ opus: ['opus', 'xhigh'], sonnet: ['opus', 'xhigh'] })(p) : perModel({ opus: ['sonnet', 'medium'], sonnet: ['sonnet', 'medium'] })(p)),
    }))
    h.setPrefix(120_000)
    await h.submit($, 'fix the intermittent deadlock in the flush path')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'which file holds the flush timer?')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(h.steps.map((s) => `${s.model}/${s.effort}`)).toEqual(['claude-opus-5-5/xhigh', 'claude-opus-5-5/medium'])
    expect(prompts(records(h.writes))[1].effective.owner).toBe('cache-policy')
  })

  test('Sonnet medium, then Sonnet high for harder implementation, then Sonnet medium after completion', async ($, on) => {
    const verdicts: Record<string, Record<string, [string, string]>> = {
      rename: { sonnet: ['sonnet', 'medium'], opus: ['opus', 'low'] },
      importer: { sonnet: ['sonnet', 'high'], opus: ['opus', 'high'] },
      readme: { sonnet: ['sonnet', 'medium'], opus: ['opus', 'medium'] },
    }
    const key = (p: string) => (p.includes('rename') ? 'rename' : p.includes('importer') ? 'importer' : 'readme')
    const tiers: Record<string, string> = { rename: 'T1', importer: 'T2', readme: 'T1' }
    const h = harness(on, auto({ judge: (p: string) => judge({ tier: tiers[key(p)], newTask: true }), effortJudge: (p: string) => perModel(verdicts[key(p.split('Next message:').pop()!)])(p) }))
    h.setPrefix(60_000)
    await h.submit($, 'rename retryCount to attempts')
    await h.step($)
    await h.complete($)
    await h.submit($, 'now make the importer stream records in order')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    await h.complete($, 'claude-sonnet-5-5', undefined, 'done', { turnId: 't2' })
    await h.submit($, 'update the readme line about the flag')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't3' })
    expect(h.steps.map((s) => `${s.model}/${s.effort}`)).toEqual(['claude-sonnet-5-5/medium', 'claude-sonnet-5-5/high', 'claude-sonnet-5-5/medium'])
  })

  test('Opus high moves to xhigh only when the verdict asks for it', async ($, on) => {
    const h = harness(on, auto({ judge: hard, effortJudge: (p: string) => perModel({ opus: ['opus', /Next message:\n(prove|verify)/.test(p) ? 'xhigh' : 'high'], sonnet: ['opus', 'xhigh'] })(p) }))
    h.setPrefix(80_000)
    await h.submit($, 'design the cache layer')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'now design the eviction policy for it')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    await h.complete($, 'claude-opus-5-5', undefined, 'done', { turnId: 't2' })
    await h.submit($, 'prove the eviction policy never drops a pinned record under concurrent writers')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't3' })
    expect(h.steps.map((s) => s.effort)).toEqual(['high', 'high', 'xhigh'])
  })

  test('a thank-you after xhigh work is judged and runs low; "continue" afterwards keeps the unfinished task, not the thank-you', async ($, on) => {
    const h = harness(on, auto({
      judge: (p: string) => (p.includes('thanks') ? judge({ tier: 'T0', complexity: 'trivial', newTask: false }) : hard),
      effortJudge: (p: string) => (/Next message:\nthanks/.test(p) ? perModel({ opus: ['haiku', 'low'], sonnet: ['haiku', 'low'], haiku: ['haiku', 'low'] })(p) : perModel({ opus: ['opus', 'xhigh'], sonnet: ['opus', 'xhigh'] })(p)),
    }))
    h.setPrefix(120_000)
    await h.submit($, 'fix the intermittent deadlock in the flush path')
    await h.step($)
    await h.complete($, 'claude-opus-5-5', undefined, 'Step 1 of 3 is in. Next I fix the timer.')
    const judgedBefore = h.effortJudged.length
    await h.submit($, 'thanks')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(h.effortJudged.length).toBeGreaterThan(judgedBefore) // an acknowledgment is judged, never kept by length
    expect(h.steps[1]).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' })
    await h.complete($, 'claude-opus-5-5', undefined, 'Next I fix the timer.', { turnId: 't2' })
    const before = h.effortJudged.length
    await h.submit($, 'continue')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't3' })
    expect(h.effortJudged.length).toBe(before) // upstream keepsEffort: no judge call
    expect(h.steps[2]).toMatchObject({ model: 'claude-opus-5-5', effort: 'xhigh' })
    expect(prompts(records(h.writes))[2].method).toBe('continuation')
  })

  test('a repeated defect on Opus high goes to xhigh at the next request, never straight to max; max only after a repeat on xhigh', async ($, on) => {
    const failing = { result: 'Error: Exit code 1\n--- FAIL: TestPlanted (0.00s)\n    c_test.go:9: got 1 want 2\nFAIL', isError: true, text: '' }
    const h = harness(on, auto({ judge: hard, effortJudge: perModel({ opus: ['opus', 'high'], sonnet: ['opus', 'high'] }), bash: () => failing }))
    await h.submit($, 'TestPlanted in src/config fails; find the cause and fix it')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/' })
    await $.tool.call({ tool: 'Edit', file_path: 'c.go', old_string: 'a', new_string: 'b' })
    const second = await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/' })
    expect(JSON.stringify(second)).toContain('escalated to T3 (opus xhigh)')
    // The next request of the same turn: a tool-result continuation, but the escalation note is new input.
    await h.step($, 'claude-opus-5-5', undefined, { index: 3 })
    expect(h.steps[1].effort).toBe('xhigh')
    const req = requests(records(h.writes)).at(-1)
    expect(req.application).toMatchObject({ requested: 'xhigh', effective: 'xhigh', deferred: false })
    expect(records(h.writes).filter((x) => x.kind === 'escalation').at(-1)).toMatchObject({ band: 4, route: 'opus/xhigh' })
    await $.tool.call({ tool: 'Edit', file_path: 'c.go', old_string: 'b', new_string: 'c' })
    await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/' })
    await h.step($, 'claude-opus-5-5', undefined, { index: 5 })
    expect(h.steps[2].effort).toBe('max')
  })
})

describe('Application at the request: requested, legal and effective effort', () => {
  test('a lower pick typed mid-turn waits for the turn to end; the request record says what was in effect', async ($, on) => {
    const h = harness(on, auto({
      judge: (p: string) => (p.includes('typo') ? judge({ tier: 'T1', newTask: false }) : hard),
      effortJudge: (p: string) => (/Next message:\nalso fix the typo/.test(p) ? perModel({ opus: ['opus', 'low'], sonnet: ['sonnet', 'low'] })(p) : perModel({ opus: ['opus', 'xhigh'], sonnet: ['opus', 'xhigh'] })(p)),
    }))
    h.setPrefix(120_000)
    await h.submit($, 'fix the intermittent deadlock in the flush path')
    await h.step($)
    await h.submit($, 'also fix the typo in the log line', { turnId: 't1' })
    expect(h.effortJudged.some((p) => p.includes('[Sent while the assistant was still working on the last task at xhigh effort.'))).toBe(true)
    await h.step($, 'claude-opus-5-5', undefined, { index: 1 })
    expect(h.steps[1].effort).toBe('xhigh') // the running task is not weakened
    await h.complete($, 'claude-opus-5-5')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(h.steps[2].effort).toBe('medium') // applied when the turn ended; a deadlock is critical, so the low pick meets the Opus floor
  })

  test('a lower effort chosen inside a turn without new input is requested at once and takes effect at the next new input', async ($, on) => {
    const failing = { result: 'Error: Exit code 1\n--- FAIL: TestPlanted (0.00s)\n    c_test.go:9: got 1 want 2\nFAIL', isError: true, text: '' }
    const passing = { result: 'ok  \texample/config\t0.2s', isError: false, text: '' }
    let fixed = false
    const h = harness(on, auto({ judge: hard, effortJudge: perModel({ opus: ['opus', 'high'], sonnet: ['opus', 'high'] }), bash: () => (fixed ? passing : failing) }))
    await h.submit($, 'TestPlanted in src/config fails; find the cause and fix it')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/' })
    await $.tool.call({ tool: 'Edit', file_path: 'c.go', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/' })
    await h.step($, 'claude-opus-5-5', undefined, { index: 3 }) // escalated: xhigh, legal through the note
    fixed = true
    await $.tool.call({ tool: 'Edit', file_path: 'c.go', old_string: 'b', new_string: 'c' })
    await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/' }) // passes: the floor ends, no note is added
    await h.step($, 'claude-opus-5-5', undefined, { index: 6 })
    const req = requests(records(h.writes)).at(-1)
    expect(req.application).toMatchObject({ requested: 'high', effective: 'xhigh', deferred: true })
    expect(req.application.legalAt).toContain('next new input')
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'continue')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(requests(records(h.writes)).at(-1).application.effective).toBe('high') // the next turn's input applies it
  })
})

describe('Plan Mode and its transitions', () => {
  const sig = (id: string) => `/cfg/plugins/data/automode/signals/${id}.json`
  const planSetup = (id: string, o: Record<string, unknown>) => auto({ sessionId: id, env: { CLAUDE_CONFIG_DIR: '/cfg' }, ...o })

  test('in plan mode the judge reads the real mode and no floor is added: a routine plan runs at its own verdict', async ($, on) => {
    const h = harness(on, planSetup('auto-plan', { judge: judge({ tier: 'T2', complexity: 'standard' }), effortJudge: perModel({ sonnet: ['sonnet', 'medium'], opus: ['opus', 'medium'] }) }))
    h.writes[sig('auto-plan')] = JSON.stringify({ seq: 1, permissionMode: 'plan', compactions: [] })
    await h.submit($, 'plan how to split the setup package')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' }) // no automatic high or xhigh
    expect(h.effortJudged.every((p) => p.startsWith('Mode: plan.'))).toBe(true)
    expect(prompts(records(h.writes))[0].stage).toBe('plan')
  })

  test('a plan exit mid-turn re-judges the implementation with both judges and re-routes on that', async ($, on) => {
    const h = harness(on, planSetup('auto-exit', {
      judge: (p: string) => (p.includes('IMPLEMENTATION work') ? judge({ tier: 'T1', complexity: 'standard' }) : hard),
      effortJudge: (p: string) => (p.includes('IMPLEMENTATION work') ? perModel({ opus: ['sonnet', 'medium'], sonnet: ['sonnet', 'medium'] })(p) : perModel({ opus: ['opus', 'high'], sonnet: ['opus', 'high'] })(p)),
    }))
    h.writes[sig('auto-exit')] = JSON.stringify({ seq: 1, permissionMode: 'plan', compactions: [] })
    await h.submit($, 'plan the migration of the sessions store')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'continue')
    h.writes[sig('auto-exit')] = JSON.stringify({ seq: 2, permissionMode: 'default', compactions: [] })
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(h.effortJudged.some((p) => p.includes('IMPLEMENTATION work') && !p.startsWith('Mode: plan'))).toBe(true)
    const r = records(h.writes)
    expect(r.some((x) => x.kind === 'rejudge' && x.event === 'plan-exit')).toBe(true)
    const t = decisions(r).find((x) => x.trigger?.event === 'plan-exit')
    expect(t.auto.candidates.find((c: any) => c.route.startsWith('sonnet')).eligibility).toBe('eligible')
    expect(t.auto.need).toEqual({ anchor: 'sonnet', verdict: 'sonnet/medium' })
    expect(h.effortJudged.filter((p) => p.includes('IMPLEMENTATION work')).map((p) => p.match(/Current: (\w+)/)?.[1])).toEqual(['sonnet', 'opus'])
  })

  test('a trigger that holds a stronger route runs the running model at its own verdict', async ($, on) => {
    const h = harness(on, planSetup('auto-held', {
      judge: (p: string) => (p.includes('IMPLEMENTATION work') ? hard : judge({ tier: 'T1', complexity: 'standard' })),
      effortJudge: (p: string) => (p.includes('IMPLEMENTATION work') ? perModel({ sonnet: ['opus', 'medium'], opus: ['opus', 'high'] })(p) : perModel({ sonnet: ['sonnet', 'high'] })(p)),
    }))
    h.setPrefix(120_000)
    h.writes[sig('auto-held')] = JSON.stringify({ seq: 1, permissionMode: 'plan', compactions: [] })
    await h.submit($, 'plan the migration of the sessions store')
    await h.step($)
    await h.complete($)
    await h.submit($, 'continue')
    h.writes[sig('auto-held')] = JSON.stringify({ seq: 2, permissionMode: 'default', compactions: [] })
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    const t = decisions(records(h.writes)).find((x) => x.trigger?.event === 'plan-exit')
    expect(t.effective.owner).toBe('cache-policy')
    expect(t.effective.effort).toBe('medium')
  })

  test('"continue" right after a plan exit is a required decision: it is judged, not kept', async ($, on) => {
    const h = harness(on, planSetup('auto-cont', { judge: hard, effortJudge: perModel({ opus: ['opus', 'high'], sonnet: ['opus', 'high'] }) }))
    h.writes[sig('auto-cont')] = JSON.stringify({ seq: 1, permissionMode: 'plan', compactions: [] })
    await h.submit($, 'plan the migration of the sessions store')
    await h.step($)
    await h.complete($, 'claude-opus-5-5', undefined, 'Here is the plan. Next I start the migration.')
    h.writes[sig('auto-cont')] = JSON.stringify({ seq: 2, permissionMode: 'default', compactions: [] })
    const before = h.effortJudged.length
    await h.submit($, 'continue')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(h.effortJudged.length).toBeGreaterThan(before)
    const d = prompts(records(h.writes)).at(-1)
    expect(d.auto.required).toContain('planExited')
    expect(d.stage).toBe('plan-approved')
  })
})

describe('Judge failures are state-aware and recorded', () => {
  test('the same task: the previous effort stays on the same model', async ($, on) => {
    let fail = false
    const h = harness(on, auto({ judge: hard, effortJudge: (p: string) => (fail ? null as any : perModel({ opus: ['opus', 'xhigh'], sonnet: ['opus', 'xhigh'] })(p)) }))
    h.setPrefix(80_000)
    await h.submit($, 'fix the intermittent deadlock in the flush path')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    fail = true
    await h.submit($, 'and also the race in the retry path of the same flush code')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(h.steps[1]).toMatchObject({ model: 'claude-opus-5-5' })
    const d = prompts(records(h.writes)).at(-1)
    expect(d.auto.fallback).toBeTruthy()
    expect(d.method).toBe('fallback')
  })

  test('a new task with a failed effort judge: the AutoMode judge decides the model, the cache check still applies', async ($, on) => {
    let n = 0
    const h = harness(on, auto({ judge: () => judge(n++ === 0 ? { tier: 'T3', complexity: 'complex' } : { tier: 'T1', newTask: true, effort: 'medium' }), effortJudge: (p: string) => (n > 1 ? null as any : perModel({ opus: ['opus', 'xhigh'], sonnet: ['opus', 'xhigh'] })(p)) }))
    h.setPrefix(80_000)
    await h.submit($, 'fix the intermittent deadlock in the flush path')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'write a changelog entry for the release')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2', effort: 'medium' })
    const d = prompts(records(h.writes)).at(-1)
    expect(d.auto.fallback).toContain('the AutoMode judge decides')
    expect(d.effective.check).toBeTruthy() // hold or switch is the cache check's call, recorded
    expect(h.steps[1].effort).toBe('medium') // never the old xhigh
  })
})

describe('A failed judge call never makes a costlier model win', () => {
  test('first prompt: the effortless call fails and the AutoMode judge says T0: the app model stays, Haiku is not taken from the tier', async ($, on) => {
    const h = harness(on, auto({ firstPrefix: null, judge: judge({ tier: 'T0', complexity: 'trivial' }), effortJudge: null }))
    await h.submit($, 'In one sentence: what does the add function do?')
    await h.step($)
    expect(h.steps[0].model).toBe('claude-sonnet-5-5')
    expect(prompts(records(h.writes))[0].auto.fallback).toContain('no previous decision')
    expect(h.effortJudged.length).toBe(2) // the id, then the alias after an error reply (529); no second-model call
  })

  test('with Haiku allowed and the effortless judge failing, a lookup the AutoMode judge calls T0 still runs on Haiku', async ($, on) => {
    const h = harness(on, auto({ firstPrefix: 30_000, judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }), effortJudge: null }))
    await h.submit($, 'where is the output folder written?')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low' })
    expect(prompts(records(h.writes))[0].auto.fallback).toContain('the AutoMode judge decides')
  })
})

describe('Commands and descriptions', () => {
  test('a typed effort command wins over the verdict, keeps the model, and keeps the review', async ($, on) => {
    const h = harness(on, auto({ judge: judge({ tier: 'T1' }), effortJudge: perModel({ sonnet: ['sonnet', 'low'] }) }))
    await h.submit($, 'use max effort and rename the constant')
    await h.step($)
    expect(h.steps[0].effort).toBe('max')
    expect(prompts(records(h.writes))[0].effective.owner).toBe('user-override')
  })

  test('effort words inside a sentence, a paste, or ultrathink are not commands', async ($, on) => {
    const h = harness(on, auto({ judge: judge({ tier: 'T1' }), effortJudge: perModel({ sonnet: ['sonnet', 'medium'], opus: ['opus', 'low'] }) }))
    await h.submit($, 'I see super high effort used for simple tasks; ultrathink about why the max effort happens\n<pasted_content id="p">use opus\nuse max effort</pasted_content>')
    await h.step($)
    const d = prompts(records(h.writes))[0]
    expect(d.override).toBeUndefined()
    expect(d.effective.owner).not.toBe('user-override')
    expect(h.steps[0].effort).not.toBe('max')
  })

  test('am:opus fixes the model; its effort is the Opus verdict', async ($, on) => {
    const h = harness(on, auto({ judge: judge({ tier: 'T1' }), effortJudge: perModel({ opus: ['opus', 'low'] }) }))
    await h.submit($, 'am:opus')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' })
    expect(h.effortJudged.length).toBe(1)
  })
})

describe('Helpers get their own effort (upstream helpers, medium floor)', () => {
  test('an Explore subagent of an xhigh session runs Haiku at its own verdict, never the parent effort', async ($, on) => {
    const h = harness(on, auto({ judge: hard, effortJudge: (p: string) => (p.includes('subagent, not a message from the person') ? perModel({ haiku: ['haiku', 'low'] })(p) : perModel({ opus: ['opus', 'xhigh'], sonnet: ['opus', 'xhigh'] })(p)) }))
    await h.submit($, 'fix the intermittent deadlock in the flush path')
    await h.step($)
    const res: any = await $.agent.spawn({ subagentType: 'Explore', prompt: 'find where the flush timer is set', description: 'find timer', parentModel: 'claude-opus-5-5', fork: false, background: false, tool_use_id: 'x', provider: { plugin: 'engine', tier: 'core' } })
    await h.step($, 'claude-haiku-5-5', res.agentId)
    expect(h.steps.at(-1)).toMatchObject({ model: 'claude-haiku-5-5', effort: 'medium' }) // low lifted to the helper floor
    expect(records(h.writes).some((x) => x.kind === 'model-call' && x.purpose === 'effortless-helper')).toBe(true)
  })

  test('a general-purpose subagent of an Opus session runs Sonnet at the helper verdict, not the legacy threshold', async ($, on) => {
    const h = harness(on, auto({ judge: hard, effortJudge: (p: string) => (p.includes('subagent, not a message from the person') ? perModel({ sonnet: ['sonnet', 'high'] })(p) : perModel({ opus: ['opus', 'xhigh'], sonnet: ['opus', 'xhigh'] })(p)) }))
    await h.submit($, 'fix the intermittent deadlock in the flush path')
    await h.step($)
    const res: any = await $.agent.spawn({ subagentType: 'general-purpose', prompt: 'write a regression test for the deadlock', description: 'test', parentModel: 'claude-opus-5-5', fork: false, background: false, tool_use_id: 'y', provider: { plugin: 'engine', tier: 'core' } })
    await h.step($, 'claude-sonnet-5-5', res.agentId)
    expect(h.steps.at(-1)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
  })
})

describe('Stability, availability and rollback', () => {
  test('an identical prompt in an unchanged task state reuses the verdicts with no judge call', async ($, on) => {
    const h = harness(on, auto({ judge: judge({ tier: 'T2', newTask: false }), effortJudge: perModel({ sonnet: ['sonnet', 'high'], opus: ['opus', 'medium'] }) }))
    h.setPrefix(60_000)
    const ask = async (turnId: string) => { await h.submit($, 'make the importer keep the record order'); await h.step($, 'claude-sonnet-5-5', undefined, { turnId }) }
    await ask('c1') // opens the task
    await ask('c2') // first judgment inside the task
    const n = h.judged.length + h.effortJudged.length
    await ask('c3') // unchanged state: cached
    expect(h.judged.length + h.effortJudged.length).toBe(n)
    const d = prompts(records(h.writes)).at(-1)
    expect(d.auto.steps.some((x: string) => x.startsWith('verdict cache'))).toBe(true)
    expect(d.effective.effort).toBe(prompts(records(h.writes)).at(-2).effective.effort)
  })

  test('routeModels false keeps the app model and routes the effort only', async ($, on) => {
    const h = harness(on, auto({ config: { routeModels: false }, judge: hard, effortJudge: perModel({ sonnet: ['sonnet', 'xhigh'], opus: ['opus', 'medium'] }) }))
    await h.submit($, 'design the cache layer')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'xhigh' })
    expect(h.effortJudged.every((p) => p.includes('Current: sonnet'))).toBe(true)
  })

  test('with Opus unavailable and Sonnet rejected by both judges, the route is labeled inadequate and keeps the review', async ($, on) => {
    const h = harness(on, auto({ judge: hard, effortJudge: perModel({ sonnet: ['opus', 'high'], haiku: ['opus', 'high'], opus: ['opus', 'high'] }) }))
    h.failModel('claude-opus-5-5')
    for (let i = 0; i < 3; i++) {
      await h.submit($, `design part ${i} of the cache layer`)
      await h.step($, 'claude-sonnet-5-5', undefined, { turnId: `f${i}` })
    }
    const out = await h.submit($, 'design the last part of the cache layer')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 'f9' })
    expect(h.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
    expect(out.context[0]).toContain('No available model meets this task')
    const d = prompts(records(h.writes)).at(-1)
    expect(d.inadequate).toBeTruthy()
    expect(d.risk.reviewRequired).toBe(true)
  })

  test('rollback: AUTOMODE_POLICY=legacy wins over a config that says auto, and asks no effortless judge', async ($, on) => {
    const h = harness(on, { policy: 'legacy', config: { policy: 'auto' }, judge: hard })
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    expect(prompts(records(h.writes))[0].policy).toBe('legacy')
    expect(h.effortJudged.length).toBe(0)
  })

  test('the retired v4.1 value runs legacy and says so once', async ($, on) => {
    const h = harness(on, { policy: 'config', config: { policy: 'v4.1' }, judge: hard })
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    expect(prompts(records(h.writes))[0].policy).toBe('legacy')
    expect(h.toasts.filter((t) => t.includes('replaced by'))).toHaveLength(1)
  })

  test('the config alone selects auto', async ($, on) => {
    const h = harness(on, { policy: 'config', config: { policy: 'auto' }, judge: hard })
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    expect(prompts(records(h.writes))[0].policy).toBe('auto')
  })
})

describe('Kept V4 and v4.1 behavior under policy auto', () => {
  const opusXhigh = perModel({ opus: ['opus', 'xhigh'], sonnet: ['opus', 'xhigh'] })

  test('a cache hold is recorded as over-routing with its owner', async ($, on) => {
    let n = 0
    const h = harness(on, auto({ judge: () => judge(n++ === 0 ? { tier: 'T3', complexity: 'complex' } : { tier: 'T1', newTask: true }), effortJudge: (p: string) => (/Next message:\nwhich file/.test(p) ? perModel({ opus: ['sonnet', 'medium'], sonnet: ['sonnet', 'medium'] })(p) : opusXhigh(p)) }))
    h.setPrefix(120_000)
    await h.submit($, 'fix the intermittent deadlock in the flush path')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'which file holds the flush timer?')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(prompts(records(h.writes))[1].routing).toMatchObject({ cheapestAdequate: 'sonnet/medium', chosen: 'opus/medium', overRouted: 'cache-policy' })
  })

  test('commit after xhigh work is judged on its own and keeps the model', async ($, on) => {
    const h = harness(on, auto({ judge: (p: string) => (/^commit/.test(p.split('\n').pop() ?? '') || p.includes('Message:\ncommit') ? judge({ tier: 'T0', complexity: 'trivial', newTask: false }) : hard), effortJudge: (p: string) => (/Next message:\ncommit/.test(p) ? perModel({ opus: ['opus', 'low'], sonnet: ['sonnet', 'low'], haiku: ['haiku', 'low'] })(p) : opusXhigh(p)) }))
    h.setPrefix(120_000)
    await h.submit($, 'fix the intermittent deadlock in the flush path')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    const before = h.effortJudged.length
    await h.submit($, 'commit')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(h.effortJudged.length).toBeGreaterThan(before)
    expect(h.steps[1]).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' })
    expect(prompts(records(h.writes))[1].stage).toBe('repo-op')
  })

  test('"yes" to a proposal is judged on the work it approves, never kept by its length', async ($, on) => {
    const h = harness(on, auto({ judge: hard, effortJudge: (p: string) => (/Next message:\nyes/.test(p) ? perModel({ opus: ['opus', 'high'], sonnet: ['opus', 'high'] })(p) : perModel({ opus: ['opus', 'low'], sonnet: ['sonnet', 'low'] })(p)) }))
    h.setPrefix(60_000)
    await h.submit($, 'look at how the importer orders records')
    await h.step($)
    await h.complete($, 'claude-opus-5-5', undefined, 'The order is lost in the batcher. My proposal: rewrite the batcher to keep a sequence number.')
    const before = h.effortJudged.length
    await h.submit($, 'yes')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(h.effortJudged.length).toBeGreaterThan(before)
    expect(h.steps[1].effort).toBe('high')
  })

  test('a redo keeps the model for the next prompts and adds no effort by itself', async ($, on) => {
    const h = harness(on, auto({ judge: hard, effortJudge: perModel({ opus: ['opus', 'medium'], sonnet: ['sonnet', 'medium'], haiku: ['sonnet', 'medium'] }) }))
    h.setPrefix(60_000)
    await h.submit($, 'fix the intermittent deadlock in the flush path')
    await h.step($)
    const first = h.steps[0]
    await h.complete($, first.model)
    await h.submit($, "that's wrong, it still deadlocks")
    await h.step($, first.model, undefined, { turnId: 't2' })
    expect(h.steps[1].model).toBe(first.model)
    expect(h.steps[1].effort).toBe('medium')
    const d = prompts(records(h.writes))[1]
    expect(d.redo).toBeUndefined()
    expect(d.auto.steps.join(' ')).not.toContain('redo floor')
  })

  test('the thinking guard leaves the effort as the app set it; the model route still applies', async ($, on) => {
    const h = harness(on, auto({ env: { MAX_THINKING_TOKENS: '0' }, judge: hard, effortJudge: opusXhigh }))
    await h.submit($, 'design the cache layer')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' })
    await h.complete($, 'claude-opus-5-5')
    const req = requests(records(h.writes))[0]
    expect(req.effortWhy).toContain('thinking mode')
  })

  test('a repeated defect on a large warm Sonnet high session asks the Opus architect instead of moving', async ($, on) => {
    const h = harness(on, auto({ judge: judge({ tier: 'T2', complexity: 'standard' }), effortJudge: perModel({ sonnet: ['sonnet', 'high'], opus: ['opus', 'high'] }) }))
    h.setPrefix(150_000)
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await $.tool.call({ tool: 'Edit', file_path: 'parser.go', old_string: 'a', new_string: 'b' })
    const second = await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    expect(JSON.stringify(second)).toContain('automode:architect')
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 3 })
    expect(h.steps[1].model).toBe('claude-sonnet-5-5')
    expect(records(h.writes).find((x) => x.kind === 'escalation').via).toBe('architect')
  })

  test('shadow: no rewrite, no context; the auto decision is recorded after the turn', async ($, on) => {
    const h = harness(on, auto({ mode: 'shadow', judge: hard, effortJudge: opusXhigh }))
    const out = await h.submit($, 'redesign the plugin install flow across setup and the marketplace')
    expect(out.context.length).toBe(0)
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium' })
    await h.complete($)
    const d = prompts(records(h.writes))[0]
    expect(d).toMatchObject({ mode: 'shadow', applied: false, policy: 'auto', effective: { model: 'claude-opus-5-5', effort: 'xhigh' } })
    expect(d.auto.candidates.length).toBe(3)
  })

  test('a failed AutoMode judge on the first prompt keeps the app model, raises the checks, never blocks', async ($, on) => {
    const h = harness(on, auto({ judge: null, effortJudge: perModel({ sonnet: ['sonnet', 'high'], haiku: ['haiku', 'low'], opus: ['opus', 'low'] }) }))
    const out = await h.submit($, 'add retries to the uploader')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
    expect(out.context.join('\n')).toContain('run the relevant tests')
    expect(prompts(records(h.writes))[0].auto.fallback).toContain('first prompt')
  })

  test('after a refused effort rewrite, later requests keep the app effort; the model route stays', async ($, on) => {
    const h = harness(on, auto({ sessionId: 'auto-refused', judge: hard, effortJudge: opusXhigh, env: { CLAUDE_CONFIG_DIR: '/cfg' } }))
    await h.submit($, 'design the cache layer')
    h.failModel('claude-opus-5-5')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 'r1' }) // the effort-only rewrite gets no response
    h.writes['/cfg/plugins/data/automode/signals/auto-refused.json'] = JSON.stringify({ seq: 1, errors: [{ at: 1_000_000, error: 'invalid_request', detail: 'messages.3.output_config: Extra inputs are not permitted' }], compactions: [] })
    h.failModel(null)
    await h.complete($, 'claude-opus-5-5', undefined, 'x', { turnId: 'r1' })
    await h.submit($, 'design the eviction policy')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 'r2', effort: 'medium' })
    expect(h.steps.at(-1)).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' })
  })
})


describe('Judge overhead and bounds', () => {
  test('tool continuations inside a turn never call a judge', async ($, on) => {
    const h = harness(on, auto({ judge: hard, effortJudge: perModel({ opus: ['opus', 'high'], sonnet: ['opus', 'high'] }) }))
    await h.submit($, 'design the cache layer')
    await h.step($)
    const calls = h.judged.length + h.effortJudged.length
    for (let i = 1; i <= 6; i++) await h.step($, 'claude-opus-5-5', undefined, { index: i })
    expect(h.judged.length + h.effortJudged.length).toBe(calls)
  })

  test('three failed effortless judgments pause that judge for 60 s (claude-router breaker); the fallback runs with no call', async ($, on) => {
    const h = harness(on, auto({ judge: hard, effortJudge: null }))
    for (let i = 0; i < 3; i++) {
      await h.submit($, `design part ${i} of the cache layer`)
      await h.step($, 'claude-sonnet-5-5', undefined, { turnId: `p${i}` })
      await h.complete($, 'claude-sonnet-5-5', undefined, 'done', { turnId: `p${i}` })
    }
    const before = h.effortJudged.length
    await h.submit($, 'design the last part of the cache layer')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 'p9' })
    expect(h.effortJudged.length).toBe(before) // paused: no call
    const r = records(h.writes)
    expect(r.some((x) => x.kind === 'judge-pause' && x.judge === 'effortless')).toBe(true)
    expect(prompts(r).at(-1).auto.fallback).toBeTruthy()
    expect(h.judged.length).toBe(4) // the AutoMode judge has its own breaker and still runs
  })
})

describe('Workflow transitions', () => {
  test('lookup, then implementation: Haiku for the lookup, Sonnet at its own verdict for the work', async ($, on) => {
    const h = harness(on, auto({
      firstPrefix: 30_000,
      judge: (p: string) => (p.includes('where is') ? judge({ tier: 'T0', complexity: 'trivial' }) : judge({ tier: 'T1', complexity: 'standard', newTask: true })),
      effortJudge: (p: string) => (/Next message:\nwhere is/.test(p) ? perModel({ sonnet: ['haiku', 'low'], haiku: ['haiku', 'low'] })(p) : perModel({ haiku: ['sonnet', 'medium'], sonnet: ['sonnet', 'medium'] })(p)),
    }))
    await h.submit($, 'where is the output folder written?')
    await h.step($)
    await h.complete($, 'claude-haiku-5-5')
    await h.submit($, 'now add a --dry-run flag to the setup command')
    await h.step($, 'claude-haiku-5-5', undefined, { turnId: 't2' })
    expect(h.steps.map((s) => `${s.model}/${s.effort}`)).toEqual(['claude-haiku-5-5/low', 'claude-sonnet-5-5/medium'])
    expect(prompts(records(h.writes))[1].effective.owner).toBe('quality-escalation') // real work on Haiku: the move is mandatory
  })

  test('implementation, a failing check twice, a passing fix: one step up, then the floor ends and the review stays', async ($, on) => {
    const failing = { result: 'Error: Exit code 1\n--- FAIL: TestPlanted (0.00s)\n    c_test.go:9: got 1 want 2\nFAIL', isError: true, text: '' }
    const passing = { result: 'ok  \texample/config\t0.2s', isError: false, text: '' }
    let fixed = false
    const h = harness(on, auto({ judge: judge({ tier: 'T1' }), effortJudge: perModel({ sonnet: ['sonnet', 'medium'] }), bash: () => (fixed ? passing : failing) }))
    await h.submit($, 'make TestPlanted pass')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/' })
    await $.tool.call({ tool: 'Edit', file_path: 'c.go', old_string: 'a', new_string: 'b' })
    const second = await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/' })
    expect(JSON.stringify(second)).toContain('escalated')
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 3 })
    expect(h.steps[1]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' }) // one step: Sonnet medium to high
    fixed = true
    await $.tool.call({ tool: 'Edit', file_path: 'c.go', old_string: 'b', new_string: 'c' })
    await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/' })
    await h.complete($)
    await h.submit($, 'continue')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    const last = decisions(records(h.writes)).at(-1)
    expect(last.risk.reviewRequired).toBe(true) // the review the escalation required stays after the fix
    expect(['medium', 'high']).toContain(h.steps.at(-1)?.effort) // the escalation floor ended with the passing check
  })

  test('a subagent may not commit or push; the main session is told to commit only when asked', async ($, on) => {
    const h = harness(on, auto({ judge: hard, effortJudge: perModel({ opus: ['opus', 'high'], sonnet: ['opus', 'high'] }) }))
    await h.submit($, 'design the cache layer')
    const res: any = await $.agent.spawn({ subagentType: 'automode:implementer', prompt: 'implement', description: 'x', parentModel: 'claude-opus-5-5', fork: false, background: false, tool_use_id: 'z', provider: { plugin: 'engine', tier: 'core' } })
    const denied: any = await $.tool.call({ tool: 'Bash', command: 'git push origin main', agentId: res.agentId })
    expect(String(denied.deny ?? '')).toContain('git writes')
  })
})

describe('Economics', () => {
  test('a cold cache with a cheaper eligible model switches; a warm large cache holds; both are priced in the record', async ($, on) => {
    let n = 0
    const verdicts = (p: string) => (/Next message:\nfix the/.test(p) ? perModel({ opus: ['opus', 'high'], sonnet: ['opus', 'high'] })(p) : perModel({ opus: ['sonnet', 'medium'], sonnet: ['sonnet', 'medium'] })(p))
    const h = harness(on, auto({ judge: () => judge(n++ === 0 ? { tier: 'T3', complexity: 'complex' } : { tier: 'T1', newTask: true }), effortJudge: verdicts }))
    h.setPrefix(120_000)
    await h.submit($, 'fix the intermittent deadlock in the flush path')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'add a --verbose flag to the usage script')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(h.steps[1].model).toBe('claude-opus-5-5') // warm 120k Opus cache: the rewrite does not pay back
    expect(prompts(records(h.writes))[1].effective.check.economics).toBeTruthy()
    await h.complete($, 'claude-opus-5-5', undefined, 'done', { turnId: 't2' })
    await h.clock.advance(2 * 3_600_000) // the cache is cold
    await h.submit($, 'add a --quiet flag to the usage script')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't3' })
    expect(h.steps[2].model).toBe('claude-sonnet-5-5') // cold: the cheaper eligible model costs no rewrite
  })

  test('measured and estimated values are labeled apart in the records', async ($, on) => {
    const h = harness(on, auto({ judge: judge({ tier: 'T1' }), effortJudge: perModel({ sonnet: ['sonnet', 'medium'] }) }))
    await h.submit($, 'add a --verbose flag to the usage script')
    await h.step($)
    await h.complete($)
    const r = records(h.writes)
    expect(prompts(r)[0].costTotal.basis).toBe('estimate')
    expect(requests(r)[0].usd.basis).toBe('measured')
    expect(r.filter((x) => x.kind === 'model-call').every((x) => x.usd.basis === 'measured')).toBe(true)
  })
})

describe('Continuity and the shadow rent rule', () => {
  const coldSwitch = (over: Record<string, unknown> = {}) => {
    let n = 0
    return auto({ judge: () => judge(n++ === 0 ? { tier: 'T3', complexity: 'complex' } : { tier: 'T1', newTask: true }), effortJudge: (p: string) => (/Next message:\nfix the/.test(p) ? perModel({ opus: ['opus', 'high'], sonnet: ['opus', 'high'] })(p) : perModel({ opus: ['sonnet', 'medium'], sonnet: ['sonnet', 'medium'] })(p)), ...over })
  }

  test('a new task on a cold cache switches, logs the lost flag, and records the tokens the prompt dropped', async ($, on) => {
    const h = harness(on, coldSwitch())
    h.setPrefix(60_000)
    await h.submit($, 'fix the intermittent deadlock in the flush path')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.clock.advance(2 * 3_600_000)
    await h.submit($, 'add a --quiet flag to the usage script')
    h.setPrefix(50_000)
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    await h.complete($, 'claude-sonnet-5-5', undefined, 'done', { turnId: 't2' })
    const r = records(h.writes)
    expect(prompts(r)[1].effective.check.continuity).toBe('lost')
    expect(r.find((x) => x.kind === 'model-switch')).toMatchObject({ from: 'claude-opus-5-5', to: 'claude-sonnet-5-5', continuity: 'lost', prefixBefore: 60_000, prefixAfter: 50_000, droppedTokens: 10_300 })
  })

  test('a shrink between the two requests leaves the drop unknown', async ($, on) => {
    const h = harness(on, coldSwitch())
    h.setPrefix(60_000)
    await h.submit($, 'fix the intermittent deadlock in the flush path')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.clock.advance(2 * 3_600_000)
    await h.submit($, 'add a --quiet flag to the usage script')
    h.setPrefix(20_000)
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    await h.complete($, 'claude-sonnet-5-5', undefined, 'done', { turnId: 't2' })
    expect(records(h.writes).find((x) => x.kind === 'model-switch').droppedTokens).toBe(null)
  })

  test('a shrink with no noted compaction is no reset: it is not a low point', async ($, on) => {
    const h = harness(on, auto({ judge: hard, effortJudge: perModel({ opus: ['opus', 'high'], sonnet: ['opus', 'high'] }) }))
    h.setPrefix(60_000)
    await h.submit($, 'fix the intermittent deadlock in the flush path')
    await h.step($)
    h.setPrefix(20_000)
    await h.step($, 'claude-opus-5-5', undefined, { index: 1 })
    await h.complete($, 'claude-opus-5-5')
    const d = decisions(records(h.writes)).find((x) => x.trigger?.event === 'compacted')
    expect(d.effective.check.lowPenaltyPoint).toBe(false)
  })

  test('held rent grows on real spend, survives a reload, and changes no route', async ($, on) => {
    const h = harness(on, coldSwitch({ sessionId: 'sess-rent' }))
    h.setPrefix(120_000)
    await h.submit($, 'fix the intermittent deadlock in the flush path')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'add a --verbose flag to the usage script')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    await h.complete($, 'claude-opus-5-5', undefined, 'done', { turnId: 't2' })
    expect(prompts(records(h.writes))[1].effective.check).toMatchObject({ verdict: 'hold', rent: { to: 'sonnet', rentUsd: 0 } })
    h.setSession('sess-rent')
    await h.submit($, 'add a --quiet flag to the usage script')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't3' })
    await h.complete($, 'claude-opus-5-5', undefined, 'done', { turnId: 't3' })
    const third = prompts(records(h.writes))[2].effective
    expect(third.check.rent.rentUsd).toBeGreaterThan(0)
    expect(third.check.verdict).toBe('hold')
    expect(third.model).toBe('claude-opus-5-5')
  })
})

describe('A7: a stale effort is never the judge\'s Current', () => {
  test('after the cache expired, the running model is named at its default effort, not the old xhigh', async ($, on) => {
    const h = harness(on, auto({ judge: hard, effortJudge: perModel({ opus: ['opus', 'xhigh'], sonnet: ['opus', 'xhigh'] }) }))
    h.setPrefix(120_000)
    await h.submit($, 'fix the intermittent deadlock in the flush path')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'and the timer in the same flush path?')
    expect(h.effortJudged.at(-1)).toContain('Current: opus / xhigh') // warm: the running pair
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    await h.complete($, 'claude-opus-5-5', undefined, 'done', { turnId: 't2' })
    await h.clock.advance(2 * 3_600_000)
    await h.submit($, "Didn't you open a new pull request?")
    expect(h.effortJudged.at(-1)).toContain('Current: opus / medium') // cold: Anthropic's default for Opus 5.5
  })
})

describe('A failed effortless judge on a hard first prompt', () => {
  test('the AutoMode judge names Opus: the route moves up at its effort, never stays on Sonnet medium', async ($, on) => {
    const h = harness(on, auto({ judge: judge({ tier: 'T3', complexity: 'complex', effort: 'high' }), effortJudge: null }))
    await h.submit($, 'We need to fix it, we already tried multiple times and the deploy keeps failing')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    expect(prompts(records(h.writes))[0].auto.fallback).toContain('the AutoMode judge decides')
  })
})

describe('The person keeps the last word on model and effort', () => {
  const easy = judge({ tier: 'T1', complexity: 'standard' })
  const sonnetMedium = perModel({ sonnet: ['sonnet', 'medium'], opus: ['sonnet', 'medium'], haiku: ['sonnet', 'medium'] })

  test('routeModels false keeps an Opus pick from the first prompt on', async ($, on) => {
    const h = harness(on, auto({ model: 'claude-opus-5-5', config: { activation: 'always', routeModels: false }, judge: easy, effortJudge: perModel({ opus: ['sonnet', 'medium'], sonnet: ['sonnet', 'medium'] }) }))
    await h.submit($, 'add a flag to the importer')
    await h.step($, 'claude-opus-5-5')
    expect(h.steps[0].model).toBe('claude-opus-5-5')
  })

  test('/effort stands past the next prompt, and am:reset hands it back', async ($, on) => {
    const h = harness(on, auto({ judge: easy, effortJudge: sonnetMedium }))
    await h.submit($, 'add a flag to the importer')
    await h.step($)
    await h.complete($)
    await h.submit($, 'add a second flag')
    await h.step($, 'claude-sonnet-5-5', undefined, { effort: 'max' })
    expect(h.steps[1].effort).toBe('max')
    await h.complete($)
    await h.submit($, 'add a third flag')
    await h.step($, 'claude-sonnet-5-5', undefined, { effort: 'max' })
    expect(h.steps[2].effort).toBe('max')
    await h.complete($)
    await h.submit($, 'am:reset add a fourth flag')
    await h.step($, 'claude-sonnet-5-5', undefined, { effort: 'max' })
    expect(h.steps[3].effort).toBe('medium')
  })

  test('/model stands against a verdict for a cheaper model', async ($, on) => {
    const h = harness(on, auto({ judge: easy, effortJudge: sonnetMedium }))
    await h.submit($, 'add a flag to the importer')
    await h.step($)
    await h.complete($)
    await h.submit($, 'add a second flag')
    await h.step($, 'claude-opus-5-5')
    expect(h.steps[1].model).toBe('claude-opus-5-5')
    await h.complete($)
    await h.submit($, 'add a third flag')
    await h.step($, 'claude-opus-5-5')
    expect(h.steps[2].model).toBe('claude-opus-5-5')
  })

  test('a route the mod chose itself pins nothing', async ($, on) => {
    let n = 0
    const h = harness(on, auto({ judge: () => judge(n++ === 0 ? { tier: 'T3', complexity: 'complex' } : { tier: 'T1', complexity: 'standard', newTask: true }), effortJudge: (p: string) => (n > 1 ? sonnetMedium(p) : perModel({ opus: ['opus', 'high'], sonnet: ['opus', 'high'] })(p)) }))
    await h.submit($, 'design the cache layer')
    await h.step($)
    expect(h.steps[0].model).toBe('claude-opus-5-5')
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'rename the flag')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2', effort: 'high' })
    expect(requests(records(h.writes)).length).toBeGreaterThan(0)
    expect(prompts(records(h.writes)).every((d) => d.owner !== 'user-override')).toBe(true)
  })
})

describe('A8: the closing line is the retry', () => {
  test('a reply with no verdict is asked once more with the closing line, and that verdict counts', async ($, on) => {
    const seen: string[] = []
    const effortJudge = (p: string) => { seen.push(p); return p.includes('Reply with the JSON verdict only') ? JSON.stringify({ model: 'sonnet', effort: 'high', sure: 0.9, why: 'x' }) : 'Here is your Slack reply.' }
    const h = harness(on, auto({ judge: judge({ tier: 'T1', complexity: 'standard' }), effortJudge }))
    await h.submit($, 'draft the Slack reply')
    await h.step($)
    expect(seen.length).toBe(2)
    expect(seen[0].includes('Reply with the JSON verdict only')).toBe(false)
    expect(h.steps[0]).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high' })
  })
})

describe('Task risk follows the evidence', () => {
  test('a failed judge raises the task only until a judge answers', async ($, on) => {
    let up = true
    const ok = judge({ tier: 'T1', complexity: 'standard', newTask: false })
    const h = harness(on, auto({ judge: () => (up ? ok : null as any), effortJudge: perModel({ sonnet: ['sonnet', 'medium'] }) }))
    const risks = () => prompts(records(h.writes)).map((d) => d.risk?.effective ?? d.envelope?.risk?.effective)
    await h.submit($, 'add a flag to the importer')
    await h.step($)
    await h.complete($)
    up = false
    await h.submit($, 'also add a default for it')
    await h.step($)
    await h.complete($)
    up = true
    await h.submit($, 'and print the flag in the help text')
    await h.step($)
    const all = risks()
    expect(all[1]).toBe('elevated')
    expect(all[2]).toBe('none')
  })

  test('a two-word destructive message skips neither the judge nor the risk layers', async ($, on) => {
    const h = harness(on, auto({ judge: judge({ tier: 'T1', complexity: 'standard' }), effortJudge: perModel({ sonnet: ['sonnet', 'medium'] }) }))
    await h.submit($, 'clean up the old accounts job')
    await h.step($)
    await h.complete($)
    const before = h.judged.length
    await h.submit($, 'drop users')
    await h.step($)
    expect(h.judged.length).toBeGreaterThan(before)
  })

  test('moving on is not a correction', async ($, on) => {
    const h = harness(on, auto({ judge: judge({ tier: 'T1', complexity: 'standard' }), effortJudge: perModel({ sonnet: ['sonnet', 'medium'] }) }))
    await h.submit($, 'add a flag to the importer')
    await h.step($)
    await h.complete($)
    await h.submit($, 'thanks, now add the docs for it')
    await h.complete($)
    const signals = records(h.writes).filter((x) => x.kind === 'signal')
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.some((x) => x.next === 'moved-on' && x.underRouting)).toBe(false)
  })
})
