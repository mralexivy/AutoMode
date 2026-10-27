#!/usr/bin/env node
// Outcome evidence per model and effort from local transcripts. $0, read-only, no prompt text kept.
//
//   node bench/quality-evidence.mjs [--root DIR]... [--out PREFIX]
//
// Per person prompt, from the route its first request was sent on:
//   checks    test, build, lint or type-check commands run (failures.ts isCheck)
//   failed    checks that failed (error result, nonzero exit, or failure markers)
//   repaired  a failed check followed by an edit and then a passing check in the same prompt
//   unresolved the prompt's last check failed
//   corrected the person's next prompt reads as a correction or a retry (records.ts nextSignal)
// Stratified by prompt size (main requests), since bigger tasks fail more on any model.
//
// What this is NOT: a success rate per configuration. Routes were chosen by a person or by Claude Code
// defaults, and hard tasks went to Opus more often, so differences between rows mix task difficulty with
// model capability. Outcomes a route never ran are unknown, not zero and not success. The optimizer's
// capability bands stay assumptions; this report is used only to check them for gross contradictions.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listTranscripts } from './lib/transcripts.mjs'
import { familyOf } from '../hooks/lib/prices.ts'
import { isCheck } from '../hooks/lib/failures.ts'
import { nextSignal } from '../hooks/lib/records.ts'

const here = path.dirname(new URL(import.meta.url).pathname)
const args = process.argv.slice(2)
const roots = []
let out = path.join(here, 'results', `quality-evidence-${new Date().toISOString().slice(0, 10)}`)
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') roots.push(args[++i].replace(/^~/, os.homedir()))
  else if (args[i] === '--out') out = args[++i]
}
if (!roots.length) roots.push(path.join(os.homedir(), '.claude', 'projects'), path.join(os.homedir(), '.claude-ectest', 'projects'))

const FAIL_TEXT = /Exit code [1-9]|^--- FAIL|^FAIL\b|\b\d+ (failed|failing)\b|error TS\d+|AssertionError/m
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text ?? '').join('\n') : '')
const promptText = (r) => {
  if (r.type !== 'user' || r.isSidechain || r.isMeta || r.isCompactSummary) return null
  const c = r.message?.content
  if (typeof c === 'string') return c.startsWith('<command-') || c.startsWith('<local-command') || !c.trim() ? null : c
  if (!Array.isArray(c) || c.some((b) => b?.type === 'tool_result')) return null
  const t = c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
  return t.trim() && !t.startsWith('<command-') ? t : null
}

export function promptsOf(lines) {
  const prompts = []
  let cur = null
  const pending = new Map() // tool_use id -> { kind, command }
  const seen = new Set()
  for (const r of lines) {
    const t = promptText(r)
    if (t !== null) { cur = { text: t, route: null, requests: 0, events: [] }; prompts.push(cur); continue }
    if (!cur || r.isSidechain) continue
    if (r.type === 'assistant' && r.message) {
      if (r.requestId && !seen.has(r.requestId)) {
        seen.add(r.requestId)
        cur.requests += 1
        if (!cur.route) cur.route = `${familyOf(r.message.model ?? '') ?? 'other'}/${r.effort ?? 'unknown'}`
      }
      for (const b of r.message.content ?? []) {
        if (b?.type !== 'tool_use') continue
        if (b.name === 'Bash' && isCheck(String(b.input?.command ?? ''))) pending.set(b.id, { kind: 'check' })
        if (['Edit', 'Write', 'MultiEdit'].includes(b.name)) cur.events.push('edit')
      }
    }
    if (r.type === 'user' && Array.isArray(r.message?.content)) {
      for (const b of r.message.content) {
        if (b?.type !== 'tool_result' || !pending.has(b.tool_use_id)) continue
        pending.delete(b.tool_use_id)
        const failed = b.is_error === true || FAIL_TEXT.test(textOf(b.content))
        cur.events.push(failed ? 'fail' : 'pass')
      }
    }
  }
  return prompts
}

export function summarize(prompts) {
  const rows = {}
  const size = (n) => (n <= 5 ? 'small (1-5 requests)' : n <= 19 ? 'medium (6-19)' : 'large (20+)')
  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i]
    if (!p.route || !p.requests) continue
    const ev = p.events
    const checks = ev.filter((e) => e !== 'edit').length
    const failed = ev.filter((e) => e === 'fail').length
    let repaired = 0
    for (let k = 0; k < ev.length; k++) if (ev[k] === 'fail') { const rest = ev.slice(k + 1); const e = rest.indexOf('edit'); if (e >= 0 && rest.slice(e + 1).includes('pass')) repaired += 1 }
    const lastCheck = [...ev].reverse().find((e) => e !== 'edit')
    const next = prompts[i + 1]?.text
    const signal = next ? nextSignal(next) : null
    const key = `${p.route} | ${size(p.requests)}`
    const c = (rows[key] ??= { prompts: 0, withChecks: 0, checks: 0, failed: 0, repaired: 0, unresolved: 0, corrected: 0, followed: 0 })
    c.prompts += 1
    if (checks) c.withChecks += 1
    c.checks += checks; c.failed += failed; c.repaired += repaired
    if (lastCheck === 'fail') c.unresolved += 1
    if (signal) { c.followed += 1; if (signal !== 'moved-on') c.corrected += 1 }
  }
  const rate = (a, b) => (b ? Math.round((1000 * a) / b) / 1000 : null)
  return Object.fromEntries(Object.entries(rows).sort().map(([k, c]) => [k, { ...c, failRate: rate(c.failed, c.checks), unresolvedRate: rate(c.unresolved, c.withChecks), correctionRate: rate(c.corrected, c.followed) }]))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const all = []
  for (const f of listTranscripts(roots)) {
    const lines = []
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (!l) continue; try { lines.push(JSON.parse(l)) } catch {} }
    all.push(...promptsOf(lines))
  }
  const rows = summarize(all)
  const report = {
    generatedAt: new Date().toISOString(), cost: '$0', prompts: all.length,
    caveat: 'Observational. Routes were not assigned at random; hard tasks went to stronger models. Counterfactual outcomes are unknown. Not a success rate per configuration.',
    rows,
  }
  fs.writeFileSync(`${out}.json`, JSON.stringify(report, null, 2) + '\n')
  const md = ['| route (first request) | size | prompts | with checks | check fail rate | unresolved | correction rate (n) |', '|---|---|---:|---:|---:|---:|---:|',
    ...Object.entries(rows).map(([k, c]) => { const [route, sz] = k.split(' | '); return `| ${route} | ${sz} | ${c.prompts} | ${c.withChecks} | ${c.failRate ?? '-'} | ${c.unresolvedRate ?? '-'} | ${c.correctionRate ?? '-'} (${c.followed}) |` })]
  fs.writeFileSync(`${out}.md`, `# Outcome evidence, ${report.generatedAt.slice(0, 10)}\n\n${report.caveat}\n\n${md.join('\n')}\n`)
  console.log(md.join('\n'))
}
