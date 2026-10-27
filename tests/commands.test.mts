// @ts-nocheck TODO(types): 1 errors with strict off. Fix them and delete this line to turn checking on for this file.
// The text of the /automode subcommands (hooks/ui/commands.ts): pure functions of the view model.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SUBCOMMANDS, parse, resolve, helpText, setupText, settingsText, debugText, unknownText, usageLine } from '../hooks/ui/commands.ts'
import { buildView } from '../hooks/ui/view.ts'
import { STATES, stateOf, router, guard, usage, NOW } from './fixtures/ui-states.mts'

const facts = (over = {}) => ({
  version: '0.1.0', root: '/Users/sam/.claude/plugins/cache/automode', home: '/Users/sam',
  config: { pickerModel: 'claude-sonnet-5-5[1m]', reviewPolicy: 'risk', defaultPath: 'direct', maxConcurrency: 1 },
  env: { AUTOMODE_ROUTER: null, AUTOMODE_UI: null, AUTOMODE_GUARDIAN: null }, ...over,
})
const viewWith = (r = {}, g = {}) => buildView(router(r), guard(g), usage(), NOW)

test('parse splits the subcommand from the rest, and lowercases the subcommand only', () => {
  assert.deepEqual(parse('  Debug  '), { sub: 'debug', rest: '' })
  assert.deepEqual(parse('details Verbose Now'), { sub: 'details', rest: 'Verbose Now' })
  assert.deepEqual(parse(undefined), { sub: '', rest: '' })
})

test('resolve maps aliases to one name and rejects unknown words', () => {
  assert.equal(resolve(''), 'status')
  assert.equal(resolve('stats'), 'details')
  assert.equal(resolve('tips'), 'help')
  assert.equal(resolve('commands'), 'help')
  assert.equal(resolve('nonsense'), null)
  assert.equal(new Set(SUBCOMMANDS.map((c) => c.name)).size, SUBCOMMANDS.length)
})

test('help lists every subcommand and the am: prompt commands', () => {
  const t = helpText()
  for (const c of SUBCOMMANDS) assert.ok(t.includes(c.line), c.name)
  for (const w of ['am:direct', 'am:continue', 'am:handoff', '/automode:usage', '/output-style automode:Concise']) assert.ok(t.includes(w), w)
  assert.ok(usageLine().startsWith('/automode ['))
  assert.ok(unknownText('zzz').includes('Unknown subcommand "zzz"'))
})

test('setup says AutoMode starts with every session in the default activation', () => {
  const t = setupText(viewWith({ active: true, activation: 'always', sessionModel: 'claude-opus-5-5' }), facts())
  assert.match(t, /✓ AutoMode starts with every session \(activation: always\)\./)
  assert.match(t, /Nothing to do\./)
  assert.doesNotMatch(t, /idle/)
})

test('setup says AutoMode is idle off the picker model, and names both ways to start it, in picker activation', () => {
  const t = setupText(viewWith({ active: false, activation: 'picker', sessionModel: 'claude-opus-5-5' }), facts())
  assert.match(t, /✗ This session runs on claude-opus-5-5, so AutoMode is idle \(activation: picker\)\./)
  assert.ok(t.includes('"activation": "always"'))
  assert.ok(t.includes("claude --model 'claude-sonnet-5-5[1m]'"))
})

test('setup reports a ready session, a killed router and a session switched off', () => {
  assert.match(setupText(viewWith({ active: true, mode: 'auto' }), facts()), /Nothing to do\./)
  assert.match(setupText(viewWith({ active: true, killed: true }), facts()), /AUTOMODE_ROUTER=off is set/)
  const off = setupText(viewWith({ active: true, mode: 'off', sessionMode: 'off' }), facts())
  assert.match(off, /Routing is off for this session/)
  assert.match(off, /Next step: \/automode on/)
})

test('settings shows the values in force and how to change each one', () => {
  const t = settingsText(viewWith({ mode: 'auto' }), facts())
  for (const k of ['routing mode', 'policy', 'activation', 'picker model', 'review policy', 'guardian', 'hard pause']) assert.ok(t.includes(k), k)
  assert.ok(t.includes('config.json: reviewPolicy'))
  assert.ok(t.includes('config.json: activation (always or picker)'))
  assert.ok(settingsText(viewWith({ mode: 'off', sessionMode: 'off' }), facts()).includes('/automode on|off (this session)'))
})

test('debug is a paste-ready report with the home folder masked and no prompt text', () => {
  const t = debugText(viewWith({ active: true }), facts({ env: { AUTOMODE_ROUTER: 'auto', AUTOMODE_UI: null, AUTOMODE_GUARDIAN: null } }), NOW)
  assert.ok(t.includes('version          0.1.0'))
  assert.ok(t.includes('(activation always)'))
  assert.ok(t.includes('~/.claude/plugins/cache/automode'))
  assert.ok(!t.includes('/Users/sam'))
  assert.ok(t.includes('AUTOMODE_ROUTER=auto'))
  for (const k of ['session model', 'mode ', 'policy', 'route requested', 'guardian', 'cache']) assert.ok(t.includes(k), k)
})

test('every named state of the bar produces all four reports without throwing', () => {
  for (const name of Object.keys(STATES)) {
    const s = stateOf(name)
    const v = buildView(s.router, s.guard, s.usage, s.now)
    for (const fn of [() => setupText(v, facts()), () => settingsText(v, facts()), () => debugText(v, facts(), s.now)]) assert.ok(fn().length > 20, name)
  }
})

test('help aligns every command, so no label runs into its text', () => {
  const lines = helpText().split('\n').filter((l) => l.startsWith('  /automode'))
  assert.ok(lines.length >= 9)
  for (const l of lines) assert.match(l, /^\s+\/automode(:usage)?( [a-z]+)?( \[[^\]]*\])?\s{2,}\S/, l)
})

test('settings keeps a space between every label and its value', () => {
  const rows = settingsText(viewWith({ mode: 'auto' }), facts()).split('\n').filter((l) => /^ {2}\S/.test(l))
  assert.ok(rows.length >= 10)
  for (const r of rows) assert.match(r, /^ {2}[a-z][a-z ,]*[a-z] {2,}\S/i, r)
})

test('debug says idle for the stage when the session is not on the AutoMode model', () => {
  assert.match(debugText(viewWith({ active: false }), facts(), NOW), /stage\s+idle/)
  assert.doesNotMatch(debugText(viewWith({ active: true }), facts(), NOW), /stage\s+idle/)
})
