// The session and cost guardian through the router's real hooks (mocked engine, no API calls). Safety first: the kill
// switch, shadow mode, no change to a tool's result except an opted-in, reversible shortening, no lost checkpoint.
import { describe, expect, test } from 'claude-code/testing'
import { harness, HM } from './harness.ts'
import { GUARDIAN_DEFAULTS as C, sealCheckpoint } from '../hooks/lib/guardian.ts'

const guardianRecords = (writes: Record<string, string>) => Object.entries(writes).filter(([k]) => /\/guardian\/[^/]+\.jsonl$/.test(k)).flatMap(([, v]) => v.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)))
const on_ = (o: Record<string, unknown> = {}) => ({ guardian: { mode: 'on', ...o } })

// A stretch of n main requests at $0.10 each, with a read between them (no outcome).
async function stretch($: any, h: any, n: number, from = 0) {
  for (let i = 0; i < n; i++) {
    h.setUsage({ usd: (from + i + 1) * 0.1 })
    await h.step($)
    await $.tool.call({ tool: 'Read', file_path: `/repo/f${(from + i) % 7}.ts` })
  }
}

describe('Guardian: off, shadow, on', () => {
  test('the kill switch: mode off records nothing and touches no result', async ($, on) => {
    const h = harness(on, { config: { guardian: { mode: 'off' } } })
    await h.start($); await h.submit($, 'map the uploader'); await h.turnStart($)
    await stretch($, h, C.warnRequests * 2 + 5)
    const r: any = await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' })
    expect(r.context ?? []).toEqual([])
    expect(guardianRecords(h.writes)).toEqual([])
  })

  test('AUTOMODE_GUARDIAN=off wins over the config file', async ($, on) => {
    const h = harness(on, { config: on_(), env: { AUTOMODE_GUARDIAN: 'off' } })
    await h.start($); await h.submit($, 'map the uploader'); await h.turnStart($)
    await stretch($, h, C.warnRequests + 5)
    await h.complete($)
    expect(guardianRecords(h.writes)).toEqual([])
  })

  test('shadow (the default) records the warning but tells the model nothing', async ($, on) => {
    const h = harness(on, {})
    await h.start($); await h.submit($, 'map the uploader'); await h.turnStart($)
    await stretch($, h, C.warnRequests + 2)
    const r: any = await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' })
    expect((r.context ?? []).some((c: string) => /AutoMode/.test(c))).toBe(false)
    await h.complete($)
    expect(guardianRecords(h.writes).some((x) => x.event === 'warning' && x.delivered === false)).toBe(true)
  })

  test('outside AutoMode the guardian is idle unless everySession is set', async ($, on) => {
    const h = harness(on, { model: 'claude-opus-5-5', config: on_() })
    await h.start($); await h.submit($, 'map the uploader'); await h.turnStart($)
    await stretch($, h, C.warnRequests + 2, 0)
    await h.complete($)
    expect(guardianRecords(h.writes)).toEqual([])
  })
})

describe('Guardian: every session (ordinary Opus keeps its model and effort)', () => {
  test('with everySession the guardian works in a plain Opus session and changes neither model nor effort, and calls no judge', async ($, on) => {
    const h = harness(on, { model: 'claude-opus-5-5', config: on_({ everySession: true }) })
    await h.start($); await h.submit($, 'map the uploader'); await h.turnStart($)
    await stretch($, h, C.warnRequests + 2, 0)
    await h.complete($, 'claude-opus-5-5')
    expect(guardianRecords(h.writes).some((x) => x.event === 'turn')).toBe(true)
    expect(h.steps.every((s: any) => s.model === 'claude-sonnet-5-5' && s.effort === 'medium')).toBe(true) // exactly what the test sent
    expect(h.judged.length + h.effortJudged.length).toBe(0)
  })

  test('one turn is accounted once: a single turn record, so no doubled hook', async ($, on) => {
    const h = harness(on, { model: 'claude-opus-5-5', config: on_({ everySession: true }) })
    await h.start($); await h.submit($, 'map the uploader'); await h.turnStart($)
    await stretch($, h, 3, 0)
    await h.complete($, 'claude-opus-5-5')
    expect(guardianRecords(h.writes).filter((x) => x.event === 'turn').length).toBe(1)
  })
})

