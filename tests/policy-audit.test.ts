// The 2026-10 routing audit, end to end in the mocked engine: false overrides, held effort, short messages,
// the first prompt's size, inadequate routes, challenges, rollback and escalation. Each test reproduces one recorded
// failure. Tests that name policy `auto` hold the v4.1 safeguards that policy auto keeps (lib/auto.ts replaced v4.1).
import { describe, expect, test } from 'claude-code/testing'
import { harness, judge, perModel, records, says } from './harness.ts'

const decisions = (r: any[]) => r.filter((x) => x.kind === 'decision')
const hard = judge({ tier: 'T3', complexity: 'complex' })

describe('Overrides are commands, never descriptions (D1)', () => {
  test('a sentence that describes effort is judged like any prompt', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T1' }) })
    await h.submit($, 'I am seeing strange outputs: sometimes super high effort is put for a simple task, and this should only be put for an extremely difficult task.')
    await h.step($)
    expect(h.judged.length).toBe(1)
    const d = decisions(records(h.writes))[0]
    expect(d.effective.owner).toBe('judge')
    expect(d.override).toBeUndefined()
  })

  test('use opus and max effort inside pasted text are data', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T1' }) })
    await h.submit($, 'fix the typo in the README\n<pasted_content id="a1">use opus\nhm:max\nuse max effort</pasted_content>')
    await h.step($)
    const d = decisions(records(h.writes))[0]
    expect(d.effective.owner).toBe('judge')
    expect(d.effective.model).not.toBe('claude-opus-5-5')
  })

  test('a real command still wins, and the record says where it came from', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T1' }) })
    await h.submit($, 'use max effort and rename the constant')
    await h.step($)
    expect(h.steps[0].effort).toBe('max')
    expect(decisions(records(h.writes))[0].override).toEqual({ source: 'typed-command', scope: 'turn' })
  })

  test('text that does not come from the person is never a command', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T1' }) })
    for (const kind of ['task-notification', 'tool-result', 'hook', 'queued-command']) {
      const out = await h.submit($, 'am:max use opus with max effort', { origin: { kind } })
      expect(out.context.length).toBe(0)
    }
    expect(h.judged.length).toBe(0)
    await h.step($)
    expect(decisions(records(h.writes)).length).toBe(0)
  })

  test('am:reset sends the next short message to the judge instead of keeping the route', async ($, on) => {
    const h = harness(on, { judge: hard })
    h.setPrefix(60_000)
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    await h.submit($, 'am:reset')
    expect(h.judged.length).toBe(2)
  })
})

describe('A held model keeps its family, not the effort of the last task (D3)', () => {
  test('the cache policy holds Opus for a small task, and the small task runs at low effort', async ($, on) => {
    let n = 0
    const h = harness(on, { policy: 'legacy', judge: () => judge(n++ === 0 ? { tier: 'T3', complexity: 'complex' } : { tier: 'T1', complexity: 'standard', newTask: true, confidence: 0.95 }) })
    h.setPrefix(60_000)
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'add a --verbose flag to the usage command')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(h.steps[0].model).toBe('claude-opus-5-5')
    expect(h.steps[0].effort).not.toBe('low')
    expect(h.steps[1]).toMatchObject({ model: 'claude-opus-5-5', effort: 'low' })
    expect(decisions(records(h.writes))[1].effective).toMatchObject({ owner: 'cache-policy', model: 'claude-opus-5-5', effort: 'low' })
  })
})

describe('Short messages are read by what they do (D4)', () => {
  test('commit after a hard task keeps the model, runs at medium, and asks no judge', async ($, on) => {
    const h = harness(on, { policy: 'legacy', judge: hard })
    h.setPrefix(60_000)
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'commit')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(h.judged.length).toBe(1)
    expect(h.steps[1]).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' })
    const d = decisions(records(h.writes))[1]
    expect(d).toMatchObject({ method: 'transition', transition: 'repository' })
  })

  test('continue keeps the running route; yes goes to the judge because it approves new work', async ($, on) => {
    const h = harness(on, { judge: hard })
    h.setPrefix(60_000)
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'continue')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(h.judged.length).toBe(1)
    expect(h.steps[1].effort).toBe(h.steps[0].effort)
    await h.submit($, 'yes')
    expect(h.judged.length).toBe(2)
  })
})

