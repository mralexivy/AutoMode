#!/usr/bin/env node
// @ts-nocheck TODO(types): 6 errors with strict off. Fix them and delete this line to turn checking on for this file.
// Does an effort-only change keep the prompt cache on this machine? $0: reads local transcripts only, no inference.
//
//   node bench/effort-cache-check.mts [--roots DIR,DIR] [--days N]
//
// Claude Code writes an `api-request` line per request with the parameters it sent (model, output_config.effort,
// betas) and the assistant line carries the usage. For two consecutive main-thread requests on the same model, within
// the cache lifetime, with a different sent effort, the later request's cache read says whether the prefix survived:
// a read of at least 80% of the earlier prompt means the cache was kept. Results are split by whether the request
// carried a per-message effort beta (mid-conversation-output-config, or per-turn-control as Claude Code names it). Observational: the two requests also differ
// in other ways, and a miss can have another cause (compaction, a TTL that ended). It proves a hit, not a cause.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { listTranscripts, loadSession } from './lib/transcripts.mts'

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const roots = opt('--roots', path.join(os.homedir(), '.claude', 'projects')).split(',')
const days = Number(opt('--days', 30))
const HOUR = 3_600_000
const KEEP = 0.8
const prompt = (t) => t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h

const cut = Date.now() - days * 24 * HOUR
const rows = { beta: { kept: 0, missed: 0 }, noBeta: { kept: 0, missed: 0 }, unknown: { kept: 0, missed: 0 } }
const byPair = {}
let sessions = 0, changes = 0, requests = 0
for (const file of listTranscripts(roots)) {
  if (fs.statSync(file).mtimeMs < cut) continue
  let s
  try { s = loadSession(file) } catch { continue }
  sessions += 1
  const reqs = s.prompts.flatMap((p) => p.requests).filter((r) => r.tokens && !r.incomplete)
  requests += reqs.length
  for (let i = 1; i < reqs.length; i++) {
    const a = reqs[i - 1], b = reqs[i]
    if (a.model !== b.model || a.sentEffort == null || b.sentEffort == null || a.sentEffort === b.sentEffort) continue
    if (b.at - a.at > HOUR) continue
    changes += 1
    const kept = b.tokens.cacheRead >= KEEP * prompt(a.tokens)
    const bucket = b.perMessageEffortBeta === true ? 'beta' : b.perMessageEffortBeta === false ? 'noBeta' : 'unknown'
    rows[bucket][kept ? 'kept' : 'missed'] += 1
    const k = `${String(b.model).replace(/^claude-/, '')} ${a.sentEffort}->${b.sentEffort}`
    byPair[k] ??= { kept: 0, missed: 0 }
    byPair[k][kept ? 'kept' : 'missed'] += 1
  }
}
const pct = (k, n) => (n ? `${Math.round((1000 * k) / n) / 10}%` : '-')
console.log(`Effort-only changes, last ${days} days: ${changes} in ${requests} main requests, ${sessions} sessions. A change counts as kept when the later request read at least ${KEEP * 100}% of the earlier prompt from cache.\n`)
console.log('per-message effort beta | kept | missed | kept share')
for (const [k, v] of Object.entries(rows)) console.log(`${k} | ${v.kept} | ${v.missed} | ${pct(v.kept, v.kept + v.missed)}`)
console.log('\nby model and change (most common):')
for (const [k, v] of Object.entries(byPair).sort((a, b) => b[1].kept + b[1].missed - a[1].kept - a[1].missed).slice(0, 12)) console.log(`${k} | kept ${v.kept} | missed ${v.missed}`)
console.log('\nObservational. Other causes of a miss (compaction, an expired cache, a changed tool set) are not separated out.')
