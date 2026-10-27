// The status UI in the kit: every named state on terminal, desktop and VS Code. The UI only reports, so these tests check
// what it says, that it has no controls and no hard-coded colour in the default theme, and that it cannot hurt anything
// else. The view is built with the same pure buildView the plugin's publish uses and answered to the plugin's own read of
// `automode.view` (a test's hooks sit beneath the plugin).
import { test, describe, expect, mock } from 'claude-code/testing'
import { buildView } from '../hooks/ui/view.ts'
import { stateOf, STATES, NOW } from './fixtures/ui-states.mts'

const SURFACES = ['terminal', 'desktop', 'vscode'] as const
const BAND = (surface: string, cols = 100, extra: Record<string, unknown> = {}) => ({
  plugin: 'automode', surface, component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 14, bodyColumns: cols, scroll: { offset: 0, bodyRows: 14 }, view: {}, ...extra },
}) as never

function seed(on: any, name: string, view?: unknown) {
  const s = stateOf(name)
  const v = view ?? buildView(s.router as any, s.guard as any, s.usage as any, s.now)
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.id', () => ({ value: `ui-${name}` }))
  on('session.model', () => ({ value: s.router.sessionModel }))
  on('state.get', (_$: any, e: any, next: any) => e.plugin === 'automode' && e.key === 'view' ? { value: { value: v, version: 1 } } : next(e))
  return { s, view: v as any }
}
const text = async (ui: any) => JSON.stringify(await ui.drawn())
const words = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((x: any) => x.text).join('')

