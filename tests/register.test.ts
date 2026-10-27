// Tests for hooks/register.ts under `claude plugin test plugins/automode`. The test's own hooks
// stand for the engine: the session's model, model completions, usage, agents, the clock, and the
// bottom of each chain.
import { describe, expect, test } from 'claude-code/testing'

const HM = 'claude-sonnet-5-5[1m]'
const usage = { input_tokens: 300, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Setup = {
  model?: string; judge?: string | null; router?: string; policy?: string
  limit?: number; contextTokens?: number; liveAgents?: number; summary?: string | null
}

// harness wires the engine side and returns helpers to submit a prompt, run a request, and compact.
function harness(on: any, setup: Setup) {
  const judged: string[] = []
  const compacted: string[] = []
  const toasts: string[] = []
  let effortSeen: unknown
  let now = 1_000_000
  on('session.model', () => ({ value: setup.model ?? HM }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$: unknown, e: unknown) => { toasts.push(typeof e === 'string' ? e : JSON.stringify(e)); return { value: undefined } })
  on('clock.now', () => ({ value: now }))
  on('fs.read', () => ({ value: JSON.stringify({ router: setup.router ?? 'judge', ...(setup.policy ? { reviewPolicy: setup.policy } : {}) }) }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: setup.contextTokens ?? 10000, window: 1000000 }, rateLimits: setup.limit === undefined ? [] : [{ kind: 'five_hour', percentUsed: setup.limit }] } }))
  on('agent.list', () => ({ value: Array.from({ length: setup.liveAgents ?? 0 }, (_, i) => ({ id: `a${i}`, description: 'x', type: 'general-purpose', status: 'running' })) }))
  on('session.messages', () => ({ value: [] }))
  on('model.complete', (_$: unknown, e: { prompt: string; system?: string }) => {
    if (String(e.system).startsWith('You compact')) {
      compacted.push(String(e.prompt))
      return setup.summary === null
        ? { value: { isAnswered: false, reason: 'api-error', status: 529 } }
        : { value: { isAnswered: true, text: setup.summary ?? 'S'.repeat(400), usage } }
    }
    judged.push(String(e.prompt))
    return setup.judge === null
      ? { value: { isAnswered: false, reason: 'api-error', status: 529 } }
      : { value: { isAnswered: true, text: setup.judge ?? '{"path":"change","effort":"low","why":"small edit"}', usage } }
  })
  on('prompt.submit', (_$: unknown, e: { text: string; context?: readonly string[] }) => ({ text: e.text, context: e.context ?? [] }))
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number; effort?: unknown }) {
    effortSeen = e.effort
    return { turnId: e.turnId, index: e.index, answer: 'Done: renamed the constant.', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'engine summary', toolUses: [] }] }))
  return {
    judged, compacted, toasts,
    advance: (ms: number) => { now += ms },
    submit: async ($: any, text: string, extra: Record<string, unknown> = {}) =>
      (await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, ...extra })) as { context: string[] },
    step: async ($: any, opts: { agentId?: string; appEffort?: string } = {}) => {
      const s = $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: opts.appEffort ?? 'medium', messageCount: 3, ...(opts.agentId ? { agentId: opts.agentId } : {}) })
      for await (const _ of s) { /* drain */ }
      await s.result
      return effortSeen
    },
    compact: async ($: any, trigger = 'manual') =>
      (await $.session.compact({ trigger, messages: [{ role: 'user', text: 'rename X', toolUses: [] }, { role: 'assistant', text: 'done', toolUses: [] }] })) as { messages?: { text: string }[]; skip?: string },
  }
}

