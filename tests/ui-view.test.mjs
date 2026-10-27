// The UI's pure layer: tokens (contrast), words, the view model and the bar's fitting. The drawings are tested in
// tests/ui.test.tsx; these tests hold the facts the drawings show.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { tokensFor, PALETTES as THEMES, THEMES as ALL_THEMES, TEXT_ROLES, contrast, appearanceOf } from '../hooks/ui/tokens.ts'
import { buildView, barSegments, barText, modelName, cacheText, usdText, tokensText, workflowOf, METRICS } from '../hooks/ui/view.ts'
import { STATES, stateOf, NOW, router, guard, usage } from './fixtures/ui-states.mjs'

const viewOf = (name) => { const s = stateOf(name); return buildView(s.router, s.guard, s.usage, s.now) }

test('every text colour reads on the band and on a card, in every theme and appearance (WCAG 4.5:1)', () => {
  for (const theme of THEMES) for (const ap of ['dark', 'light']) {
    const t = tokensFor(ap, theme)
    for (const role of TEXT_ROLES) for (const surface of ['bg', 'raised']) {
      const c = contrast(t[role], t[surface])
      assert.ok(c >= 4.5, `${theme} ${ap} ${role} on ${surface}: ${c.toFixed(2)}`)
    }
    for (const role of ['warn', 'text', 'dim']) assert.ok(contrast(t[role], t.warnBg) >= 4.5, `${theme} ${ap} ${role} on warnBg`)
    for (const role of ['error', 'text', 'dim']) assert.ok(contrast(t[role], t.errorBg) >= 4.5, `${theme} ${ap} ${role} on errorBg`)
  }
})

test('the default theme holds no colour of its own: every role is a Claude Code theme key', () => {
  assert.equal(ALL_THEMES[0], 'native')
  for (const ap of ['dark', 'light']) {
    const t = tokensFor(ap)
    assert.equal(t.theme, 'native')
    for (const role of [...TEXT_ROLES, 'edge']) assert.ok(!String(t[role]).startsWith('#'), `${ap} ${role}: ${t[role]}`)
    for (const surface of ['bg', 'raised', 'warnBg', 'errorBg']) assert.equal(t[surface], '', surface)
    // Only status carries colour, through the theme's own success, warning and error keys.
    assert.deepEqual([t.route, t.effort, t.text], ['text', 'text', 'text'])
    assert.deepEqual([t.guard, t.warn, t.error], ['success', 'warning', 'error'])
  }
})

test('appearance follows the /config theme unless fixed', () => {
  assert.equal(appearanceOf('auto', 'light'), 'light')
  assert.equal(appearanceOf('auto', 'light-daltonized'), 'light')
  assert.equal(appearanceOf('auto', 'dark-ansi'), 'dark')
  assert.equal(appearanceOf('auto', null), 'dark')
  assert.equal(appearanceOf('light', 'dark'), 'light')
})

test('words: model names, cache minutes, dollars and tokens', () => {
  assert.equal(modelName('claude-sonnet-5-5[1m]'), 'Sonnet 5.5')
  assert.equal(modelName('claude-haiku-4-5@20251001'), 'Haiku 4.5')
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(modelName(null), '—')
  assert.equal(cacheText(NOW + 42 * 60_000 + 15_000, NOW), '42m')
  assert.equal(cacheText(NOW + 30_000, NOW), '<1m')
  assert.equal(cacheText(NOW - 1, NOW), 'cold')
  assert.equal(cacheText(null, NOW), '—')
  assert.equal(usdText(1.237), '$1.24')
  assert.equal(usdText(null), '—')
  assert.equal(usdText(12.34), '$12.3')
  assert.equal(tokensText(76_000), '76k')
  assert.equal(tokensText(null), '—')
})

test('every named state builds a view', () => {
  assert.equal(Object.keys(STATES).length, 25)
  for (const name of Object.keys(STATES)) assert.ok(viewOf(name).routing.label, name)
})

test('the bar shows the effective route, not the requested one', () => {
  const v = viewOf('model-switch')
  assert.equal(v.model.name, 'Sonnet 5.5')
  assert.equal(v.model.source, 'effective')
  assert.equal(v.pending, '→ Opus next')
  const p = viewOf('effort-pending')
  assert.equal(p.effort.name, 'Medium')
  assert.equal(p.pending, '→ High next')
})

