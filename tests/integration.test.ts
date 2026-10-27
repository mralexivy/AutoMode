// Integration behavior of the auto-mode code path: mode transitions, provider failure, subagent routing,
// the request ledger, per-session record files, and routing-quality records. Mocked engine; no API calls.
import { describe, expect, test } from 'claude-code/testing'
import { harness, judge, records, says } from './harness.ts'

const decisions = (r: any[]) => r.filter((x) => x.kind === 'decision')

describe('Modes: off, shadow, auto, and switching between them', () => {
  test('shadow observes, auto applies, off does nothing; each takes effect on the next prompt', async ($, on) => {
    const h = harness(on, { mode: 'shadow', judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }), effortJudge: says('haiku', 'low') })
    await h.submit($, 'where is the output folder written?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 's1' })
    await h.complete($)
    expect(h.steps[0].model).toBe('claude-sonnet-5-5') // shadow: no rewrite
    h.setMode('auto')
    await h.submit($, 'where is the uninstall code?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 's2' })
    await h.complete($)
    expect(h.steps[1].model).toBe('claude-haiku-5-5') // auto: applied
    h.setMode('off') // config change, read on the next prompt (the env kill switch has its own test)
    const before = records(h.writes).length
    await h.submit($, 'where is the setup flag parsed?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 's3' })
    await h.complete($)
    expect(h.steps[2].model).toBe('claude-sonnet-5-5') // off: no routing from the next prompt on
    expect(records(h.writes).length).toBe(before)
  })

  test('records go to one file per session, so two Claude Code processes never overwrite each other', async ($, on) => {
    const h = harness(on, {})
    await h.submit($, 'add retries to the uploader')
    await h.step($)
    await h.complete($)
    const files = Object.keys(h.writes).filter((k) => k.includes('/records/'))
    expect(files.length).toBe(1)
    expect(files[0]).toMatch(/\/records\/sess-\d+\.jsonl$/)
  })
})

describe('Provider errors: a cancel is not a refusal, and a model is skipped only after repeated failures', () => {
  // One prompt, one failing first request on the routed model, then the app's own model answers.
  const refused = async ($: any, h: any, text: string, turnId: string) => {
    await h.submit($, text)
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId })
  }

  test('one refusal does not exclude the model: the request returns to the app model and the next prompt routes to it again', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }), effortJudge: says('haiku', 'low') })
    h.failModel('claude-haiku-5-5')
    await h.submit($, 'where is the output folder written?')
    await h.step($)
    await h.step($, 'claude-sonnet-5-5', undefined, { index: 1 })
    await h.complete($)
    expect(h.steps.map((s) => s.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5'])
    expect(records(h.writes).some((x) => x.kind === 'provider-failure' && x.family === 'haiku' && x.class === 'no-response' && x.breaker === 'counting')).toBe(true)
    await h.submit($, 'where is the uninstall code?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' })
    expect(h.steps[2].model).toBe('claude-haiku-5-5')
  })

  test('three refusals in a row open a breaker for that model for five minutes; then it is tried again', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }), effortJudge: says('haiku', 'low') })
    h.failModel('claude-haiku-5-5')
    for (const [i, t] of ['where is a?', 'where is b?', 'where is c?'].entries()) await refused($, h, t, `r${i}`)
    await h.complete($) // a turn that ends writes the buffered records
    expect(records(h.writes).filter((x) => x.kind === 'provider-failure').map((x) => x.breaker)).toEqual(['counting', 'counting', 'open'])
    await refused($, h, 'where is d?', 'r3')
    expect(h.steps[3].model).not.toBe('claude-haiku-5-5')
    expect(h.toasts.some((t) => t.includes('Routing without it for 5 minutes'))).toBe(true)
    await h.clock.advance(300_001)
    h.failModel(null)
    await refused($, h, 'where is e?', 'r4')
    expect(h.steps[4].model).toBe('claude-haiku-5-5')
  })

  test('a turn that ends aborted undoes the failure it counted (Esc)', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }), effortJudge: says('haiku', 'low') })
    h.failModel('claude-haiku-5-5')
    for (let i = 0; i < 4; i++) {
      await refused($, h, `where is z${i}?`, `a${i}`)
      // The engine reports an interrupt as reason 'aborted'; the older isAborted flag counts too.
      await h.complete($, 'claude-sonnet-5-5', undefined, 'x', i % 2 ? { isAborted: true, turnId: `a${i}` } : { reason: 'aborted', turnId: `a${i}` })
    }
    expect(records(h.writes).filter((x) => x.kind === 'interrupt' && x.undone).length).toBe(4)
    await refused($, h, 'where is w?', 'a9')
    expect(h.steps[4].model).toBe('claude-haiku-5-5')
  })
})