describe('judge router: routing', () => {
  test('inactive session: no judge call, no context, effort untouched', async ($, on) => {
    const h = harness(on, { model: 'sonnet' })
    const out = await h.submit($, 'add retries to the uploader')
    expect(h.judged.length).toBe(0)
    expect(out.context.length).toBe(0)
    expect(await h.step($)).toBe('medium')
  })

  test('router classic: the module stays out of the way', async ($, on) => {
    const h = harness(on, { router: 'classic' })
    const out = await h.submit($, 'add retries to the uploader')
    expect(h.judged.length).toBe(0)
    expect(out.context.length).toBe(0)
  })

  test('active: the judge picks change at low effort, and the request runs at low', async ($, on) => {
    const h = harness(on, {})
    const out = await h.submit($, 'rename the uploader timeout constant')
    expect(h.judged.length).toBe(1)
    expect(out.context[0]).toContain('[AutoMode: change, effort low')
    expect(out.context[0]).toContain('Never report a change as done without a passing check')
    expect(out.context[0]).not.toContain('automode:reviewer')
    expect(await h.step($)).toBe('low')
  })

  test('subagent requests keep their own effort', async ($, on) => {
    const h = harness(on, {})
    await h.submit($, 'rename the uploader timeout constant')
    expect(await h.step($, { agentId: 'agent-1' })).toBe('medium')
  })

  test('a risk match raises a change to an Opus review', async ($, on) => {
    const h = harness(on, {})
    const out = await h.submit($, 'pin the OAuth scopes for the gateway servers')
    expect(out.context[0]).toContain('[AutoMode: review')
    expect(out.context[0]).toContain('automode:reviewer')
    expect(out.context[0]).toContain('Do not act on non-blocking notes')
  })

  test('plural risk words count too', async ($, on) => {
    const h = harness(on, {})
    const out = await h.submit($, 'make GetExistingPlugins safe to call from several goroutines at once')
    expect(out.context[0]).toContain('[AutoMode: review')
  })

  test('a file name alone does not trigger the risk rule', async ($, on) => {
    const h = harness(on, {})
    const out = await h.submit($, 'split src/setup/auth.go into smaller files by responsibility')
    expect(out.context[0]).toContain('[AutoMode: change')
  })

  test('reviewPolicy never: a risky change stays on Sonnet with no Opus review', async ($, on) => {
    const h = harness(on, { policy: 'never', judge: '{"path":"review","effort":"medium","why":"auth change"}' })
    const out = await h.submit($, 'pin the OAuth scopes for the gateway servers')
    expect(out.context[0]).toContain('[AutoMode: change')
    expect(out.context[0]).not.toContain('automode:reviewer')
  })

  test('chat adds no context at all', async ($, on) => {
    const h = harness(on, { judge: '{"path":"chat","effort":"low","why":"question"}' })
    const out = await h.submit($, 'what does the uploader do?')
    expect(out.context.length).toBe(0)
  })

  test('open-ended risky work gets the workflow as critical', async ($, on) => {
    const h = harness(on, { judge: '{"path":"workflow","effort":"high","why":"design across modules"}' })
    const out = await h.submit($, 'redesign how we store credentials across services')
    expect(out.context[0]).toContain('Workflow({ name: "automode:run"')
    expect(out.context[0]).toContain('tier: "critical"')
  })

  test('slash commands and am:direct skip the judge', async ($, on) => {
    const h = harness(on, {})
    await h.submit($, '/compact')
    const out = await h.submit($, 'am:direct update the README badge')
    expect(h.judged.length).toBe(0)
    expect(out.context[0]).toContain('[AutoMode: change')
  })
})

describe('judge router: what the judge sees', () => {
  test('follow-ups keep the verdict and ask no judge', async ($, on) => {
    const h = harness(on, { judge: '{"path":"change","effort":"high","why":"tricky bug"}' })
    await h.submit($, 'fix the flaky retry test')
    const out = await h.submit($, 'ok')
    expect(h.judged.length).toBe(1)
    expect(out.context[0]).toContain('change, effort high')
  })

  test('a follow-up with an attachment is judged: "fix this" plus a screenshot is new work', async ($, on) => {
    const h = harness(on, {})
    await h.submit($, 'fix the flaky retry test')
    await h.submit($, 'ok', { attachments: [{ kind: 'image', mediaType: 'image/png' }] })
    expect(h.judged.length).toBe(2)
    expect(h.judged[1]).toContain('With 1 attachment(s)')
  })

  test('the judge sees the last reply and a prompt typed mid-turn', async ($, on) => {
    const h = harness(on, {})
    await h.submit($, 'rename the uploader timeout constant')
    await h.step($)
    await h.submit($, 'also rename the retry constant', { turnId: 't1' })
    expect(h.judged[1]).toContain('Last reply (start): Done: renamed the constant.')
    expect(h.judged[1]).toContain('Typed while a turn is running.')
  })
})