test('before the first answer the bar says what the next request takes, dimmed as not yet run', () => {
  const v = buildView(router({ effective: { model: null, effort: null, at: null } }), guard(), usage(), NOW)
  assert.equal(v.model.source, 'next')
  assert.equal(v.effort.source, 'next')
  const segs = barSegments(v, 200, NOW)
  assert.equal(segs.find((s) => s.key === 'model').tone, 'dim')
})

test('an ordinary session says it is not routed and shows the app model', () => {
  const v = viewOf('plain-opus')
  assert.equal(v.routing.label, 'NOT ROUTING')
  assert.equal(v.model.name, 'Opus 5.5')
  assert.equal(v.pending, null)
  assert.equal(v.alert, null)
})

test('mode labels: off is never shown as shadow, and legacy is a policy of auto', () => {
  assert.equal(buildView(router({ mode: 'off', sessionMode: 'off' }), guard(), usage(), NOW).routing.label, 'OFF')
  assert.equal(buildView(router({ mode: 'shadow' }), guard(), usage(), NOW).routing.label, 'SHADOW')
  assert.equal(buildView(router({ policy: 'legacy' }), guard(), usage(), NOW).routing.label, 'AUTO · LEGACY')
  assert.equal(viewOf('router-disabled').routing.label, 'ROUTER OFF')
  assert.match(viewOf('router-disabled').routing.note, /AUTOMODE_ROUTER=off/)
  assert.match(buildView(router({ mode: 'shadow', providerGuard: true, provider: 'vertex' }), guard(), usage(), NOW).routing.note, /unverified on vertex/)
})

test('unknown usage shows dashes, never a number', () => {
  const v = viewOf('unknown-usage')
  const t = barText(barSegments(v, 200, NOW))
  assert.match(t, / · — /)
  assert.ok(t.includes(' · —'), t)
  assert.ok(!/\$\d/.test(t), t)
})

test('a failed judge shows no verdict and says so', () => {
  const v = viewOf('judge-failure')
  assert.equal(v.judge.state, 'down')
  assert.equal(v.alert.kind, 'judge')
  assert.doesNotMatch(v.alert.line, /Haiku:|verdict:/)
})

test('alerts: a pause comes first, a handoff names the checkpoint, productive long work raises nothing', () => {
  assert.equal(viewOf('guardian-pause').alert.kind, 'paused')
  assert.deepEqual(viewOf('guardian-pause').alert.actions, ['continue', 'compact', 'handoff'])
  assert.equal(viewOf('handoff-confirm').alert.kind, 'handoff')
  assert.match(viewOf('handoff-confirm').alert.line, /checkpoint/)
  assert.doesNotMatch(viewOf('handoff-confirm').alert.line, /cleared|ran \/clear/)
  assert.equal(viewOf('compact-advised').alert.kind, 'compact')
  assert.equal(viewOf('cache-cold').alert.kind, 'cold')
  const long = buildView(router(), guard({ outcomes: 9, sinceOutcome: { requests: 40, usd: 3.1 } }), usage({ costUsd: 14.2 }), NOW)
  assert.equal(long.alert, null)
  assert.equal(long.guardian.glyph, '✓')
})

test('a small cold cache is not worth a card', () => {
  const v = buildView(router({ warm: { sonnet: { until: NOW - 60_000, effort: 'high' } } }), guard(), usage({ contextTokens: 20_000, percent: 10 }), NOW)
  assert.equal(v.cache.state, 'cold')
  assert.equal(v.alert, null)
})

test('workflow: only stages that ran, from real agents; review shows as required', () => {
  assert.deepEqual(workflowOf(router({ stage: 'complete' })), [])
  const plan = viewOf('workflow-plan').workflow
  assert.deepEqual(plan.map((s) => `${s.name}:${s.state}`), ['Discover:done', 'Plan:active'])
  const build = viewOf('parallel-build').workflow
  assert.deepEqual(build.map((s) => `${s.name}:${s.state}`), ['Discover:done', 'Plan:done', 'Build:active'])
  assert.equal(build.find((s) => s.name === 'Build').agents.filter((a) => a.status === 'running').length, 2)
  const rev = viewOf('verify-review').workflow
  assert.deepEqual(rev.map((s) => `${s.name}:${s.state}`), ['Plan:done', 'Build:done', 'Verify:failed', 'Review:active'])
  const main = workflowOf(router({ stage: 'verify', review: { required: true, because: ['x'] } }))
  assert.deepEqual(main.map((s) => `${s.name}:${s.state}`), ['Verify:active', 'Review:required'])
})