describe('Subagent routing and the request ledger', () => {
  test('a general-purpose subagent of an Opus session runs on Sonnet at the task effort; the request is in the ledger', async ($, on) => {
    const h = harness(on, { policy: 'legacy', judge: judge({ tier: 'T3', complexity: 'complex' }) })
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    const res = await $.agent.spawn({ subagentType: 'general-purpose', prompt: 'map the call sites', description: 'map', parentModel: 'claude-opus-5-5' })
    expect(h.spawned.at(-1)).toEqual({ subagentType: 'general-purpose', model: 'sonnet' })
    await h.step($, 'claude-sonnet-5-5', res.agentId, { turnId: 'a1' })
    expect(h.steps.at(-1)?.effort).toBe('xhigh')
    await h.complete($, 'claude-opus-5-5')
    const r = records(h.writes)
    expect(r.find((x) => x.kind === 'spawn')).toMatchObject({ type: 'general-purpose', to: 'sonnet', effort: 'xhigh' })
    expect(r.find((x) => x.kind === 'request' && x.agentId === res.agentId)).toMatchObject({ owner: 'subagent-policy', sent: { effort: 'xhigh' }, usd: { basis: 'measured' } })
  })

  test('plugin agents, reviewers and calls with an explicit model keep their model', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T3', complexity: 'complex' }) })
    await h.submit($, 'design the cache layer')
    await $.agent.spawn({ subagentType: 'automode:reviewer', prompt: 'review', description: 'r', parentModel: 'claude-opus-5-5' })
    await $.agent.spawn({ subagentType: 'bulletproof-planner', prompt: 'plan', description: 'p', parentModel: 'claude-opus-5-5' })
    await $.agent.spawn({ subagentType: 'general-purpose', prompt: 'x', description: 'x', model: 'opus', parentModel: 'claude-opus-5-5' })
    expect(h.spawned.map((s) => s.model)).toEqual([undefined, undefined, 'opus'])
  })

  test('a general-purpose subagent of a Sonnet session is left alone', async ($, on) => {
    const h = harness(on, {})
    await h.submit($, 'add retries to the uploader')
    await $.agent.spawn({ subagentType: 'general-purpose', prompt: 'x', description: 'x', parentModel: 'claude-sonnet-5-5' })
    expect(h.spawned[0].model).toBeUndefined()
  })

  test('shadow mode never changes a subagent, but still records its requests', async ($, on) => {
    const h = harness(on, { mode: 'shadow' })
    await h.submit($, 'design the cache layer')
    const res = await $.agent.spawn({ subagentType: 'general-purpose', prompt: 'x', description: 'x', parentModel: 'claude-opus-5-5' })
    expect(h.spawned[0].model).toBeUndefined()
    await h.step($, 'claude-opus-5-5', res.agentId)
    await h.complete($)
    expect(records(h.writes).find((x) => x.kind === 'request' && x.agentId === res.agentId)?.owner).toBe('app')
  })

  test('the judge call is in the ledger with its measured cost', async ($, on) => {
    const h = harness(on, {})
    await h.submit($, 'add retries to the uploader')
    await h.complete($)
    expect(records(h.writes).find((x) => x.kind === 'model-call')).toMatchObject({ purpose: 'judge', ok: true, usd: { basis: 'measured' } })
  })

  test('concurrent subagents: interleaved requests are each recorded under their own agent', async ($, on) => {
    const h = harness(on, { judge: judge({ tier: 'T3', complexity: 'complex' }) })
    await h.submit($, 'design the cache layer')
    const a = await $.agent.spawn({ subagentType: 'general-purpose', prompt: 'a', description: 'a', parentModel: 'claude-opus-5-5' })
    const b = await $.agent.spawn({ subagentType: 'Explore', prompt: 'b', description: 'b' })
    await Promise.all([h.step($, 'claude-sonnet-5-5', a.agentId, { turnId: 'x' }), h.step($, 'claude-haiku-5-5', b.agentId, { turnId: 'y' })])
    await h.complete($)
    const reqs = records(h.writes).filter((x) => x.kind === 'request' && x.agentId)
    expect(new Set(reqs.map((x) => x.agentId))).toEqual(new Set([a.agentId, b.agentId]))
  })
})