describe('judge router: effort control', () => {
  test('named effort wins over the judge, and the path still comes from the judge', async ($, on) => {
    const h = harness(on, { judge: '{"path":"change","effort":"low","why":"small"}' })
    const out = await h.submit($, 'use max effort and rename the constant')
    expect(out.context[0]).toContain('[AutoMode: change, effort max')
    expect(await h.step($)).toBe('max')
  })

  test('negated named effort is ignored', async ($, on) => {
    const h = harness(on, { judge: '{"path":"change","effort":"low","why":"small"}' })
    await h.submit($, 'rename it, no need for max effort')
    expect(await h.step($)).toBe('low')
  })

  test('a manual effort change turns Auto off: the person always wins', async ($, on) => {
    const h = harness(on, {})
    await h.submit($, 'rename the uploader timeout constant')
    expect(await h.step($, { appEffort: 'medium' })).toBe('low')
    expect(await h.step($, { appEffort: 'xhigh' })).toBe('xhigh')
    await h.submit($, 'rename another constant')
    expect(await h.step($, { appEffort: 'xhigh' })).toBe('xhigh')
    expect(h.toasts.some((t) => t.includes('Auto effort is off'))).toBe(true)
  })

  test('save mode caps effort at medium past the limit share', async ($, on) => {
    const h = harness(on, { limit: 85, judge: '{"path":"change","effort":"high","why":"hard bug"}' })
    const out = await h.submit($, 'find the race in the retry loop')
    expect(out.context[0]).toContain('effort medium')
    expect(h.toasts.some((t) => t.includes('save mode'))).toBe(true)
  })
})

describe('judge router: failures', () => {
  test('a malformed judge reply falls back to change at medium, with one notice', async ($, on) => {
    const h = harness(on, { judge: 'sure! path is change' })
    const out = await h.submit($, 'add retries to the uploader')
    await h.submit($, 'add retries to the downloader')
    expect(out.context[0]).toContain('[AutoMode: change, effort medium (judge unavailable)')
    expect(h.toasts.filter((t) => t.includes('did not answer')).length).toBe(1)
  })

  test('judge API error falls back too, and the risk rule still applies', async ($, on) => {
    const h = harness(on, { judge: null })
    const out = await h.submit($, 'rotate the JWT secret')
    expect(out.context[0]).toContain('[AutoMode: review')
  })
})

describe('judge router: Haiku compaction', () => {
  test('Haiku writes the summary on an active session', async ($, on) => {
    const h = harness(on, { summary: 'Request: rename X. ' + 'detail '.repeat(60) })
    const out = await h.compact($)
    expect(h.compacted.length).toBe(1)
    expect(h.compacted[0]).toContain('USER: rename X')
    expect(out.messages?.[0].text).toContain('written by Haiku for AutoMode')
  })

  test('precompute is skipped: a summary written ahead by the chat model would go unused', async ($, on) => {
    const h = harness(on, {})
    const out = await h.compact($, 'precompute')
    expect(out.skip).toContain('Haiku')
  })

  test('a failed Haiku summary hands compaction back to the engine', async ($, on) => {
    const h = harness(on, { summary: null })
    const out = await h.compact($)
    expect(out.messages?.[0].text).toBe('engine summary')
    expect(h.toasts.some((t) => t.includes('could not write the summary'))).toBe(true)
  })

  test('inactive sessions compact as the engine does', async ($, on) => {
    const h = harness(on, { model: 'sonnet' })
    const out = await h.compact($)
    expect(h.compacted.length).toBe(0)
    expect(out.messages?.[0].text).toBe('engine summary')
  })
})

describe('judge router: cold cache', () => {
  test('a heavy chat idle past the cache TTL gets one hint', async ($, on) => {
    const h = harness(on, { contextTokens: 120000 })
    await h.submit($, 'rename the uploader timeout constant')
    await h.step($)
    h.advance(61 * 60000)
    await h.submit($, 'now rename the retry constant')
    await h.submit($, 'and the backoff constant')
    expect(h.toasts.filter((t) => t.includes('prompt cache went cold')).length).toBe(1)
  })

  test('no hint while agents are still running (a compaction would lose their answers)', async ($, on) => {
    const h = harness(on, { contextTokens: 120000, liveAgents: 1 })
    await h.submit($, 'rename the uploader timeout constant')
    await h.step($)
    h.advance(61 * 60000)
    await h.submit($, 'now rename the retry constant')
    expect(h.toasts.some((t) => t.includes('prompt cache went cold'))).toBe(false)
  })

  test('no hint on a light chat', async ($, on) => {
    const h = harness(on, { contextTokens: 20000 })
    await h.submit($, 'rename the uploader timeout constant')
    await h.step($)
    h.advance(61 * 60000)
    await h.submit($, 'now rename the retry constant')
    expect(h.toasts.some((t) => t.includes('prompt cache went cold'))).toBe(false)
  })
})
