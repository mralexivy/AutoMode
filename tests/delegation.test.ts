// Delegated reads end to end in the mocked engine: the gate stops once, shadow changes nothing, and extract keeps only
// evidence that matches the file. The rules themselves are in tests/delegation.test.mts.
import { describe, expect, test } from 'claude-code/testing'
import { harness, records } from './harness.ts'

const BIG = '/repo/big.py'
const text = `def retry(self, n):\n${'    x = 1\n'.repeat(4000)}`
const on_ = (delegation: string, o: Record<string, unknown> = {}) => ({ policy: 'auto', config: { delegation }, ...o })
const seed = (h: any) => { h.writes[BIG] = text }
const read = ($: any, o = {}) => $.tool.call({ tool: 'Read', file_path: BIG, ...o })
const events = (w: Record<string, string>) => records(w).filter((x) => x.kind === 'delegation').map((x) => x.action)
const start = async ($: any, h: any) => { seed(h); await h.submit($, 'add a counter to the retry loop'); await h.step($) }

describe('Delegated reads', () => {
  test('on: a large full read stops once with an outline, and the second read runs', async ($, on) => {
    const h = harness(on, on_('on'))
    await start($, h)
    const first = await read($)
    expect(first.deny).toContain('1: def retry')
    expect(first.deny).toContain('mcp__automode__extract')
    expect(h.toolsRun.filter((t) => t === 'Read').length).toBe(0)
    expect((await read($)).deny).toBeUndefined()
    expect(h.toolsRun.filter((t) => t === 'Read').length).toBe(1)
    await h.step($)
    expect(events(h.writes)).toEqual(['gate', 'read-again'])
  })

  test('on: a ranged read and a small file pass', async ($, on) => {
    const h = harness(on, on_('on'))
    await start($, h)
    expect((await read($, { offset: 1, limit: 20 })).deny).toBeUndefined()
    h.writes['/repo/small.py'] = 'x = 1'
    expect((await $.tool.call({ tool: 'Read', file_path: '/repo/small.py' })).deny).toBeUndefined()
  })

  test('on: a file edited in this task reads whole', async ($, on) => {
    const h = harness(on, on_('on'))
    await start($, h)
    await $.tool.call({ tool: 'Edit', file_path: BIG, old_string: 'a', new_string: 'b' })
    expect((await read($)).deny).toBeUndefined()
  })

  test('shadow records the gate and never stops a read', async ($, on) => {
    const h = harness(on, on_('shadow'))
    await start($, h)
    expect((await read($)).deny).toBeUndefined()
    await h.step($)
    expect(events(h.writes)).toEqual(['gate'])
  })

  test('off does nothing', async ($, on) => {
    const h = harness(on, on_('off'))
    await start($, h)
    expect((await read($)).deny).toBeUndefined()
    await h.step($)
    expect(events(h.writes)).toEqual([])
  })

  test('the tool is registered only when delegation is on', async ($, on) => {
    const h = harness(on, on_('on'))
    await h.start($)
    expect(h.registered).toContain('extract')
  })

  test('shadow registers no tool, so requests stay the same', async ($, on) => {
    const h = harness(on, on_('shadow'))
    await h.start($)
    expect(h.registered).not.toContain('extract')
  })

  const ask = ($: any, paths = [BIG]) => $.tool.call({ tool: 'mcp__automode__extract', paths, question: 'where is retry?' })
  const reply = JSON.stringify({ findings: [
    { claim: 'retry is here', path: BIG, lines: [1, 1], quote: 'def retry(self, n):' },
    { claim: 'invented', path: BIG, lines: [1, 1], quote: 'def invented(self):' },
  ], omitted: ['callers'] })

  test('extract returns verified findings and says what it dropped', async ($, on) => {
    const h = harness(on, on_('on', { extract: reply }))
    await start($, h)
    const out = await ask($)
    expect(out.result).toContain('retry is here')
    expect(out.result).not.toContain('invented')
    expect(out.result).toContain('1 did not match')
    expect(out.result).toContain('Not covered: callers')
    await h.step($)
    const row = records(h.writes).find((x) => x.action === 'extract')
    expect([row.kept, row.dropped, row.ok]).toEqual([1, 1, true])
  })

  test('extract refuses a file the permission check does not allow', async ($, on) => {
    const h = harness(on, on_('on', { extract: reply }))
    await start($, h)
    h.writes['/repo/secret.env'] = 'KEY=1'
    const out = await ask($, ['/repo/secret.env'])
    expect(out.isError).toBe(true)
    expect(String(out.result)).toContain('may not read')
  })

  test('a failed worker points back to a ranged read', async ($, on) => {
    const h = harness(on, on_('on', { extract: null }))
    await start($, h)
    const out = await ask($)
    expect(out.isError).toBe(true)
    expect(String(out.result)).toContain('offset and limit')
  })

  test('extract is refused when delegation is off', async ($, on) => {
    const h = harness(on, on_('off'))
    await start($, h)
    expect((await ask($)).isError).toBe(true)
  })
})
