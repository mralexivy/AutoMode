// The status bar above the prompt: text only, in the person's theme. It reports; it has no buttons and changes nothing.
// One row for the route (mode, effective model and effort, pending change, context, cache, cost, guardian, stage), and
// above it one line when something needs attention (the guardian, a judge or model that stopped answering, a cold cache).
// view.ts decides what is shown and fits it to the width; this file only draws it.
import type { Alert, View } from '../../types/index.d.ts'
import type { Tokens } from './tokens.ts'
import type { EngineInterface } from 'claude-code'
import { barSegments, type Metric, type Segment } from './view.ts'
import { toggleRouting } from './switch.ts'

export interface Ctx { els: any; t: Tokens; now: number; surface: string; term: boolean; cols: number }

const GLYPH: Record<Alert['kind'], string> = { paused: '■', judge: '●', handoff: '▲', compact: '▲', warning: '▲', cold: '❄', limit: '▲', restored: '✓' }

export function drawAlert(c: Ctx, a: Alert) {
  const { Text } = c.els
  const tone = a.tone === 'error' ? c.t.error : a.tone === 'guard' ? c.t.guard : a.tone === 'cyan' ? c.t.dim : c.t.warn
  // Advice, never an action: the plugin or you run the command; the bar only says what it sees.
  return (
    <Text key={`alert-${a.kind}`} color={tone} wrap="wrap">{`${GLYPH[a.kind]} ${a.title}. ${a.line}`}</Text>
  )
}

// A hint for this state, dim, above the bar; it goes by itself after its time (the view carries `until`).
export function drawTip(c: Ctx, v: View) {
  const { Text } = c.els
  if (!v.tip || c.now >= v.tip.until) return null
  return <Text key="hm-tip" color={c.t.dim} wrap="wrap">{`Tip: ${v.tip.text}`}</Text>
}

// The on/off toggle for routing in this session: one Button, `● on` / `○ off`, at the right end of the bar. It is a Button
// because nothing else takes a press (an Svg cannot, and a hidden Button laid over a drawing is not laid over it in VS
// Code), so the host draws it in its own button style. Shown only where it can mean something: the session is on the
// AutoMode row and the router is not killed. Elsewhere there is no toggle, because a mod cannot change the model.
export function drawSwitch($: EngineInterface, c: Ctx, v: View) {
  const { Button } = c.els
  const r = v.router
  if (!r.enabled || r.killed || !r.active) return null
  const routing = r.mode !== 'off'
  // On is the host's filled button, off its outlined ghost (dimColor): the usual active and idle look, in the person's theme.
  return <Button key="hm-switch" plain dimColor={!routing} hotkey={c.term ? 'm' : undefined} label={routing ? '● on' : '○ off'} onPress={() => toggleRouting($)} />
}

export function drawBar($: EngineInterface, c: Ctx, v: View, metrics: Metric[], minimal: boolean) {
  const { Box, Text } = c.els
  const t = c.t
  // The terminal reports its real width; VS Code reports a fixed 50 columns at any width, so there every item is offered and
  // the one-row wrap below drops whole items from the end when the window is narrow.
  const segs = barSegments(v, c.term ? Math.max(24, c.cols - 4) : 999, c.now, minimal ? ['context', 'guardian'] : metrics)
  const tone = (s: Segment) => (s.key === 'model' ? (s.tone === 'dim' ? t.dim : t.text) : s.key === 'effort' ? (s.tone === 'dim' ? t.dim : t.text) : t[s.tone])
  const item = (s: Segment, i: number) => (
    <Box key={`item-${s.key}`} flexShrink={0} flexDirection="row">
      {i ? <Text color={t.dim}>{s.sep ?? ' · '}</Text> : null}
      <Text color={tone(s)} bold={!!s.bold} wrap="truncate">{s.text}</Text>
    </Box>
  )
  return (
    // VS Code and desktop already frame the band; a second border inside it would double the line. Only the terminal,
    // which draws no frame of its own, gets one.
    <Box key="hm-bar" flexDirection="row" overflow="hidden" {...(c.term ? { paddingX: 1, borderStyle: 'round', borderColor: t.edge } : { flexWrap: 'wrap', height: 1 })}>
      {segs.map(item)}
      <Box flexGrow={1} />
      {drawSwitch($, c, v)}
    </Box>
  )
}