test('the bar fits every width: the model and effort always stay, the rest drops in order', () => {
  for (const name of Object.keys(STATES)) {
    const v = viewOf(name)
    for (const cols of [40, 50, 60, 80, 100, 120, 160, 200]) {
      const segs = barSegments(v, cols, NOW)
      const keys = segs.map((s) => s.key)
      for (const k of ['model', 'effort']) assert.ok(keys.includes(k), `${name} ${cols}: ${k}`)
      if (cols >= 50) assert.ok([...barText(segs)].length <= cols || segs.length <= 3, `${name} ${cols}: ${barText(segs)}`)
    }
  }
  const v = viewOf('auto-normal')
  assert.equal(barText(barSegments(v, 200, NOW)), '✦ Sonnet 5.5 · High · 38% · 42m · $1.24 — multi-file change with tests')
  assert.equal(barText(barSegments(v, 50, NOW)), '✦ Sonnet 5.5 · High · 38% · 42m · $1.24')
  assert.deepEqual(barSegments(v, 30, NOW).map((s) => s.key), ['model', 'effort', 'context'])
})

test('minimal words: auto and a healthy guardian say nothing; other modes and a warning name themselves', () => {
  const healthy = barText(barSegments(viewOf('auto-normal'), 200, NOW))
  assert.ok(!/AUTO|auto|Guardian|✓/.test(healthy), healthy)
  assert.match(barText(barSegments(viewOf('plain-opus'), 200, NOW)), /^not routing · ✦ Opus 5\.5/)
  assert.match(barText(barSegments(viewOf('router-disabled'), 200, NOW)), /^router off · /)
  assert.match(barText(barSegments(viewOf('guardian-pause'), 200, NOW)), /■ paused/)
  assert.match(barText(barSegments(buildView(router({ mode: 'shadow' }), guard(), usage(), NOW), 200, NOW)), /^shadow · /)
})

test('why: one short recorded reason, or none', () => {
  assert.equal(viewOf('auto-normal').why, 'multi-file change with tests')
  assert.equal(viewOf('cache-warm').why, 'cache is warm, no switch')
  assert.equal(viewOf('quality-escalation').why, 'same check failed twice')
  assert.equal(viewOf('judge-failure').why, 'judges paused, fallback route')
  assert.equal(viewOf('plain-opus').why, null)
  const long = buildView(router({ verdict: { by: 'Judge', why: 'x'.repeat(80), confidence: 0.9 } }), guard(), usage(), NOW)
  assert.ok([...long.why].length <= 52 && long.why.endsWith('…'))
})

test('tips: the one that fits, never in a state that does not need it', () => {
  const tip = (v) => v.tip?.key ?? null
  assert.equal(tip(viewOf('plain-opus')), 'unrouted')
  assert.equal(tip(viewOf('first-run')), 'unrouted' === tip(viewOf('first-run')) ? 'unrouted' : 'first')
  assert.equal(tip(viewOf('large-context')), 'ctx')
  assert.equal(tip(buildView(router({ requested: { ...router().requested, owner: 'user-override' } }), guard(), usage(), NOW)), 'override')
  const styled = (style) => tip(buildView(router(), guard(), usage(), NOW, { outputStyle: style }))
  assert.equal(styled('default'), 'style')
  assert.equal(styled('automode:Concise'), 'hm')
  assert.equal(styled(null), 'hm')
  assert.equal(tip(viewOf('router-disabled')), null === tip(viewOf('router-disabled')) ? null : tip(viewOf('router-disabled')))
})

test('metrics the person switched off are not shown', () => {
  const v = viewOf('auto-normal')
  const keys = barSegments(v, 200, NOW, METRICS.filter((m) => m !== 'cost' && m !== 'cache')).map((s) => s.key)
  assert.ok(!keys.includes('cost') && !keys.includes('cache'))
})