describe('Guardian: progress notes', () => {
  test('on: one checkpoint note after both gates, not repeated, and a pause note later', async ($, on) => {
    const h = harness(on, { config: on_() })
    await h.start($); await h.submit($, 'map the uploader'); await h.turnStart($)
    const notes: string[] = []
    for (let i = 0; i < C.warnRequests * 2 + 2; i++) {
      h.setUsage({ usd: (i + 1) * 0.1 })
      await h.step($)
      const r: any = await $.tool.call({ tool: 'Read', file_path: `/repo/f${i % 7}.ts` })
      notes.push(...(r.context ?? []).filter((c: string) => /AutoMode/.test(c)))
    }
    expect(notes.length).toBe(2)
    expect(notes[0]).toMatch(/checkpoint/)
    expect(notes[1]).toMatch(/pause/)
    expect(h.aborts).toEqual([]) // no hard pause unless opted in
  })

  test('a productive turn (a passing check after each change) gets no note', async ($, on) => {
    const h = harness(on, { config: on_(), bash: () => ({ result: { stdout: 'ok', stderr: '' }, text: 'ok' }) })
    await h.start($); await h.submit($, 'add the retry'); await h.turnStart($)
    const notes: string[] = []
    for (let i = 0; i < 200; i++) {
      h.setUsage({ usd: (i + 1) * 0.1 })
      await h.step($)
      if (i % 20 === 19) {
        await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: `v${i}` })
        const r: any = await $.tool.call({ tool: 'Bash', command: 'npm test' })
        notes.push(...(r.context ?? []).filter((c: string) => /AutoMode/.test(c)))
      }
    }
    expect(notes).toEqual([])
  })

  test('am:continue lets the person authorise more work before a note', async ($, on) => {
    const h = harness(on, { config: on_() })
    await h.start($); await h.submit($, 'am:continue keep going on the migration'); await h.turnStart($)
    await stretch($, h, C.warnRequests + 2)
    expect(guardianRecords(h.writes).some((x) => x.event === 'warning')).toBe(false)
  })

  test('hard pause (opt-in) ends the turn at a request boundary, never right after a write', async ($, on) => {
    const h = harness(on, { config: on_({ mode: 'auto', hardPause: true }) })
    await h.start($); await h.submit($, 'map the uploader'); await h.turnStart($)
    for (let i = 0; i < C.warnRequests * 2 + 2; i++) {
      h.setUsage({ usd: (i + 1) * 0.1 })
      await h.step($)
      await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: `w${i}` }) // the last call is always a write
    }
    expect(h.aborts).toEqual([])
    h.setUsage({ usd: 99 }); await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' }); await h.step($)
    expect(h.aborts).toEqual(['t1'])
  })
})