describe('every state on every surface', () => {
  for (const name of Object.keys(STATES)) {
    test(`${name} draws a bar with no hex colour, no art and at most the routing toggle`, { options: { layout: name === 'minimal' ? 'minimal' : 'expanded' } } as never, async ($, on) => {
      const { view } = seed(on, name)
      for (const surface of SURFACES) for (const cols of [50, 100]) {
        const ui = await $.ui.mount(BAND(surface, cols))
        const t = await text(ui)
        expect(t).toContain('hm-bar')
        // The only control is the routing toggle, and only on a AutoMode session with the router enabled.
        const buttons = (t.match(/"type":"Button"/g) ?? []).length
        expect(buttons).toBe(view.router.enabled && !view.router.killed && view.router.active ? 1 : 0)
        expect(t).not.toContain('"type":"Svg"')
        // One border only: the host frames the band on desktop and VS Code, so the bar draws none there.
        if (surface !== 'terminal') expect(t).not.toContain('"borderStyle"')
        expect(t).not.toMatch(/"(color|backgroundColor|borderColor)":"#/)
        expect(t).toContain(view.model.name)
        await ui.unmount()
      }
    })
  }
})

describe('what the bar says', () => {
  test('auto: the effective route, context, cache, cost and guardian, in that order', async ($, on) => {
    seed(on, 'auto-normal')
    const ui = await $.ui.mount(BAND('terminal', 120))
    expect(await words(ui)).toContain('✦ Sonnet 5.5 · High · 38% · 42m · $1.24 — multi-file change with tests')
    await ui.unmount()
  })
  test('a plain Opus session says it is not routed', async ($, on) => {
    seed(on, 'plain-opus')
    const ui = await $.ui.mount(BAND('desktop', 120))
    const t = await text(ui)
    expect(t).toContain('not routing')
    expect(t).toContain('Opus 5.5')
    await ui.unmount()
  })
  test('the toggle reads on or off and a press leaves the bar drawing', async ($, on) => {
    seed(on, 'auto-normal')
    const ui = await $.ui.mount(BAND('vscode', 100))
    expect((await ui.find({ key: 'hm-switch' }))?.text).toContain('on')
    await ui.press({ key: 'hm-switch' })
    await ui.redraw()
    expect(await text(ui)).toContain('hm-bar')
    await ui.unmount()
  })
  test('no toggle when the session is not on AutoMode: a mod cannot change the model', async ($, on) => {
    seed(on, 'plain-opus')
    const ui = await $.ui.mount(BAND('vscode', 100))
    expect(await ui.find({ key: 'hm-switch' })).toBeUndefined()
    await ui.unmount()
  })
  test('a pending model shows beside the one that ran', async ($, on) => {
    seed(on, 'model-switch')
    const ui = await $.ui.mount(BAND('vscode', 120))
    const t = await text(ui)
    expect(t).toContain('Sonnet 5.5')
    expect(t).toContain('→ Opus next')
    await ui.unmount()
  })
  test('a failed judge is a line of text and shows no verdict', async ($, on) => {
    seed(on, 'judge-failure')
    const ui = await $.ui.mount(BAND('desktop'))
    const t = await text(ui)
    expect(t).toContain('Judges not answering')
    expect(t).not.toContain('Haiku:')
    await ui.unmount()
  })
  test('a guardian pause is advice in text, with no action offered', async ($, on) => {
    seed(on, 'guardian-pause')
    const ui = await $.ui.mount(BAND('terminal'))
    const t = await text(ui)
    expect(t).toContain('Guardian paused the turn')
    await ui.unmount()
  })
  test('the router kill switch is named', async ($, on) => {
    seed(on, 'router-disabled')
    const ui = await $.ui.mount(BAND('terminal'))
    expect(await text(ui)).toContain('router off')
    await ui.unmount()
  })
  test('unknown usage shows dashes', async ($, on) => {
    seed(on, 'unknown-usage')
    const ui = await $.ui.mount(BAND('terminal', 120))
    const t = await words(ui)
    expect(t).toContain('· — · ')
    expect(t).not.toContain('$1.24')
    await ui.unmount()
  })
})

describe('hints', () => {
  test('a tip shows while its time runs, above the bar, as dim text', async ($, on) => {
    const s = stateOf('first-run')
    const v: any = buildView(s.router as any, s.guard as any, s.usage as any, s.now)
    seed(on, 'first-run', { ...v, tip: { ...v.tip, until: NOW + 60_000 } })
    const ui = await $.ui.mount(BAND('vscode', 100))
    expect(await words(ui)).toContain('Tip: ')
    await ui.unmount()
  })
  test('an expired tip is gone', async ($, on) => {
    const s = stateOf('first-run')
    const v: any = buildView(s.router as any, s.guard as any, s.usage as any, s.now)
    seed(on, 'first-run', { ...v, tip: { ...v.tip, until: NOW - 1 } })
    const ui = await $.ui.mount(BAND('vscode', 100))
    expect(await words(ui)).not.toContain('Tip:')
    await ui.unmount()
  })
  test('/automode help lists the commands that exist', async ($, on) => {
    seed(on, 'auto-normal')
    const r: any = await $.command.run({ command: 'automode', args: 'help' })
    for (const w of ['am:direct', 'am:continue', 'am:handoff', '/output-style automode:Concise', '/effort', 'AUTOMODE_UI=off']) expect(String(r?.text)).toContain(w)
  })
})

describe('the AutoMode palettes (opt-in)', () => {
  test('colours only: hex text colours, no art, still no controls', { options: { theme: 'automode' } } as never, async ($, on) => {
    seed(on, 'auto-normal')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(BAND(surface, 100))
      const t = await text(ui)
      expect(t).toMatch(/"color":"#/)
      expect(t).not.toContain('"type":"Svg"')
      await ui.unmount()
    }
  })
})

describe('status only, and isolated', () => {
  test('/automode prints the status as text and changes nothing', async ($, on) => {
    seed(on, 'auto-normal')
    for (const ev of ['prompt.submit', 'prompt.fill', 'prompt.suggest', 'command.run', 'config.set']) void ev
    const r: any = await $.command.run({ command: 'automode', args: 'details' })
    expect(String(r?.text ?? '')).toContain('Guardian:')
  })
  test('a drawing that fails goes to the engine; routing is untouched', async ($, on) => {
    seed(on, 'auto-normal', { routing: null })
    on('ui.render', (_$: any, e: any) => { const { Text } = (_$ as any).ui.resolve(e); return <Text>engine</Text> })
    const band = await $.ui.mount(BAND('terminal'))
    expect(await text(band)).toContain('engine')
    await band.unmount()
  })
  test('AUTOMODE_UI=off draws nothing of AutoMode', async ($, on) => {
    seed(on, 'auto-normal')
    mock.env(on, { AUTOMODE_UI: 'off' })
    on('ui.render', (_$: any, e: any) => { const { Text } = (_$ as any).ui.resolve(e); return <Text>engine</Text> })
    const band = await $.ui.mount(BAND('desktop'))
    expect(await text(band)).not.toContain('hm-bar')
    await band.unmount()
  })
  test('a draw reads no file, writes nothing and calls no model or prompt', async ($, on) => {
    seed(on, 'parallel-build')
    const io: string[] = []
    for (const ev of ['fs.read', 'fs.write', 'fs.list', 'model.complete', 'process.run', 'prompt.submit', 'prompt.fill', 'command.run']) on(ev, () => { io.push(ev); throw new Error(`${ev} during a draw`) })
    const times: number[] = []
    for (const surface of SURFACES) {
      const band = await $.ui.mount(BAND(surface))
      for (let i = 0; i < 10; i++) { const t0 = Date.now(); await band.redraw(); times.push(Date.now() - t0) }
      await band.unmount()
    }
    expect(io).toEqual([])
    times.sort((a, b) => a - b)
    console.log(`automode band redraw in the kit: p50 ${times[Math.floor(times.length / 2)]} ms, p95 ${times[Math.floor(times.length * 0.95)]} ms`)
    expect(times[Math.floor(times.length * 0.95)]).toBeLessThan(50)
  })
})