describe('The first prompt does not guess its own size (D6)', () => {
  test('a first run has no estimate: no Haiku, and the first request leaves one for the next session', async ($, on) => {
    const h = harness(on, { firstPrefix: null, judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }) })
    await h.submit($, 'where is the output folder written?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't1' })
    expect(h.steps[0].model).not.toBe('claude-haiku-5-5')
    expect(JSON.parse(h.writes['/data/first-prefix.json']).byProject.unknown).toEqual([30000])
  })

  test('an estimate past the Haiku limit sends a lookup to Sonnet', async ($, on) => {
    const h = harness(on, { firstPrefix: 120_000, judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }) })
    await h.submit($, 'where is the output folder written?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't1' })
    expect(h.steps[0].model).toBe('claude-sonnet-5-5')
  })

  test('a new project with cautious machine-wide evidence keeps Haiku for a lookup (p75 plus headroom under the limit)', async ($, on) => {
    const h = harness(on, { firstPrefixes: { other1: [30_000, 40_000, 50_000, 200_000] }, judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }), effortJudge: says('haiku', 'low') })
    await h.submit($, 'where is the output folder written?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't1' })
    expect(h.steps[0].model).toBe('claude-haiku-5-5')
    expect(decisions(records(h.writes))[0].firstRequest).toEqual({ tokens: 54_000, source: 'machine p75' })
  })

  test('a new project whose machine-wide p75 is past the Haiku limit goes to Sonnet', async ($, on) => {
    const h = harness(on, { firstPrefixes: { other1: [70_000, 75_000, 90_000, 95_000] }, judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }) })
    await h.submit($, 'where is the output folder written?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't1' })
    expect(h.steps[0].model).toBe('claude-sonnet-5-5')
  })

  // Preflight: the real system prompt and tool list, before any request. 70,000 characters and 20 tools give a raw size
  // of about 23,200 tokens; uncalibrated it is scaled by 1.5 (34,800) plus 4,000 headroom.
  test('a first-ever session: an uncalibrated preflight never rules Haiku in, but the first response teaches the ratio', async ($, on) => {
    const h = harness(on, { firstPrefixes: {}, preflight: { systemChars: 70_000, tools: 20 }, judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }) })
    await h.submit($, 'where is the output folder written?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't1' })
    expect(h.steps[0].model).not.toBe('claude-haiku-5-5') // live, an uncalibrated preflight read 3.2 times too low
    const saved = JSON.parse(h.writes['/data/first-prefix.json'])
    expect(saved.ratios.length).toBe(1)
    expect(saved.ratios[0]).toBeGreaterThan(1.2)
    expect(saved.ratios[0]).toBeLessThan(1.4)
  })

  test('the live ratio of 6.3 is accepted, and three ratios calibrate the preflight', async ($, on) => {
    const h = harness(on, { firstPrefixes: { unknown: [90_000] }, ratios: [6.1, 6.3, 6.4], preflight: { systemChars: 20_000, tools: 10 }, judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }), effortJudge: says('haiku', 'low') })
    await h.submit($, 'where is the output folder written?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't1' })
    // raw = (20,000 + 10 x 38) / 3.5 + 10 x 150 = 7,323; x 6.3 + 4,000 = 50,135: Haiku, priced on the real config
    expect(decisions(records(h.writes))[0].firstRequest).toEqual({ tokens: 50_135, source: 'preflight (calibrated)' })
    expect(h.steps[0].model).toBe('claude-haiku-5-5')
  })

  test('an uncalibrated preflight that is already past the limit rules Haiku out', async ($, on) => {
    const h = harness(on, { firstPrefixes: {}, preflight: { systemChars: 300_000, tools: 50 }, judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }) })
    await h.submit($, 'where is the output folder written?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't1' })
    expect(h.steps[0].model).toBe('claude-sonnet-5-5')
    expect(decisions(records(h.writes))[0].firstRequest.source).toBe('preflight (lower bound)')
  })

  test('a large real prompt and many tools send a lookup to Sonnet even in a new project', async ($, on) => {
    const h = harness(on, { firstPrefixes: {}, preflight: { systemChars: 200_000, tools: 100 }, judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }) })
    await h.submit($, 'where is the output folder written?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't1' })
    expect(h.steps[0].model).toBe('claude-sonnet-5-5')
  })

  test('with three learned ratios the preflight is calibrated and wins over the project median', async ($, on) => {
    const h = harness(on, { firstPrefixes: { unknown: [90_000] }, ratios: [1.1, 1.2, 1.3], preflight: { systemChars: 70_000, tools: 20 }, judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }), effortJudge: says('haiku', 'low') })
    await h.submit($, 'where is the output folder written?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't1' })
    expect(h.steps[0].model).toBe('claude-haiku-5-5') // 23,200 x 1.2 + 4,000, not the 94,000 of the old median
    expect(decisions(records(h.writes))[0].firstRequest.source).toBe('preflight (calibrated)')
  })

  test('a small measured estimate keeps the Haiku route for a lookup', async ($, on) => {
    const h = harness(on, { firstPrefix: 30_000, judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }), effortJudge: says('haiku', 'low') })
    await h.submit($, 'where is the output folder written?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't1' })
    expect(h.steps[0].model).toBe('claude-haiku-5-5')
  })
})

