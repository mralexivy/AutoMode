// The details as text (/automode details). Routing (what ran, what was asked, why, the candidates, the cache), the workflow (only stages and
// agents that ran), subagents, the guardian, and usage. Every figure is read from the view; a cost is "measured" when a
// priced response stands behind it, and the session total is the engine's own.
import type { View, WorkflowStage } from '../../types/index.d.ts'
import { cacheText, tokensText, usdText } from './view.ts'

const STAGE_GLYPH: Record<WorkflowStage['state'], string> = { done: '●', active: '◉', failed: '✕', required: '◇' }

// detailsText: the same facts as plain lines, for /automode details where nothing draws.
export function detailsText(v: View, now: number): string {
  const r = v.router, g = v.guard
  const lines = [
    `Routing: ${v.routing.label}${v.routing.note ? ` (${v.routing.note})` : ''}`,
    `  running ${v.model.name} · ${v.effort.name}${v.pending ? ` · ${v.pending}` : ''}${v.hold ? ` · ${v.hold}` : ''}${v.escalation ? ` · ${v.escalation}` : ''}`,
    r.requested && r.active ? `  why: ${v.judge.state === 'down' ? `${v.judge.line}; no verdict` : v.judge.line ?? r.requested.reason}` : null,
    `  context ${v.context.percent === null ? '—' : `${Math.round(v.context.percent)}% (${tokensText(v.context.tokens)})`} · cache ${v.cache.state === 'unknown' ? '—' : cacheText(v.cache.until, now)}`,
    v.workflow.length ? `Workflow: ${v.workflow.map((s) => `${STAGE_GLYPH[s.state]} ${s.name}`).join(' ─ ')}` : null,
    `Guardian: ${g.enabled ? `${v.guardian.glyph} ${v.guardian.state} (mode ${g.mode})` : 'off'}${g.checkpoint ? ` · checkpoint ${g.checkpoint.sum}` : ''}`,
    `Usage: ${usdText(v.cost.session)} this session${r.ledger.requests ? ` · judges ${usdText(r.ledger.judgeUsd)} · subagents ${usdText(r.ledger.subagentUsd)} (measured)` : ''}`,
  ]
  return lines.filter(Boolean).join('\n')
}
