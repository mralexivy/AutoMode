// The presentation layer. It draws the bar and answers /automode (the text is in commands.ts). The only thing it changes
// is the per-session routing switch, from the bar's toggle or /automode on|off. Every drawing reads the view atom (publish.ts), never a file or a model, and falls back to the
// engine's own on any error, so a surface that cannot draw, or a drawing that fails, never touches routing or the
// guardian. AUTOMODE_UI=off turns the layer off alone.
import { atom, read } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import { uiOptions } from '../lib/settings.ts'
import { currentOptions, storedOptions } from '../options.ts'
import { appearanceOf, tokensFor } from './tokens.ts'
import { barSegments, barText, cacheText, type Metric } from './view.ts'
import { loadFacts, publish, snapshotView, uiDisabled } from './publish.ts'
import { drawAlert, drawBar, drawTip, type Ctx } from './bar.tsx'
import { detailsText } from './details.tsx'
import * as cmd from './commands.ts'
import { toggleRouting } from './switch.ts'
import type { View } from '../../types/index.d.ts'

type On = Parameters<Register>[0]

// The view publish.ts writes. The engine lists each file's state reads, so the reference is declared where it is read.
const viewAtom = atom({ plugin: 'automode', key: 'view' } as const, null as View | null)

let configTheme: string | null | undefined // the person's /config theme row, for the AutoMode palettes' appearance
let tickDue = 0
let lastUiError: string | null = null

async function themeOf($: EngineInterface): Promise<string | null> {
  if (configTheme !== undefined) return configTheme
  try { configTheme = String((await $.config.list()).find((r: any) => r.key === 'theme')?.value ?? '') || null } catch { configTheme = null }
  return configTheme
}

export async function uiSessionStart($: EngineInterface) {
  try {
    configTheme = undefined
    if (await uiDisabled($)) return
    await $.command.register({ name: 'automode', description: `AutoMode: ${cmd.usageLine()}` })
    await loadFacts($)
    await publish($)
  } catch {}
}

// The engine facts the report subcommands print. Each read is best effort: a missing file is a blank, never an error.
async function cmdFacts($: EngineInterface): Promise<cmd.Facts> {
  const safe = async <T,>(p: Promise<T> | T, fallback: T): Promise<T> => { try { return await p } catch { return fallback } }
  const json = async (file: string) => { try { return JSON.parse(await $.fs.read(file)) } catch { return {} } }
  const str = (v: unknown) => (v ? String(v) : null)
  const root = String($.plugin.root)
  const manifest = await json(`${root}/.claude-plugin/plugin.json`)
  return {
    version: String(manifest.version ?? 'unknown'), root, home: str(await safe($.env.get('HOME'), null)), config: await json(`${root}/config.json`),
    env: {
      AUTOMODE_ROUTER: str(await safe($.env.get('AUTOMODE_ROUTER'), null)), AUTOMODE_UI: str(await safe($.env.get('AUTOMODE_UI'), null)),
      AUTOMODE_GUARDIAN: str(await safe($.env.get('AUTOMODE_GUARDIAN'), null)), AUTOMODE_SIGNALS: str(await safe($.env.get('AUTOMODE_SIGNALS'), null)),
    },
  }
}

// One redraw at the next moment the picture changes by itself: the cache minute, or a tip running out.
function scheduleTick($: EngineInterface, now: number, v: View) {
  const due: number[] = []
  // The view can be older than this draw: a cache time already past would give a negative step and a redraw every 16 ms.
  if (v.cache.state === 'warm' && v.cache.until !== null && v.cache.until > now) due.push(now + ((v.cache.until - now) % 60_000 || 60_000) + 20)
  if (v.tip && v.tip.until > now) due.push(v.tip.until + 20)
  if (!due.length) return
  const soonest = Math.min(...due)
  if (tickDue > now && tickDue <= soonest) return
  tickDue = soonest
  try { $.clock.after(Math.max(16, soonest - now), () => { tickDue = 0; $.ui.invalidate('ui.render') }) } catch {}
}

export function registerUi(on: On) {
  // Unique parameter names, and the event always passes on: the directory reads both as proof that this hook decides nothing.
  on('config.set', ($, setting, proceed) => {
    try { if (setting.key === 'theme') { configTheme = String(setting.value); $.ui.invalidate('ui.render') } } catch {}
    return proceed(setting)
  })

  on('command.run', { command: 'automode' }, async ($, e) => {
    try {
      const v = await snapshotView($)
      if (!v) return { text: 'AutoMode is starting.' }
      const now = Date.now()
      const { sub } = cmd.parse(e.args)
      const name = cmd.resolve(sub)
      if (!name) return { text: cmd.unknownText(sub) }
      const head = barText(barSegments(v, 200, now))
      switch (name) {
        case 'help': return { text: cmd.helpText() }
        case 'details': return { text: `${head}\n${detailsText(v, now)}` }
        case 'setup': return { text: cmd.setupText(v, await cmdFacts($)) }
        case 'settings': return { text: cmd.settingsText(v, await cmdFacts($)) }
        case 'debug': return { text: cmd.debugText(v, await cmdFacts($), now) }
        case 'on':
        case 'off': {
          const wantOn = name === 'on'
          if (wantOn !== (v.router.mode === 'off')) return { text: `Routing is already ${wantOn ? 'on' : 'off'} for this session.` }
          return { text: await toggleRouting($) }
        }
        default: return { text: `${head}${v.alert ? `\n${v.alert.title}. ${v.alert.line}` : ''}${lastUiError ? `\nUI: the last drawing fell back to Claude Code's own (${lastUiError})` : ''}` }
      }
    } catch (err) {
      return { text: `AutoMode: ${String((err as Error)?.message ?? err).slice(0, 160)}` }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if (e.props.hasSurvey || (await uiDisabled($))) return next(e)
      const v = await read($, viewAtom)
      if (!v) { try { $.clock.after(20, () => { void publish($) }) } catch {}; return next(e) }
      const o = uiOptions(currentOptions(), storedOptions())
      let now = Date.now()
      try { now = await $.clock.now() } catch {}
      const c: Ctx = {
        els: $.ui.resolve(e), t: tokensFor(appearanceOf(o.appearance, await themeOf($)), o.theme), now, surface: String(e.surface), term: e.surface === 'terminal',
        cols: Number(e.props?.bodyColumns ?? e.viewport?.columns ?? 80) || 80,
      }
      const { Box } = c.els
      scheduleTick($, now, v)
      return <Box key="hm-col" flexDirection="column">{v.alert ? drawAlert(c, v.alert) : drawTip(c, v)}{drawBar($, c, v, o.metrics as Metric[], o.layout === 'minimal')}</Box>
    } catch (err) {
      lastUiError = `band: ${String((err as Error)?.message ?? err).replace(/\s+/g, ' ').slice(0, 200)}`
      return next(e)
    }
  })
}

export { cacheText }