describe('Routing quality records', () => {
  test('a cache-policy hold is recorded as over-routing with its owner; a correction as an under-routing signal', async ($, on) => {
    let n = 0
    const h = harness(on, { policy: 'legacy', judge: () => judge(n++ === 0 ? { tier: 'T3', complexity: 'complex' } : { tier: 'T1', complexity: 'standard', newTask: true, confidence: 0.95 }) })
    h.setPrefix(60_000)
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($)
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, 'add a --verbose flag to the usage command')
    await h.step($, 'claude-opus-5-5', undefined, { turnId: 't2' })
    await h.complete($, 'claude-opus-5-5')
    await h.submit($, "that's wrong, the flag is ignored")
    await h.complete($)
    const r = records(h.writes)
    expect(decisions(r)[1].routing).toMatchObject({ cheapestAdequate: 'sonnet/medium', overRouted: 'cache-policy' })
    expect(r.find((x) => x.kind === 'signal' && x.underRouting)).toBeTruthy()
  })
})

describe('Classified provider errors: the class decides, not the count alone (E)', () => {
  const sig = (id: string) => `/cfg/plugins/data/automode/signals/${id}.json`
  const setup = (id: string) => ({ sessionId: id, judge: judge({ tier: 'T0', complexity: 'trivial', effort: 'low' }), effortJudge: says('haiku', 'low'), env: { CLAUDE_CONFIG_DIR: '/cfg' } })
  // One refused request per prompt, then Claude Code's StopFailure word for it, as the command hook writes it.
  const cycle = async ($: any, h: any, id: string, n: number, word: string | null, detail = '') => {
    await h.submit($, `where is item ${n}?`)
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: `k${n}` })
    if (word) {
      const prior = h.writes[sig(id)] ? JSON.parse(h.writes[sig(id)]) : { seq: 0, errors: [] }
      h.writes[sig(id)] = JSON.stringify({ seq: prior.seq + 1, compactions: [], errors: [...prior.errors, { at: 1_000_000 + off + n, error: word, detail }] })
    }
  }
  // The harness is read-only, so the clock offset is tracked here: error times must follow the mock clock.
  let off = 0
  const adv = async (h: any, ms: number) => { off += ms; await h.clock.advance(ms) }
  const fresh = (on: any, id: string) => { off = 0; return harness(on, setup(id)) }
  const haikuAt = async ($: any, h: any, text: string, i: number) => { await h.submit($, text); await h.step($, 'claude-sonnet-5-5', undefined, { turnId: `z${i}` }); return h.steps.at(-1).model }

  test('rate limits keep a short cooldown: the breaker opens after three and closes after two minutes', async ($, on) => {
    const h = fresh(on, 'err-rl')
    h.failModel('claude-haiku-5-5')
    for (let n = 0; n < 3; n++) await cycle($, h, 'err-rl', n, 'rate_limit', 'status 429')
    expect(await haikuAt($, h, 'where is item 9?', 1)).not.toBe('claude-haiku-5-5')
    await adv(h, 120_001)
    h.failModel(null)
    expect(await haikuAt($, h, 'where is item 10?', 2)).toBe('claude-haiku-5-5')
    await h.complete($)
    const e = records(h.writes).filter((x: any) => x.kind === 'provider-error')
    expect(e.map((x: any) => [x.class, x.action])).toEqual([['rate_limit', 'breaker'], ['rate_limit', 'breaker'], ['rate_limit', 'breaker']])
  })

  test('a credentials error is the person\'s to fix: no count, one notice, the model stays routable', async ($, on) => {
    const h = fresh(on, 'err-auth')
    h.failModel('claude-haiku-5-5')
    for (let n = 0; n < 4; n++) await cycle($, h, 'err-auth', n, 'authentication_failed', '401')
    expect(await haikuAt($, h, 'where is item 9?', 1)).toBe('claude-haiku-5-5')
    expect(h.toasts.filter((t: string) => t.includes('Another model will not help')).length).toBe(1)
    await h.complete($)
    expect(records(h.writes).filter((x: any) => x.kind === 'provider-error').every((x: any) => x.action === 'notify')).toBe(true)
  })

  test('model_not_found opens the breaker at once, for thirty minutes', async ($, on) => {
    const h = fresh(on, 'err-nf')
    h.failModel('claude-haiku-5-5')
    await cycle($, h, 'err-nf', 0, 'model_not_found', 'model not found')
    expect(await haikuAt($, h, 'where is item 9?', 1)).not.toBe('claude-haiku-5-5')
    await adv(h, 29 * 60_000)
    expect(await haikuAt($, h, 'where is item 10?', 2)).not.toBe('claude-haiku-5-5')
    await adv(h, 2 * 60_000)
    h.failModel(null)
    expect(await haikuAt($, h, 'where is item 11?', 3)).toBe('claude-haiku-5-5')
  })

  test('an output limit and a context overflow are not the model\'s fault', async ($, on) => {
    const h = fresh(on, 'err-ctx')
    h.failModel('claude-haiku-5-5')
    await cycle($, h, 'err-ctx', 0, 'max_output_tokens')
    await cycle($, h, 'err-ctx', 1, 'invalid_request', 'prompt is too long: 250000 tokens')
    await cycle($, h, 'err-ctx', 2, 'invalid_request', 'prompt is too long: 260000 tokens')
    // Not counted against Haiku as a failure; but Haiku's own context limit keeps it out until a compaction (next test).
    expect(await haikuAt($, h, 'where is item 9?', 1)).not.toBe('claude-haiku-5-5')
    expect(records(h.writes).filter((x: any) => x.kind === 'provider-failure' && x.breaker === 'open').length).toBe(0)
    await h.complete($)
    // The third request no longer goes to Haiku, so only two errors are classified.
    expect(records(h.writes).filter((x: any) => x.kind === 'provider-error').map((x: any) => x.action)).toEqual(['ignore', 'context'])
  })

  test('a context overflow on Haiku keeps Haiku out until the next compaction', async ($, on) => {
    const h = fresh(on, 'err-hctx')
    h.failModel('claude-haiku-5-5')
    await cycle($, h, 'err-hctx', 0, 'invalid_request', 'prompt is too long: 230000 tokens > 200000 maximum')
    h.failModel(null)
    expect(await haikuAt($, h, 'where is item 9?', 1)).not.toBe('claude-haiku-5-5')
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'x', toolUses: [] }] })
    expect(await haikuAt($, h, 'where is item 10?', 2)).toBe('claude-haiku-5-5')
  })

  test('an invalid request after a rewrite turns effort changes off and keeps the model route', async ($, on) => {
    const h = fresh(on, 'err-inv')
    h.failModel('claude-haiku-5-5')
    await cycle($, h, 'err-inv', 0, 'invalid_request', 'messages.3.output_config: Extra inputs are not permitted')
    await h.submit($, 'where is item 9?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 'z1' })
    expect(h.toasts.some((t: string) => t.includes('Effort changes are off'))).toBe(true)
    await h.complete($)
    expect(records(h.writes).some((x: any) => x.kind === 'provider-error' && x.action === 'effort-unsupported')).toBe(true)
  })

  test('after a refused rewrite, later requests keep the app effort for the rest of the session', async ($, on) => {
    off = 0
    const h = harness(on, { policy: 'legacy', ...setup('err-eff'), judge: judge({ tier: 'T3', complexity: 'complex' }) })
    h.failModel('claude-opus-5-5')
    await cycle($, h, 'err-eff', 0, 'invalid_request', 'messages.3.output_config: Extra inputs are not permitted')
    h.failModel(null)
    await h.submit($, 'design the cache layer for the decision records')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 'z1', effort: 'medium' })
    expect(h.steps.at(-1)).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' })
  })

  test('a cancelled half-open probe closes the breaker again instead of reopening it (review finding)', async ($, on) => {
    const h = fresh(on, 'err-probe')
    h.failModel('claude-haiku-5-5')
    for (let n = 0; n < 3; n++) await cycle($, h, 'err-probe', n, null)
    await adv(h, 300_001) // the cooldown ends: the next attempt is the one probe
    await h.submit($, 'where is item 4?')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 'probe' })
    await h.complete($, 'claude-sonnet-5-5', undefined, 'x', { reason: 'aborted', turnId: 'probe' }) // the person pressed Esc on it
    h.failModel(null)
    expect(await haikuAt($, h, 'where is item 5?', 1)).toBe('claude-haiku-5-5')
  })

  test('a 400 on a request whose only rewrite was the effort turns effort changes off and opens no breaker (review finding)', async ($, on) => {
    off = 0
    const h = harness(on, { ...setup('err-eo'), judge: judge({ tier: 'T1', complexity: 'standard' }), effortJudge: says('sonnet') })
    h.failModel('claude-sonnet-5-5')
    await h.submit($, 'add retries to the uploader')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 'q1', effort: 'low' })
    expect(h.steps[0].effort).toBe('medium') // rewritten from the app's low
    h.writes[sig('err-eo')] = JSON.stringify({ seq: 1, compactions: [], errors: [{ at: 1_000_000 + 1, error: 'invalid_request', detail: 'messages.3.output_config: Extra inputs are not permitted' }] })
    h.failModel(null)
    await h.submit($, 'add retries to the importer')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 'q2', effort: 'low' })
    expect(h.steps[1].effort).toBe('low') // the app's own effort again
    expect(h.toasts.some((t: string) => t.includes('Effort changes are off'))).toBe(true)
    await h.complete($)
    const r = records(h.writes)
    expect(r.some((x: any) => x.kind === 'provider-failure' && x.breaker === 'not-counted')).toBe(true)
    expect(r.every((x: any) => x.kind !== 'provider-error' || !('detail' in x))).toBe(true) // no error text in records
  })

  test('an unclassified failure keeps the three-in-a-row default', async ($, on) => {
    const h = fresh(on, 'err-un')
    h.failModel('claude-haiku-5-5')
    for (let n = 0; n < 3; n++) await cycle($, h, 'err-un', n, null)
    expect(await haikuAt($, h, 'where is item 9?', 1)).not.toBe('claude-haiku-5-5')
  })
})