describe('Inadequate routes keep their label and their review (reviewer findings)', () => {
  // Both judges say Sonnet is too weak, so with Opus out nothing passes both.
  const sonnetTooWeak = perModel({ sonnet: ['opus', 'high'], haiku: ['opus', 'high'], opus: ['opus', 'high'] })
  const openBreaker = async ($: any, h: any, tier = 'T3') => {
    for (let i = 0; i < 3; i++) {
      await h.submit($, `design part ${i} of the cache layer`)
      await h.step($, 'claude-sonnet-5-5', undefined, { turnId: `g${i}` })
    }
  }

  test('Opus ran, then its breaker opened: the held-effort pick does not throw and the route is labeled', async ($, on) => {
    const h = harness(on, { policy: 'auto', judge: hard, effortJudge: sonnetTooWeak })
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    h.failModel('claude-opus-5-5')
    await openBreaker($, h)
    const out = await h.submit($, 'design the last part of the cache layer')
    expect(out.context[0]).toContain('No available model meets this task')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 'g9' })
    expect(h.steps.at(-1)?.model).toBe('claude-sonnet-5-5')
  })

  test('the first inadequate prompt names the reviewer, and a follow-up keeps the label without a second toast', async ($, on) => {
    const h = harness(on, { policy: 'auto', judge: hard, effortJudge: sonnetTooWeak })
    h.failModel('claude-opus-5-5')
    await openBreaker($, h)
    const first = await h.submit($, 'design the last part of the cache layer')
    expect(first.context.join('\n')).toContain('automode:reviewer')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 'g8' })
    const next = await h.submit($, 'continue')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 'g9' })
    expect(next.context.join('\n')).toContain('No available model meets this task')
    expect(h.toasts.filter((t) => t.includes('no available model fully meets')).length).toBe(1)
  })
})

