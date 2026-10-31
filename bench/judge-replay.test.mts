// The offline replay composes the shipped routing steps. These cases pin the behavior a bench report depends on.
import assert from 'node:assert/strict'
import test from 'node:test'
import { automodeRoute, upstreamRoute, type LabeledCase, type PanelRow, type Slots } from './lib/judge-replay.mts'

const slots = (rows: Partial<PanelRow>[]): Slots => new Map(rows.map((r) => [r.slot!, { pass: 1, id: 'x', parsed: true, ...r } as PanelRow]))
const job: LabeledCase = { id: 'x', kind: 'normal', current: { model: 'sonnet', effort: 'medium' }, message: 'build the importer', ok: ['medium'] }
const hm = (tier: string, complexity = 'standard', extra: Partial<PanelRow> = {}) => ({ slot: 'automode', tier, complexity, risk: 'none', consequence: 'none', confidence: 0.8, effort: 'medium', ...extra }) as Partial<PanelRow>

test('replay: no parsed answer is no upstream route, but the pipeline falls back', () => {
  const s = slots([{ slot: 'plain:sonnet', parsed: false }, { slot: 'closing:sonnet', parsed: false }, hm('T1')])
  assert.equal(upstreamRoute(job, s).effort, null)
  const r = automodeRoute(job, s, { input: 'closing' })
  assert.equal(r.source, 'fallback')
  assert.ok(r.effort)
})

test('replay: plain-then-closing uses the closing verdict only when the plain one failed', () => {
  const s = slots([{ slot: 'plain:sonnet', model: 'sonnet', effort: 'high' }, { slot: 'closing:sonnet', model: 'sonnet', effort: 'low' }, hm('T1')])
  assert.equal(automodeRoute(job, s, { input: 'plain-then-closing' }).effort, 'high')
  s.set('plain:sonnet', { ...s.get('plain:sonnet')!, parsed: false })
  assert.equal(automodeRoute(job, s, { input: 'plain-then-closing' }).effort, 'low')
})

test('replay: haiku needs both judges', () => {
  const s = slots([{ slot: 'closing:sonnet', model: 'haiku', effort: 'low' }, { slot: 'closing:haiku', model: 'haiku', effort: 'low' }, hm('T1')])
  assert.equal(automodeRoute(job, s, { input: 'closing' }).family, 'sonnet')
  const t = slots([{ slot: 'closing:sonnet', model: 'haiku', effort: 'low' }, { slot: 'closing:haiku', model: 'haiku', effort: 'low' }, hm('T0', 'trivial')])
  assert.equal(automodeRoute(job, t, { input: 'closing' }).family, 'haiku')
})

test('replay: a critical change lifts sonnet to high', () => {
  const c = { ...job, message: 'add a payment refund endpoint' }
  const s = slots([{ slot: 'closing:sonnet', model: 'sonnet', effort: 'medium' }, hm('T2')])
  assert.equal(automodeRoute(c, s, { input: 'closing' }).effort, 'high')
})