describe('Subagent routing outside AutoMode (opt-in, subagentsEverySession)', () => {
  // Evidence: bench/retro-replay.mjs (2026-10-26). Opus subagents in plain Opus sessions were a
  // measurable share of spend; the subagent rule needs no judge, so it can run in any session.
  const spawn = ($: any, subagentType: string, model?: string) => $.agent.spawn({ subagentType, prompt: 'map the call sites', description: 'map', parentModel: 'claude-opus-5-5', ...(model ? { model } : {}) })
  const plainOpus = (on: any, config: Record<string, unknown> = { subagentsEverySession: true }) => harness(on, { model: 'claude-opus-5-5', config })

  test('in a plain Opus session, general-purpose runs on Sonnet and Explore on Haiku, with no judge call', async ($, on) => {
    const h = plainOpus(on)
    await spawn($, 'general-purpose')
    await spawn($, 'Explore')
    expect(h.spawned).toEqual([{ subagentType: 'general-purpose', model: 'sonnet' }, { subagentType: 'Explore', model: 'haiku' }])
    expect(h.judged.length + h.effortJudged.length).toBe(0)
  })

  test('an explicit model, a plugin agent and a reviewer keep their model', async ($, on) => {
    const h = plainOpus(on)
    await spawn($, 'general-purpose', 'opus')
    await spawn($, 'automode:reviewer')
    await spawn($, 'code-reviewer')
    expect(h.spawned.map((s: any) => s.model)).toEqual(['opus', undefined, undefined])
  })

  for (const [name, config] of [['off by default', {}], ['never in mode off', { subagentsEverySession: true, mode: 'off' }], ['never in mode shadow', { subagentsEverySession: true, mode: 'shadow' }]] as const) {
    test(`${name}: the subagent keeps the session's model`, async ($, on) => {
      const h = plainOpus(on, config)
      await spawn($, 'general-purpose')
      expect(h.spawned.at(-1)).toEqual({ subagentType: 'general-purpose', model: undefined })
    })
  }
})