describe('Guardian: output reduction (opt-in, reversible)', () => {
  const big = Array.from({ length: 3000 }, (_, i) => `line ${i} ${'x'.repeat(30)}`)
  big[1200] = 'Error: ECONNREFUSED 127.0.0.1:5432'
  const out = big.join('\n')

  test('a large Bash output is saved whole, then shortened with every error line kept', async ($, on) => {
    const h = harness(on, { config: on_({ mode: 'auto', reduceOutputs: true }), bash: () => ({ result: { stdout: out, stderr: '', interrupted: false }, text: out }) })
    await h.start($); await h.submit($, 'run the migration'); await h.turnStart($); await h.step($)
    const r: any = await $.tool.call({ tool: 'Bash', command: 'npm run migrate' })
    expect(r.result.stdout.length).toBeLessThan(out.length / 3)
    expect(r.result.stdout).toMatch(/ECONNREFUSED 127\.0\.0\.1:5432/)
    const saved = Object.entries(h.writes).find(([k]) => /\/outputs\//.test(k))
    expect(saved?.[1]).toContain(out)
    expect(r.result.stdout).toContain(saved?.[0] ?? 'missing')
  })

  test('off by default: the same output passes through untouched', async ($, on) => {
    const h = harness(on, { config: on_(), bash: () => ({ result: { stdout: out, stderr: '', interrupted: false }, text: out }) })
    await h.start($); await h.submit($, 'run the migration'); await h.turnStart($); await h.step($)
    const r: any = await $.tool.call({ tool: 'Bash', command: 'npm run migrate' })
    expect(r.result.stdout).toBe(out)
  })

  test('an error result is never shortened (its diagnostics stay whole)', async ($, on) => {
    const h = harness(on, { config: on_({ mode: 'auto', reduceOutputs: true }), bash: () => ({ result: { stdout: out, stderr: '', interrupted: false }, text: out, isError: true }) })
    await h.start($); await h.submit($, 'run the migration'); await h.turnStart($); await h.step($)
    const r: any = await $.tool.call({ tool: 'Bash', command: 'npm run migrate' })
    expect(r.result.stdout).toBe(out)
  })
})

describe('Guardian: lifecycle and handoff', () => {
  const finish = async ($: any, h: any) => {
    await h.turnStart($); await h.step($)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/up.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    h.setUsage({ context: 450_000 })
    await h.complete($)
  }
  const passing = () => ({ result: { stdout: 'all tests pass', stderr: '' }, text: 'all tests pass' })

  test('a finished task in a 450k context: /clear is offered as a suggestion (measured 9% chance of a cold return)', async ($, on) => {
    const h = harness(on, { config: on_(), bash: passing })
    await h.start($); await h.submit($, 'fix the uploader retries')
    await finish($, h)
    expect(h.suggestions).toEqual(['/clear'])
    expect(h.toasts.some((t: string) => /fresh session saves/.test(t))).toBe(true)
    expect(guardianRecords(h.writes).find((x) => x.event === 'lifecycle')?.action).toBe('clear')
  })

  test('with no chance of a cold return the warm context continues, and nothing is offered', async ($, on) => {
    const h = harness(on, { config: on_({ coldReturnRate: 0 }), bash: passing })
    h.setUsage({ context: 45_000 }) // a real base: Claude Code's system prompt and tools, measured at the first request
    await h.start($); await h.submit($, 'fix the uploader retries')
    await finish($, h)
    expect(h.suggestions).toEqual([])
    expect(guardianRecords(h.writes).find((x) => x.event === 'lifecycle')?.action).toBe('continue')
  })

  test('shadow mode offers nothing, whatever the economics', async ($, on) => {
    const h = harness(on, { bash: passing })
    await h.start($); await h.submit($, 'fix the uploader retries')
    await finish($, h)
    expect(h.suggestions).toEqual([])
    expect(h.toasts.some((t: string) => /AutoMode/.test(t))).toBe(false)
  })

  test('an unfinished task (a failing check) is never offered /clear', async ($, on) => {
    const h = harness(on, { config: on_(), bash: () => ({ result: { stdout: 'FAIL src/up.test.ts', stderr: '' }, text: 'FAIL src/up.test.ts', isError: true }) })
    await h.start($); await h.submit($, 'fix the uploader retries')
    await finish($, h)
    expect(h.suggestions).toEqual([])
  })

  for (const [label, prompt, expected] of [['a follow-up gets it', 'continue', true], ['an unrelated task starts clean', 'write a README for the CLI', false]] as const) {
    test(`after /clear in the same folder: ${label}`, async ($, on) => {
      const h = harness(on, { config: on_(), bash: passing })
      await h.start($); await h.submit($, 'fix the uploader retries')
      await finish($, h)
      const file = Object.keys(h.writes).find((k) => /\/checkpoints\/.+\/sess-\d+\.json$/.test(k))
      expect(file).toBeTruthy()
      const cp = JSON.parse(h.writes[file!])
      expect(cp).toMatchObject({ objective: 'fix the uploader retries', status: 'closed', filesChanged: ['/repo/up.ts'] })
      // session.end (reason clear) is fired by the engine, not by a test: write the pointer the way that hook does.
      const pending = file!.replace(/[^/]+\.json$/, 'pending.json')
      h.writes[pending] = JSON.stringify({ sessionId: cp.sessionId, at: 1_000_000 }) // the clear, just now: the next session is its successor
      h.setSession('sess-after-clear')
      await h.start($)
      const res = await h.submit($, prompt)
      expect(res.context.some((c: string) => /AutoMode handoff/.test(c) && /fix the uploader retries/.test(c))).toBe(expected)
      expect(h.writes[pending]).toBe('{}')
    })
  }

  test('observe mode records a handoff it would restore, and injects nothing', async ($, on) => {
    const h = harness(on, {})
    const dir = `/data/checkpoints/${'/repo'.replace(/[^\w.-]/g, '_')}`
    h.writes[`${dir}/old.json`] = sealCheckpoint({ v: 1, sessionId: 'old', cwd: '/repo', at: 999_000, objective: 'fix the uploader retries', acceptance: [], stage: 'done', status: 'closed', outcomes: ['check-passed'], filesChanged: ['/repo/up.ts'], filesRead: [], checks: [], openFailures: [], git: { branch: null, dirty: [] }, approvals: [], next: 'x' } as any)
    h.writes[`${dir}/pending.json`] = JSON.stringify({ sessionId: 'old', at: 1_000_000 })
    await h.start($)
    const res = await h.submit($, 'continue')
    expect(res.context.some((c: string) => /AutoMode handoff/.test(c))).toBe(false)
    expect(guardianRecords(h.writes).some((x) => x.event === 'handoff-would-restore')).toBe(true)
  })

  test('a stale, foreign, or incomplete checkpoint is never restored', async ($, on) => {
    const h = harness(on, { config: on_() })
    const dir = `/data/checkpoints/${'/repo'.replace(/[^\w.-]/g, '_')}`
    h.writes[`${dir}/pending.json`] = JSON.stringify({ sessionId: 'old' })
    h.writes[`${dir}/old.json`] = JSON.stringify({ v: 1, sessionId: 'old', cwd: '/repo', at: 0, objective: '', next: 'x', git: { branch: null, dirty: [] }, status: 'closed', outcomes: [], filesChanged: [], filesRead: [], checks: [], openFailures: [], approvals: [], acceptance: [], stage: 'done' })
    await h.start($)
    const res = await h.submit($, 'continue')
    expect(res.context.some((c: string) => /AutoMode handoff/.test(c))).toBe(false)
    expect(guardianRecords(h.writes).some((x) => x.event === 'handoff-rejected')).toBe(true)
  })
})

describe('Guardian: who may decline a handoff', () => {
  test('a session that did not follow the /clear leaves the handoff pending for the one that did', async ($, on) => {
    const h = harness(on, { config: on_() })
    const dir = `/data/checkpoints/${'/repo'.replace(/[^\w.-]/g, '_')}`
    h.writes[`${dir}/old.json`] = sealCheckpoint({ v: 1, sessionId: 'old', cwd: '/repo', at: 999_000, objective: 'fix the uploader retries', acceptance: [], stage: 'done', status: 'closed', outcomes: ['check-passed'], filesChanged: ['/repo/up.ts'], filesRead: [], checks: [], openFailures: [], git: { branch: null, dirty: [] }, approvals: [], next: 'x' } as any)
    h.writes[`${dir}/pending.json`] = JSON.stringify({ sessionId: 'old', at: 1_000_000 - 3_600_000 }) // an hour ago
    await h.start($)
    await h.submit($, 'write a README for the CLI')
    expect(JSON.parse(h.writes[`${dir}/pending.json`]).sessionId).toBe('old')
  })
})

describe('Guardian: a handoff belongs to the session that followed the /clear', () => {
  const dir = `/data/checkpoints/${'/repo'.replace(/[^\w.-]/g, '_')}`
  const seal = (extra: Record<string, unknown> = {}) => sealCheckpoint({ v: 1, sessionId: 'old', cwd: '/repo', at: 999_000, objective: 'fix the uploader retries', acceptance: [], stage: 'in progress', status: 'open', outcomes: ['check-passed'], filesChanged: ['/repo/up.ts'], filesRead: [], checks: [], openFailures: [], git: { branch: null, dirty: [] }, approvals: [], next: 'x', ...extra } as any)
  const restored = (res: any) => res.context.some((c: string) => /AutoMode handoff/.test(c))

  test('an unrelated chat in the same folder never restores it, even on a follow-up prompt', async ($, on) => {
    const h = harness(on, { config: on_() })
    h.writes[`${dir}/old.json`] = seal()
    h.writes[`${dir}/pending.json`] = JSON.stringify({ sessionId: 'old', at: 1_000_000 - 3_600_000, cwd: '/repo' })
    await h.start($)
    const res = await h.submit($, 'continue')
    expect(restored(res)).toBe(false)
    expect(JSON.parse(h.writes[`${dir}/pending.json`]).sessionId).toBe('old')
    expect(guardianRecords(h.writes).some((x) => x.event === 'handoff-foreign')).toBe(true)
  })

  test('the person can still ask for it from another chat with am:handoff', async ($, on) => {
    const h = harness(on, { config: on_() })
    h.writes[`${dir}/old.json`] = seal()
    h.writes[`${dir}/pending.json`] = JSON.stringify({ sessionId: 'old', at: 1_000_000 - 3_600_000, cwd: '/repo' })
    await h.start($)
    expect(restored(await h.submit($, 'am:handoff continue'))).toBe(true)
  })

  test('a pointer whose checkpoint changed after the /clear is rejected', async ($, on) => {
    const h = harness(on, { config: on_() })
    h.writes[`${dir}/old.json`] = seal()
    h.writes[`${dir}/pending.json`] = JSON.stringify({ sessionId: 'old', at: 1_000_000, cwd: '/repo', sum: 'not-the-checkpoint' })
    await h.start($)
    expect(restored(await h.submit($, 'continue'))).toBe(false)
    expect(guardianRecords(h.writes).some((x) => x.event === 'handoff-rejected' && x.missing.includes('the checkpoint named by the clear'))).toBe(true)
  })

  test('a pointer for another folder is rejected', async ($, on) => {
    const h = harness(on, { config: on_() })
    h.writes[`${dir}/old.json`] = seal()
    h.writes[`${dir}/pending.json`] = JSON.stringify({ sessionId: 'old', at: 1_000_000, cwd: '/elsewhere' })
    await h.start($)
    expect(restored(await h.submit($, 'continue'))).toBe(false)
  })

  test('it is used once: a second chat that starts after the first took it gets nothing', async ($, on) => {
    const h = harness(on, { config: on_() })
    h.writes[`${dir}/old.json`] = seal()
    h.writes[`${dir}/pending.json`] = JSON.stringify({ sessionId: 'old', at: 1_000_000, cwd: '/repo' })
    h.setSession('chat-a'); await h.start($)
    expect(restored(await h.submit($, 'continue'))).toBe(true)
    h.setSession('chat-b'); await h.start($)
    expect(restored(await h.submit($, 'continue'))).toBe(false)
  })

  test('the handoff says that earlier approvals grant nothing now', async ($, on) => {
    const h = harness(on, { config: on_() })
    h.writes[`${dir}/old.json`] = seal({ approvals: ['am:continue: more work allowed in this turn'] })
    h.writes[`${dir}/pending.json`] = JSON.stringify({ sessionId: 'old', at: 1_000_000, cwd: '/repo' })
    await h.start($)
    const res = await h.submit($, 'continue')
    expect(res.context.join('\n')).toMatch(/record only: they grant no permission in this session/)
  })
})

describe('Guardian: modes and verified restore', () => {
  const passing = () => ({ result: { stdout: 'all tests pass', stderr: '' }, text: 'all tests pass' })
  const finish = async ($: any, h: any) => {
    await h.step($)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/up.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    h.setUsage({ context: 450_000 }); await h.complete($)
  }

  test('recommend: the note and the toast, but nothing in the prompt box and no checkpoint file', async ($, on) => {
    const h = harness(on, { config: on_({ mode: 'recommend' }), bash: passing })
    await h.start($); await h.submit($, 'fix the uploader retries'); await finish($, h)
    expect(h.suggestions).toEqual([])
    expect(h.toasts.some((t: string) => /Run \/clear/.test(t))).toBe(true)
    expect(Object.keys(h.writes).some((k) => /\/checkpoints\//.test(k))).toBe(false)
  })

  test('assist without auto: the hard pause and output reduction stay off even when their flags are set', async ($, on) => {
    const h = harness(on, { config: on_({ mode: 'assist', hardPause: true, reduceOutputs: true }), bash: () => ({ result: { stdout: 'x'.repeat(50_000), stderr: '' }, text: 'x'.repeat(50_000) }) })
    await h.start($); await h.submit($, 'map it')
    for (let i = 0; i < 115; i++) { h.setUsage({ usd: (i + 1) * 0.1 }); await h.step($); await $.tool.call({ tool: 'Read', file_path: `/repo/f${i % 7}.ts` }) }
    expect(h.aborts).toEqual([])
    const r: any = await $.tool.call({ tool: 'Bash', command: 'cat big.log' })
    expect(r.result.stdout.length).toBe(50_000)
  })

  test('the restrictions the person stated travel with the checkpoint into the handoff', async ($, on) => {
    const h = harness(on, { config: on_(), bash: passing })
    await h.start($); await h.submit($, 'fix the uploader retries, do not push to origin'); await finish($, h)
    const file = Object.keys(h.writes).find((k) => /\/checkpoints\/.+\/sess-\d+\.json$/.test(k))!
    expect(JSON.parse(h.writes[file]).approvals.some((a: string) => /do not push to origin/.test(a))).toBe(true)
    h.writes[file.replace(/[^/]+\.json$/, 'pending.json')] = JSON.stringify({ sessionId: JSON.parse(h.writes[file]).sessionId, at: 1_000_000 })
    h.setSession('sess-next'); await h.start($)
    const res = await h.submit($, 'continue')
    expect(res.context.some((c: string) => /restriction: do not push to origin/.test(c))).toBe(true)
  })

  test('a checkpoint whose branch no longer matches is held, stays pending, and am:handoff restores it with a warning', async ($, on) => {
    const h = harness(on, { config: on_() })
    const dir = `/data/checkpoints/${'/repo'.replace(/[^\w.-]/g, '_')}`
    const cp = { v: 1, sessionId: 'old', cwd: '/repo', at: 999_000, objective: 'migrate the schema', acceptance: [], stage: 'in progress', status: 'open', outcomes: [], filesChanged: ['/repo/m.sql'], filesRead: [], checks: [], openFailures: [], git: { branch: 'feat-migrate', dirty: ['m.sql'] }, approvals: [], next: 'run the migration test' }
    h.writes[`${dir}/old.json`] = sealCheckpoint(cp as any)
    h.writes[`${dir}/pending.json`] = JSON.stringify({ sessionId: 'old', at: 1_000_000 })
    await h.start($)
    const held = await h.submit($, 'continue')
    expect(held.context.some((c: string) => /AutoMode handoff/.test(c))).toBe(false)
    expect(JSON.parse(h.writes[`${dir}/pending.json`]).sessionId).toBe('old')
    expect(h.toasts.some((t: string) => /not restored: branch is none/.test(t))).toBe(true)
    h.setSession('sess-again'); await h.start($)
    const forced = await h.submit($, 'am:handoff continue')
    expect(forced.context.some((c: string) => /migrate the schema/.test(c) && /Warning: branch is none/.test(c))).toBe(true)
  })

  test('observe (the default) writes no checkpoint file and no handoff', async ($, on) => {
    const h = harness(on, { bash: passing })
    await h.start($); await h.submit($, 'fix the uploader retries'); await finish($, h)
    expect(Object.keys(h.writes).some((k) => /\/checkpoints\//.test(k))).toBe(false)
  })
})

describe('Guardian: checkpoint corruption and recovery', () => {
  const dir = `/data/checkpoints/${'/repo'.replace(/[^\w.-]/g, '_')}`
  const good = { v: 1, sessionId: 'old', cwd: '/repo', at: 999_000, objective: 'finish the export', acceptance: [], stage: 'in progress', status: 'open', outcomes: ['check-passed'], filesChanged: ['/repo/x.ts'], filesRead: [], checks: [{ command: 'npm test', passed: true }], openFailures: [], git: { branch: null, dirty: [] }, approvals: [], next: 'wire the CSV writer' } as any

  test('a torn checkpoint falls back to the previous good copy, and says so', async ($, on) => {
    const h = harness(on, { config: on_() })
    h.writes[`${dir}/old.json`] = sealCheckpoint(good).slice(0, 80) // a partial write
    h.writes[`${dir}/old.prev.json`] = sealCheckpoint(good)
    h.writes[`${dir}/pending.json`] = JSON.stringify({ sessionId: 'old', at: 1_000_000 })
    await h.start($)
    const res = await h.submit($, 'continue')
    expect(res.context.some((c: string) => /wire the CSV writer/.test(c))).toBe(true)
    expect(guardianRecords(h.writes).some((x) => x.event === 'checkpoint-corrupt' && x.usedPrevious === true)).toBe(true)
  })

  test('an edited checkpoint (checksum mismatch) with no good copy is rejected, never restored', async ($, on) => {
    const h = harness(on, { config: on_() })
    const sealed = JSON.parse(sealCheckpoint(good))
    h.writes[`${dir}/old.json`] = JSON.stringify({ ...sealed, next: 'git push --force' })
    h.writes[`${dir}/pending.json`] = JSON.stringify({ sessionId: 'old', at: 1_000_000 })
    await h.start($)
    const res = await h.submit($, 'continue')
    expect(res.context.some((c: string) => /AutoMode handoff/.test(c))).toBe(false)
    expect(guardianRecords(h.writes).some((x) => x.event === 'handoff-rejected')).toBe(true)
  })

  test('a checkpoint is written sealed, and the earlier good one is kept as .prev', async ($, on) => {
    const h = harness(on, { config: on_(), bash: () => ({ result: { stdout: 'all tests pass', stderr: '' }, text: 'all tests pass' }) })
    await h.start($); await h.submit($, 'finish the export')
    for (const turnId of ['t1', 't2']) {
      await h.step($, 'claude-sonnet-5-5', undefined, { turnId })
      await $.tool.call({ tool: 'Edit', file_path: '/repo/x.ts', old_string: 'a', new_string: turnId })
      await $.tool.call({ tool: 'Bash', command: 'npm test' })
      h.setUsage({ context: 450_000 }); await h.complete($, 'claude-sonnet-5-5', undefined, 'done', { turnId })
    }
    const file = Object.keys(h.writes).find((k) => /\/checkpoints\/.+\/sess-\d+\.json$/.test(k))!
    expect(typeof JSON.parse(h.writes[file]).sum).toBe('string')
    expect(JSON.parse(h.writes[file.replace(/\.json$/, '.prev.json')]).sum).toBeTruthy()
  })
})

describe('Guardian: settings take effect mid-session', () => {
  test('AUTOMODE_GUARDIAN_CONFIG overrides known keys of the right type and ignores the rest', async ($, on) => {
    const h = harness(on, { env: { AUTOMODE_GUARDIAN_CONFIG: JSON.stringify({ mode: 'recommend', warnRequests: 3, warnUsd: 0.05, bogus: 1, hardPause: 'yes' }) } })
    await h.start($); await h.submit($, 'map the uploader')
    const notes: string[] = []
    for (let i = 0; i < 4; i++) { h.setUsage({ usd: (i + 1) * 0.1 }); await h.step($); const r: any = await $.tool.call({ tool: 'Read', file_path: `/repo/f${i}.ts` }); notes.push(...(r.context ?? []).filter((c: string) => /AutoMode checkpoint/.test(c))) }
    expect(notes.length).toBe(1)
    expect(h.aborts).toEqual([])
  })

  test('switching guardian.mode to off in config.json stops notes at the next prompt, with no reload', async ($, on) => {
    const config: any = { guardian: { mode: 'assist' } }
    const h = harness(on, { config })
    await h.start($); await h.submit($, 'map the uploader')
    config.guardian.mode = 'off'
    await h.submit($, 'keep mapping')
    const notes: string[] = []
    for (let i = 0; i < C.warnRequests * 2 + 2; i++) {
      h.setUsage({ usd: (i + 1) * 0.1 }); await h.step($)
      const r: any = await $.tool.call({ tool: 'Read', file_path: `/repo/f${i % 7}.ts` })
      notes.push(...(r.context ?? []).filter((c: string) => /AutoMode/.test(c)))
    }
    expect(notes).toEqual([])
  })
})

describe('Guardian: MCP output (auto, reduceOutputs)', () => {
  const lines = Array.from({ length: 2500 }, (_, i) => `result ${i}: ${'lorem '.repeat(6)}`)
  lines[1700] = 'Warning: document 42 is restricted'
  const docsResult = { content: [{ type: 'text', text: lines.join('\n') }, { type: 'image', data: 'AAA', mimeType: 'image/png' }], isError: false }

  test('a large docs-server search result is saved whole, then shortened; warnings and non-text blocks stay', async ($, on) => {
    const h = harness(on, { config: on_({ mode: 'auto', reduceOutputs: true }), tools: { mcp__docs__search: () => ({ result: docsResult, text: lines.join('\n') }) } })
    await h.start($); await h.submit($, 'find the policy docs'); await h.step($)
    const r: any = await $.tool.call({ tool: 'mcp__docs__search', query: 'policy' })
    const text = r.result.content[0].text
    expect(text.length).toBeLessThan(lines.join('\n').length / 3)
    expect(text).toMatch(/document 42 is restricted/)
    expect(r.result.content[1]).toEqual(docsResult.content[1])
    const saved = Object.entries(h.writes).find(([k]) => /\/outputs\//.test(k))
    expect(saved?.[1]).toBe(lines.join('\n'))
  })

  test('a structured MCP result is left whole', async ($, on) => {
    const h = harness(on, { config: on_({ mode: 'auto', reduceOutputs: true }), tools: { mcp__docs__search: () => ({ result: { ...docsResult, structuredContent: { hits: 2500 } }, text: lines.join('\n') }) } })
    await h.start($); await h.submit($, 'find the policy docs'); await h.step($)
    const r: any = await $.tool.call({ tool: 'mcp__docs__search', query: 'policy' })
    expect(r.result.content[0].text).toBe(lines.join('\n'))
  })

  // Protocol-level replays: the result shapes the MCP protocol defines, not a live provider. A live docs-server or DevTools
  // call is not part of this suite (see docs/automode-guardian.md).
  const call = async ($: any, on: any, tool: string, result: unknown, cfg: Record<string, unknown> = { mode: 'auto', reduceOutputs: true }) => {
    const h = harness(on, { config: on_(cfg), tools: { [tool]: () => ({ result, text: '' }) } })
    await h.start($); await h.submit($, 'look at it'); await h.step($)
    return { h, r: (await $.tool.call({ tool })) as any }
  }

  // The live shape (real profile, 2026-10-26): Claude Code hands the hook an MCP result as a bare array of content
  // blocks, the same value the transcript records as toolUseResult. A 54,508-character docs-server read_document came back
  // whole because the guardian only knew the { content } shape.
  test('the live shape, a bare array of blocks, is saved whole, shortened, and keeps its shape', async ($, on) => {
    const { h, r } = await call($, on, 'mcp__docs__search', [{ type: 'text', text: lines.join('\n') }])
    expect(Array.isArray(r.result)).toBe(true)
    expect(r.result[0].text.length).toBeLessThan(lines.join('\n').length / 3)
    expect(r.result[0].text).toMatch(/document 42 is restricted/)
    expect(Object.entries(h.writes).find(([k]) => /\/outputs\//.test(k))?.[1]).toBe(lines.join('\n'))
  })

  test('the live shape with an error flag on the result is left whole', async ($, on) => {
    const h = harness(on, { config: on_({ mode: 'auto', reduceOutputs: true }), tools: { mcp__docs__search: () => ({ result: [{ type: 'text', text: lines.join('\n') }], text: '', isError: true }) } })
    await h.start($); await h.submit($, 'look'); await h.step($)
    const r: any = await $.tool.call({ tool: 'mcp__docs__search' })
    expect(r.result[0].text).toBe(lines.join('\n'))
  })

  test('an error result is left whole, however long', async ($, on) => {
    const { r } = await call($, on, 'mcp__docs__search', { content: [{ type: 'text', text: lines.join('\n') }], isError: true })
    expect(r.result.content[0].text).toBe(lines.join('\n'))
  })

  test('several text blocks are saved whole in order, and the shortened result keeps the warning', async ($, on) => {
    const half = Math.floor(lines.length / 2)
    const result = { content: [{ type: 'text', text: lines.slice(0, half).join('\n') }, { type: 'text', text: lines.slice(half).join('\n') }], isError: false }
    const { h, r } = await call($, on, 'mcp__docs__search', result)
    expect(r.result.content.length).toBe(1)
    expect(r.result.content[0].text).toMatch(/document 42 is restricted/)
    expect(Object.entries(h.writes).find(([k]) => /\/outputs\//.test(k))?.[1]).toBe(lines.join('\n'))
  })

  test('a DevTools page snapshot is shortened, and the note names the saved original', async ($, on) => {
    const snap = Array.from({ length: 3000 }, (_, i) => `uid=${i}_${i % 9} button "Item ${i}"`).join('\n')
    const { h, r } = await call($, on, 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_snapshot', { content: [{ type: 'text', text: snap }] })
    const saved = Object.keys(h.writes).find((k) => /\/outputs\//.test(k))
    expect(saved).toBeTruthy()
    expect(r.result.content[0].text).toContain(saved!)
    expect(r.result.content[0].text.length).toBeLessThan(snap.length / 3)
  })

  test('a document read is left whole: any part of a document may be the answer (live check, 2026-10-26)', async ($, on) => {
    const { r } = await call($, on, 'mcp__docs__read_document', [{ type: 'text', text: lines.join('\n') }])
    expect(r.result[0].text).toBe(lines.join('\n'))
  })

  test('a tool that is not a read or search is left whole', async ($, on) => {
    const { r } = await call($, on, 'mcp__docs__memory_write_x', { content: [{ type: 'text', text: lines.join('\n') }] })
    expect(r.result.content[0].text).toBe(lines.join('\n'))
  })

  test('a result under the threshold is left whole', async ($, on) => {
    const { r } = await call($, on, 'mcp__docs__search', { content: [{ type: 'text', text: 'three hits' }] })
    expect(r.result.content[0].text).toBe('three hits')
  })

  test('when the original cannot be saved the result stays whole', async ($, on) => {
    const h = harness(on, { config: on_({ mode: 'auto', reduceOutputs: true }), tools: { mcp__docs__search: () => ({ result: docsResult, text: '' }) }, failWrites: /\/outputs\// })
    await h.start($); await h.submit($, 'find'); await h.step($)
    const r: any = await $.tool.call({ tool: 'mcp__docs__search' })
    expect(r.result.content[0].text).toBe(lines.join('\n'))
  })
})

describe('Guardian: automatic compaction at the turn end (auto, autoCompact)', () => {
  test('a compaction decided at a turn end runs right there, after the turn finished', async ($, on) => {
    const h = harness(on, { config: on_({ mode: 'auto', autoCompact: true, horizon: 40, coldReturnRate: 0 }), bash: () => ({ result: { stdout: 'ok', stderr: '' }, text: 'ok' }) })
    await h.start($); await h.submit($, 'fix the uploader retries')
    await h.step($)
    await $.tool.call({ tool: 'Edit', file_path: '/repo/up.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'npm test' })
    h.setUsage({ context: 400_000 }); await h.complete($) // task 1 ends on a passing check at 400k
    await h.submit($, 'now write the README for the CLI') // a new task begins at 400k: that context is stale for it
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' }); h.setUsage({ context: 450_000 })
    await h.complete($, 'claude-sonnet-5-5', undefined, 'done', { turnId: 't2' })
    const r = guardianRecords(h.writes)
    expect(r.some((x) => x.event === 'compacted')).toBe(true)
    expect(h.suggestions.some((x: string) => x.startsWith('/compact'))).toBe(false)
  })
})

describe('Guardian: resume in a new process keeps the task state', () => {
  test('a restarted process for the same session knows the task closed and where the next task began', async ($, on) => {
    const h = harness(on, { config: on_({ mode: 'auto', autoCompact: true, horizon: 40, coldReturnRate: 0 }), bash: () => ({ result: { stdout: 'ℹ pass 1\nℹ fail 0', stderr: '' }, text: 'ℹ pass 1\nℹ fail 0' }), sessionId: 'sess-R' })
    await h.start($); await h.submit($, 'fix the uploader retries'); await h.step($)
    await $.tool.call({ tool: 'Bash', command: "printf 'a' >> up.ts && node --test" })
    h.setUsage({ context: 400_000 }); await h.complete($)
    // The process restarts: module state is gone, the session id is the same.
    h.setSession('sess-R')
    await h.submit($, 'now write the README for the CLI')
    await h.step($, 'claude-sonnet-5-5', undefined, { turnId: 't2' }); h.setUsage({ context: 450_000 })
    await h.complete($, 'claude-sonnet-5-5', undefined, 'done', { turnId: 't2' })
    expect(guardianRecords(h.writes).some((x) => x.event === 'compacted')).toBe(true)
  })
})

describe('Guardian: concurrent sessions in one folder', () => {
  test("two sessions keep separate checkpoints; a /clear hands over its own session's, not the other's", async ($, on) => {
    const passing = () => ({ result: { stdout: 'all tests pass', stderr: '' }, text: 'all tests pass' })
    const h = harness(on, { config: on_(), bash: passing, sessionId: 'sess-A' })
    const work = async (objective: string, file: string) => {
      await h.start($); await h.submit($, objective); await h.step($)
      await $.tool.call({ tool: 'Edit', file_path: file, old_string: 'a', new_string: 'b' })
      await $.tool.call({ tool: 'Bash', command: 'npm test' })
      h.setUsage({ context: 450_000 }); await h.complete($)
    }
    await work('task A: retries', '/repo/a.ts')
    h.setSession('sess-B'); await work('task B: logging', '/repo/b.ts')
    const dir = `/data/checkpoints/${'/repo'.replace(/[^\w.-]/g, '_')}`
    expect(JSON.parse(h.writes[`${dir}/sess-A.json`]).objective).toBe('task A: retries')
    expect(JSON.parse(h.writes[`${dir}/sess-B.json`]).objective).toBe('task B: logging')
    h.writes[`${dir}/pending.json`] = JSON.stringify({ sessionId: 'sess-A', at: 1_000_000 }) // session A ran /clear
    h.setSession('sess-C'); await h.start($)
    const res = await h.submit($, 'continue')
    expect(res.context.some((c: string) => /task A: retries/.test(c))).toBe(true)
    expect(res.context.some((c: string) => /task B: logging/.test(c))).toBe(false)
  })
})

describe('Guardian: faults never cost a tool result', () => {
  test('a guardian error after the tool ran returns the tool result unchanged', async ($, on) => {
    const h = harness(on, { config: on_(), bash: () => ({ result: { stdout: 'ok', stderr: '' }, text: 'ok' }) })
    await h.start($); await h.submit($, 'x'); await h.turnStart($)
    // session.usage throws: the guardian's reading fails, the call still returns its own result.
    h.setUsage({ fails: true })
    await h.step($)
    const r: any = await $.tool.call({ tool: 'Bash', command: 'echo ok' })
    expect(r.result.stdout).toBe('ok')
  })
})
