// The learning pass, wired: when it runs and what it touches. It owns the model call (through v4Reflect) and the rulebook file; the
// decisions are in lib/reflect.ts. It runs in the background while the person is away, on request, never during a turn, and a failure of
// any step leaves the session as it was.
import type { EngineInterface } from 'claude-code'
import { v4Config, v4Learned, v4NoteCache, v4Reflect, v4Rulebook, v4SetRulebook } from './v4.ts'
import { MAX_PROPOSALS, WEEK_CAP_USD, due, runPass, weekSpend, type PassResult } from './lib/reflect.ts'

export interface Extra { pingUsd: number; savedUsd: number; chal: 'champion' | 'challenger' }
let running = false

async function pass($: EngineInterface, now: number, extra: Extra): Promise<PassResult | null> {
  if (running) return null
  running = true
  try {
    const { learned } = v4Learned()
    const cfg = v4Config()
    const res = await runPass({ l: learned, rb: v4Rulebook(), now, extra, model: cfg.reflectModel !== false, complete: (system, digest) => v4Reflect($, system, digest) })
    await v4SetRulebook($, res.rb)
    v4NoteCache({ kind: 'learning-pass', at: now, usd: Math.round(res.usd * 1e5) / 1e5, usedModel: res.used, kept: res.rb.runs[res.rb.runs.length - 1]?.kept ?? 0, skipped: res.skipped })
    return res
  } catch { return null } finally { running = false }
}

// learnPassTick runs from the cache keeper's timer: a pass starts only when the person has been idle long enough and there is something new.
export async function learnPassTick($: EngineInterface, o: { now: number; idleMs: number; busy: boolean; extra: Extra }) {
  try {
    const cfg = v4Config()
    const d = due({ mode: cfg.reflect ?? 'auto', now: o.now, idleMs: o.idleMs, idleMinMs: (cfg.reflectIdleMin ?? 20) * 60_000, busy: o.busy, rb: v4Rulebook(), l: v4Learned().learned, manual: false })
    if (d.run) await pass($, o.now, o.extra)
  } catch {}
}

// learnCommand serves `/automode learn [status]`: with no argument it runs a pass now.
export async function learnCommand($: EngineInterface, rest: string, o: { now: number; extra: Extra }): Promise<string> {
  const cfg = v4Config()
  const status = () => {
    const rb = v4Rulebook()
    return `Learning pass: ${cfg.reflect ?? 'auto'}${cfg.reflectModel === false ? ', local only' : ''}. ${rb.runs.length} passes so far, $${weekSpend(rb, o.now).toFixed(3)} spent this week of a $${WEEK_CAP_USD.toFixed(2)} cap. The model's proposals: ${rb.score.proposed} kept, ${rb.score.confirmed} confirmed by your tasks, ${rb.score.refuted} refuted.`
  }
  if (rest.trim().toLowerCase() === 'status') { const rb = v4Rulebook(); return `${status()}${rb.insights.length ? `\nLast insight: ${rb.insights[rb.insights.length - 1].text}` : ''}` }
  const res = await pass($, o.now, o.extra)
  if (!res) return 'A learning pass is already running, or could not run.'
  return `${res.insight}\n${res.used ? `Asked Haiku, $${res.usd.toFixed(4)}; kept up to ${MAX_PROPOSALS} proposals as the next things to test.` : `Local pass only${res.skipped ? ` (${res.skipped})` : ''}.`}\n${status()}`
}