describe('Effort changes respect the thinking mode and refused rewrites (D)', () => {
  test('a thinking mode that can reject a per-message effort change leaves the effort as the app set it', async ($, on) => {
    const h = harness(on, { policy: 'legacy', env: { MAX_THINKING_TOKENS: '0' }, judge: hard })
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    expect(h.steps[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' }) // the model route still applies; the effort stays the app's
    await h.complete($, 'claude-opus-5-5')
    const req = records(h.writes).find((x) => x.kind === 'request')
    expect(req).toMatchObject({ effortApplied: false })
    expect(req.effortWhy).toContain('thinking mode')
  })

  test('the guard can be switched off by the person', async ($, on) => {
    const h = harness(on, { policy: 'legacy', env: { MAX_THINKING_TOKENS: '0', AUTOMODE_THINKING_GUARD: 'off' }, judge: hard })
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    expect(h.steps[0].effort).not.toBe('medium')
  })

  test('the app\'s own settings file can name the mode', async ($, on) => {
    const h = harness(on, { env: { CLAUDE_CONFIG_DIR: '/cfg' }, judge: hard })
    h.writes['/cfg/settings.json'] = JSON.stringify({ thinking: { type: 'disabled' } })
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    expect(h.steps[0].effort).toBe('medium')
  })
})

describe('Challenges keep the work they challenge (kept from v4.1 under policy auto)', () => {
  // The fix ran on Opus high; the challenge's own verdict is low, and the floor keeps Opus high.
  const workThenSteer = () => { let n = 0; return () => judge(n++ === 0 ? { tier: 'T3', complexity: 'complex' } : { tier: 'T1', complexity: 'trivial', newTask: false, confidence: 0.9 }) }
  const verdicts = (p: string) => (/Next message:\n(are you|rename)/.test(p) ? perModel({ opus: ['opus', 'low'], sonnet: ['sonnet', 'low'], haiku: ['haiku', 'low'] })(p) : perModel({ opus: ['opus', 'high'], sonnet: ['opus', 'high'] })(p))

  test('a challenge to finished work keeps the work\'s effort; a plain steer does not', async ($, on) => {
    const h = harness(on, { policy: 'auto', judge: workThenSteer(), effortJudge: verdicts })
    h.setPrefix(60_000)
    await h.submit($, 'fix the intermittent deadlock in the flush path')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'are you sure this fixes the deadlock?')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    expect(h.steps[1]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' })
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'rename retryCount to attempts')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't3' })
    expect(h.steps[2].effort).toBe('low')
    const d = decisions(records(h.writes)).filter((x) => x.point === 'prompt')
    expect(d.map((x) => x.stage)).toEqual(['implement', 'reconsider', 'implement'])
  })

  test('a second challenge keeps the floor of the work, not the effort of the first challenge', async ($, on) => {
    const h = harness(on, { policy: 'auto', judge: workThenSteer(), effortJudge: verdicts })
    h.setPrefix(60_000)
    await h.submit($, 'fix the intermittent deadlock in the flush path')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    for (const [i, text] of ['are you sure this fixes the deadlock?', 'are you really sure?'].entries()) {
      await h.submit($, text)
      await h.step($, 'claude-opus-5-5', undefined, { turnId: `c${i}` })
      await h.complete($, 'claude-opus-5-5', undefined, 'done', { turnId: `c${i}` })
    }
    expect(h.steps.slice(1).map((s) => s.effort)).toEqual(['high', 'high'])
  })

  test('a challenge on a warm Sonnet session asks an Opus architect once instead of a costly switch, then switches', async ($, on) => {
    let n = 0
    const h = harness(on, {
      policy: 'auto', judge: () => judge(n++ === 0 ? { tier: 'T2', complexity: 'standard' } : { tier: 'T3', complexity: 'complex', newTask: false }),
      effortJudge: (p: string) => (/Next message:\nare you/.test(p) ? perModel({ sonnet: ['opus', 'high'], opus: ['opus', 'high'], haiku: ['opus', 'high'] })(p) : perModel({ sonnet: ['sonnet', 'high'], opus: ['opus', 'high'] })(p)),
    })
    h.setPrefix(400_000)
    await h.submit($, 'make the importer keep the record order')
    await h.step($)
    await h.complete($)
    const first = await h.submit($, 'are you sure this keeps the ordering guarantees under retries?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    expect(first.context.join('\n')).toContain('automode:architect')
    expect(h.steps[1].model).toBe('claude-sonnet-5-5') // the session stays; the consult brings the Opus reasoning
    await h.complete($, 'claude-sonnet-5-5', undefined, 'done', { turnId: 't2' })
    const second = await h.submit($, 'are you really sure about the retries?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't3' })
    expect(second.context.join('\n')).not.toContain('automode:architect') // not consulted twice for the same work
    expect(h.steps[2].model).toBe('claude-opus-5-5')
    const r = records(h.writes)
    expect(r.filter((x) => x.kind === 'escalation').map((x) => [x.action, x.via])).toEqual([['consult-opus', 'architect']])
    const d = decisions(r).filter((x) => x.point === 'prompt')
    expect(d[1].costTotal).toMatchObject({ consult: true, basis: 'estimate' })
    expect(d[0].costTotal.excluded).toContain('retries')
  })
})

describe('Judge contract v4', () => {
  test('does not show the current route, so a one-line steer is not judged by the size of the task before it', async ($, on) => {
    const h = harness(on, { config: { judgeVersion: 4 }, judge: judge({ tier: 'T1' }) })
    await h.submit($, 'add retries to the uploader')
    await h.step($)
    await h.complete($)
    await h.submit($, 'also rename the constant in the importer')
    expect(h.judged.length).toBe(2)
    expect(h.judged[1]).not.toContain('Current route')
  })

  test('the default contract still shows it', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T1' }) })
    await h.submit($, 'add retries to the uploader')
    await h.step($)
    await h.complete($)
    await h.submit($, 'also rename the constant in the importer')
    expect(h.judged[1]).toContain('Current route')
  })
})

