// The Sonnet executor end to end in the mocked engine: the route, what can still move it, and the shadow route.
import { describe, expect, test } from 'claude-code/testing'
import { harness, judge, perModel, records } from './harness.ts'

const prompts = (r: any[]) => r.filter((x) => x.kind === 'decision' && x.point === 'prompt')
const opusNeed = perModel({ sonnet: ['opus', 'high'], opus: ['opus', 'high'], haiku: ['opus', 'high'] })
const hard = judge({ tier: 'T3', complexity: 'complex' })
const executor = (o: Record<string, unknown> = {}) => ({ policy: 'auto', config: { executor: 'sonnet', activation: 'always' }, ...o })

describe('Sonnet executor', () => {
  test('a hard task the judges send to Opus runs on Sonnet, and the pick is logged', async ($, on) => {
    const h = harness(on, executor({ judge: hard, effortJudge: opusNeed }))
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: expect.stringContaining('sonnet'), effort: 'high' })
    const d = prompts(records(h.writes))[0]
    expect(d.shadowRoute).toBe('opus/high')
    expect(h.effortJudged.length).toBe(1)
  })

  test('judge stays the default, so the same task still runs on Opus', async ($, on) => {
    const h = harness(on, { policy: 'auto', judge: hard, effortJudge: opusNeed })
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    expect(h.steps[0].model).toContain('opus')
    expect(prompts(records(h.writes))[0].shadowRoute).toBeUndefined()
  })

  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
    test(`the route does not depend on the start model: ${model} (#47)`, async ($, on) => {
      const h = harness(on, executor({ model, judge: hard, effortJudge: opusNeed }))
      await h.submit($, 'design the cache layer for the decision records')
      await h.step($)
      expect(h.steps[0]).toMatchObject({ model: expect.stringContaining('sonnet'), effort: 'high' })
    })
  }

  test('a low verdict runs at medium', async ($, on) => {
    const h = harness(on, executor({ effortJudge: perModel({ sonnet: ['sonnet', 'low'] }) }))
    await h.submit($, 'add a --verbose flag to the usage script')
    await h.step($)
    expect(h.steps[0].effort).toBe('medium')
  })

  test('a pin wins', async ($, on) => {
    const h = harness(on, executor({ judge: hard }))
    await h.submit($, 'am:opus design the cache layer')
    await h.step($)
    expect(h.steps[0].model).toContain('opus')
  })

  test('a critical floor raises the effort and keeps the model', async ($, on) => {
    const h = harness(on, executor({ judge: judge({ tier: 'T3', complexity: 'complex', risk: 'critical', riskWhy: 'payment path' }), effortJudge: perModel({ sonnet: ['sonnet', 'medium'] }) }))
    await h.submit($, 'change how the payment webhook retries')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: expect.stringContaining('sonnet'), effort: 'high' })
  })

  test('a follow-up on a warm task keeps its effort', async ($, on) => {
    let effort = 'high'
    const h = harness(on, executor({ judge: judge({ newTask: false }), effortJudge: () => JSON.stringify({ model: 'sonnet', effort, sure: 0.9, why: 'x' }) }))
    await h.submit($, 'rework the parser error handling across the module')
    await h.step($)
    effort = 'low'
    await h.submit($, 'now also cover the tokenizer errors with the same approach')
    await h.step($)
    expect(h.steps[0].effort).toBe('high')
    expect(h.steps[1].effort).toBe('high')
  })

  test('a new task starts from medium again', async ($, on) => {
    let effort = 'high'
    const h = harness(on, executor({ judge: judge({ newTask: true }), effortJudge: () => JSON.stringify({ model: 'sonnet', effort, sure: 0.9, why: 'x' }) }))
    await h.submit($, 'rework the parser error handling across the module')
    await h.step($)
    effort = 'medium'
    await h.submit($, 'a different job: fix the footer link in the docs site')
    await h.step($)
    expect(h.steps[1].effort).toBe('medium')
  })

  test('repeated failures still climb: effort first, then the Opus consult', async ($, on) => {
    const h = harness(on, executor({ judge: judge({ newTask: false }) }))
    await h.submit($, 'fix the failing parser test')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await $.tool.call({ tool: 'Edit', file_path: 'parser.go', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await h.step($)
    expect(h.steps[1]).toMatchObject({ model: expect.stringContaining('sonnet'), effort: 'high' })
    await $.tool.call({ tool: 'Edit', file_path: 'parser.go', old_string: 'b', new_string: 'c' })
    const third = await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    expect(JSON.stringify(third) + JSON.stringify(records(h.writes).filter((x) => x.kind === 'escalation'))).toMatch(/consult|opus/i)
  })

  test('a warm Opus holds inside a task, and a follow-up keeps it', async ($, on) => {
    const h = harness(on, executor({ judge: judge({ newTask: false }) }))
    h.setPrefix(200_000)
    await h.submit($, 'am:opus design the cache layer for the decision records')
    await h.step($, 'claude-opus-5-5')
    await h.submit($, 'now also cover the eviction rules in that design')
    await h.step($, 'claude-opus-5-5')
    expect(h.steps[0].model).toContain('opus')
    expect(h.steps[1].model).toContain('opus')
  })

  test('an event between prompts does not revive the stored Opus pick', async ($, on) => {
    const h = harness(on, executor({ judge: hard, effortJudge: opusNeed, bash: () => ({ result: 'ok', isError: false, text: '' }) }))
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    await $.tool.call({ tool: 'Edit', file_path: 'cache.go', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'go test ./...' })
    await h.step($)
    expect(h.steps[1].model).toContain('sonnet')
    const triggers = records(h.writes).filter((x) => x.kind === 'decision' && x.point === 'trigger')
    expect(triggers.length).toBeGreaterThan(0)
    expect(triggers.flatMap((x) => x.auto.candidates.map((c: any) => c.route.split('/')[0]))).toEqual(triggers.map(() => 'sonnet'))
  })

  test('a failed judge keeps the running model and moves nothing', async ($, on) => {
    const h = harness(on, executor({ model: 'claude-opus-5-5', judge: null, effortJudge: null }))
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    expect(h.steps[0].model).toContain('opus')
  })

  test('routeModels false wins over the executor', async ($, on) => {
    const h = harness(on, { policy: 'auto', model: 'claude-opus-5-5', config: { executor: 'sonnet', activation: 'always', routeModels: false }, judge: hard })
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    expect(h.steps[0].model).toContain('opus')
  })
})