// The same scenario on every surface, in concurrent sessions, after a resume, under the rollback switch, and at the
// Haiku price boundary. The router reads the session, the prompt and the steps; none of it depends on the surface.
describe('Parity, sessions, rollback and boundaries', () => {
  const surfaceRun: Record<string, string[]> = {}
  const scenario = async ($: any, h: any, surface: string) => {
    await h.start($, surface)
    let n = 0
    void n
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'commit')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'where is the output folder written?')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't3' })
    return h.steps.map((s: any) => `${s.model}/${s.effort}`)
  }
  const lookupThenHard = (p: string) => (p.includes('output folder') ? judge({ tier: 'T0', complexity: 'trivial', newTask: true }) : judge({ tier: 'T3', complexity: 'complex' }))

  for (const surface of ['terminal', 'vscode', 'desktop']) {
    test(`the same scenario on ${surface}`, async ($, on) => {
      const h = harness(on, { policy: 'auto', judge: lookupThenHard })
      h.setPrefix(60_000)
      surfaceRun[surface] = await scenario($, h, surface)
      expect(surfaceRun[surface].length).toBe(3)
    })
  }

  test('every surface chose the same models and efforts', () => {
    expect(surfaceRun.vscode).toEqual(surfaceRun.terminal)
    expect(surfaceRun.desktop).toEqual(surfaceRun.terminal)
  })

  test('two sessions in one process keep their own routes; resuming the first restores its own', async ($, on) => {
    // Session A's task needs Opus by both judges; session B's lookup does not.
    const opusWork = (p: string) => (p.includes('output folder') ? perModel({})(p) : perModel({ sonnet: ['opus', 'high'], haiku: ['opus', 'high'], opus: ['opus', 'medium'] })(p))
    const h = harness(on, { policy: 'auto', sessionId: 'sess-A', effortJudge: opusWork, judge: (p: string) => (p.includes('output folder') ? judge({ tier: 'T0', complexity: 'trivial', newTask: true }) : judge({ tier: 'T3', complexity: 'complex' })) })
    h.setPrefix(60_000)
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    h.setSession('sess-B', 'claude-sonnet-5-5[1m]')
    await h.submit($, 'where is the output folder written?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 'b1' })
    expect(h.steps.at(-1)?.model).not.toBe('claude-opus-5-5') // B starts from its own state
    h.setSession('sess-A', 'claude-sonnet-5-5[1m]')
    await h.submit($, 'commit') // resumed: the snapshot holds A's Opus route and task
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 'a2' })
    expect(h.steps.at(-1)).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' })
  })

  test('rollback: the environment switch wins over a config that says auto', async ($, on) => {
    const h = harness(on, { policy: 'legacy', config: { policy: 'auto' }, judge: hard })
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    expect(decisions(records(h.writes))[0].policy).toBe('legacy')
  })

  for (const [median, model] of [[75_999, 'claude-haiku-5-5'], [76_001, 'claude-sonnet-5-5']] as const) {
    test(`the Haiku limit is exact: a measured size of ${median} (plus 4,000 headroom) routes a lookup to ${model}`, async ($, on) => {
      const h = harness(on, { sessionId: `edge-${median}`, firstPrefixes: { unknown: [median] }, judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }), effortJudge: says('haiku', 'low') })
      await h.submit($, 'where is the output folder written?')
      await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 'e1' })
      expect(h.steps[0].model).toBe(model)
    })
  }
})

describe('Escalation on a strong route is one step, and ends when the check passes (live L5B, policy auto)', () => {
  const failing = { result: 'Error: Exit code 1\n--- FAIL: TestPlanted (0.00s)\n    c_test.go:9: got 1 want 2\nFAIL', isError: true, text: '' }
  const passing = { result: 'ok  \texample/config\t0.2s', isError: false, text: '' }
  const opusHigh = perModel({ opus: ['opus', 'high'], sonnet: ['opus', 'high'] })

  test('a repeated defect on Opus high goes to Opus xhigh, never straight to max', async ($, on) => {
    const h = harness(on, { policy: 'auto', judge: hard, effortJudge: opusHigh, bash: () => failing })
    await h.submit($, 'TestPlanted in src/config fails; find the cause and fix it')
    await h.step($)
    expect([h.steps[0].model, h.steps[0].effort]).toEqual(['claude-opus-5-5', 'high'])
    await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/' })
    await $.tool.call({ tool: 'Edit', file_path: 'c.go', old_string: 'a', new_string: 'b' })
    const second = await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/' })
    expect(JSON.stringify(second)).toContain('escalated to T3 (opus xhigh)')
    await h.step($)
    expect([h.steps[1].model, h.steps[1].effort]).toEqual(['claude-opus-5-5', 'xhigh'])
    const esc = records(h.writes).filter((x) => x.kind === 'escalation').at(-1)
    expect(esc).toMatchObject({ floor: 'T3', band: 4, route: 'opus/xhigh' })
    // Only a repeat on xhigh reaches max.
    await $.tool.call({ tool: 'Edit', file_path: 'c.go', old_string: 'b', new_string: 'c' })
    await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/' })
    await h.step($)
    expect(h.steps[2].effort).toBe('max')
  })

  test('the defect\'s own check passing ends its floor; the required review stays', async ($, on) => {
    let fixed = false
    const h = harness(on, { policy: 'auto', judge: hard, effortJudge: opusHigh, bash: () => (fixed ? passing : failing) })
    await h.submit($, 'TestPlanted in src/config fails; find the cause and fix it')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/' })
    await $.tool.call({ tool: 'Edit', file_path: 'c.go', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/' })
    await h.step($)
    expect(h.steps[1].effort).toBe('xhigh')
    fixed = true
    await $.tool.call({ tool: 'Edit', file_path: 'c.go', old_string: 'b', new_string: 'c' })
    await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/' })
    await h.step($)
    const trig = decisions(records(h.writes)).filter((d) => d.point === 'trigger').at(-1)
    expect(trig.effective.floor).not.toBe('T4')
    expect(['high', 'xhigh']).toContain(h.steps[2].effort) // never max after the fix passed
    expect(h.steps[2].model).toBe('claude-opus-5-5')
    expect(trig.risk.reviewRequired).toBe(true)
  })

  test('legacy keeps its escalation unchanged', async ($, on) => {
    const h = harness(on, { policy: 'legacy', judge: hard, bash: () => failing })
    await h.submit($, 'TestPlanted in src/config fails; find the cause and fix it')
    await h.step($)
    await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/' })
    await $.tool.call({ tool: 'Edit', file_path: 'c.go', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'go test ./src/config/' })
    const esc = records(h.writes).filter((x) => x.kind === 'escalation').at(-1)
    expect(esc.band).toBeUndefined()
  })
})
