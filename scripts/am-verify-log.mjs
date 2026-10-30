#!/usr/bin/env node
// Turns the AutoMode hook debug log into the G1 live-test results. Read-only.
//
// Usage: node am-verify-log.mjs [--since <ISO time>] [--json] [log files...]
//   default logs: every state/hook-debug.log under ~/.claude/plugins/data/*/ and ~/.claude/state/efficientcode/.
//
// Tests (owner conditions for the claude-sonnet-5-5[1m] workaround):
//   T1  the suffixed ID survives SessionStart, model switching, and resume
//   T2  ordinary Sonnet never activates
//   T4  the suffix is not normalized away before the hook gets it
//   T5  Sonnet -> AutoMode activates, and AutoMode -> Sonnet deactivates
// T3 (cache, tokens, context, billing) comes from transcripts: run am-usage.mjs on the test sessions.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const PICKER = process.env.HM_PICKER_MODEL || 'claude-sonnet-5-5[1m]'
const PLAIN = new Set(['sonnet', 'claude-sonnet-5-5'])

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const sinceIdx = argv.indexOf('--since')
const since = sinceIdx >= 0 ? Date.parse(argv[sinceIdx + 1]) : 0
let files = argv.filter((a, i) => !a.startsWith('--') && (sinceIdx < 0 || i !== sinceIdx + 1))
if (!files.length) {
  const dataDir = path.join(CONFIG_DIR, 'plugins', 'data')
  try { for (const d of fs.readdirSync(dataDir)) files.push(path.join(dataDir, d, 'state', 'hook-debug.log')) } catch {}
  files.push(path.join(CONFIG_DIR, 'state', 'efficientcode', 'hook-debug.log'))
}

const events = []
for (const f of files) {
  let text
  try { text = fs.readFileSync(f, 'utf8') } catch { continue }
  for (const line of text.split('\n')) {
    try {
      const e = JSON.parse(line)
      if (e.ev && e.sid && Date.parse(e.at) >= since) events.push({ ...e, file: f })
    } catch {}
  }
}
events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

const bySession = new Map()
for (const e of events) {
  if (!bySession.has(e.sid)) bySession.set(e.sid, [])
  bySession.get(e.sid).push(e)
}

const requested = (e) => (e.ev === 'PostModelSwitch' ? e.requested_model ?? e.to_model : e.ev === 'SessionStart' ? e.model : undefined)
const results = { T1: [], T2: [], T4: [], T5: [] }
const fail = (t, sid, msg) => results[t].push({ ok: false, sid, msg })
const pass = (t, sid, msg) => results[t].push({ ok: true, sid, msg })

for (const [sid, evs] of bySession) {
  let lastActive = null
  for (let i = 0; i < evs.length; i++) {
    const e = evs[i]
    const m = requested(e)

    // T4: a switch or start that names the AutoMode row must carry the exact suffixed string.
    if (typeof m === 'string' && m.startsWith('claude-sonnet-5-5') && m !== 'claude-sonnet-5-5') {
      if (m === PICKER) pass('T4', sid, `${e.ev} received "${m}" verbatim`)
      else fail('T4', sid, `${e.ev} received "${m}", expected "${PICKER}"`)
    }
    if (e.ev === 'PostModelSwitch' && e.to_model && String(e.requested_model ?? '').includes('[1m]') && !String(e.to_model).includes('[1m]')) {
      fail('T4', sid, `to_model "${e.to_model}" lost the suffix (requested "${e.requested_model}")`)
    }

    // T2: plain Sonnet never activates.
    if (PLAIN.has(m) && e.active === true) fail('T2', sid, `${e.ev} with "${m}" activated AutoMode`)
    if (PLAIN.has(m) && e.active === false) pass('T2', sid, `${e.ev} with "${m}" stayed plain`)

    // T1: the identity survives start, switch, and resume.
    if (m === PICKER && e.active === true) pass('T1', sid, `${e.ev}${e.source ? `(${e.source})` : ''} activated from "${m}"`)
    if (m === PICKER && e.active === false) fail('T1', sid, `${e.ev} saw "${m}" but did not activate`)
    // Lines from older hook versions have no `active` field and are skipped.
    // A resume of a session whose earlier events fall before --since has no known prior state: skip it.
    if (e.ev === 'SessionStart' && e.source === 'resume' && typeof e.active === 'boolean' && !(e.kept && lastActive === null)) {
      const ok = e.kept ? e.active === lastActive : e.active === (e.model === PICKER)
      ;(ok ? pass : fail)('T1', sid, `resume: kept=${Boolean(e.kept)} active=${e.active}, before=${lastActive}`)
    }

    // T5: transitions in both directions inside one session.
    if (e.ev === 'PostModelSwitch' && lastActive !== null && typeof e.active === 'boolean') {
      if (lastActive === false && m === PICKER) (e.active ? pass : fail)('T5', sid, `plain -> AutoMode: active=${e.active}`)
      if (lastActive === true && PLAIN.has(m)) (e.active === false ? pass : fail)('T5', sid, `AutoMode -> "${m}": active=${e.active}`)
    }
    // The prompt that follows must agree with the state.
    if (e.ev === 'UserPromptSubmit' && lastActive !== null && e.active !== lastActive) {
      fail('T5', sid, `prompt saw active=${e.active} after state ${lastActive}`)
    }
    if (typeof e.active === 'boolean' && e.ev !== 'UserPromptSubmit') lastActive = e.active
  }
}

const summary = Object.fromEntries(Object.entries(results).map(([t, rs]) => [t, {
  verdict: rs.length === 0 ? 'NO DATA' : rs.every((r) => r.ok) ? 'PASS' : 'FAIL',
  passed: rs.filter((r) => r.ok).length,
  failed: rs.filter((r) => !r.ok).length,
  details: rs,
}]))

if (asJson) { console.log(JSON.stringify({ picker: PICKER, sessions: bySession.size, events: events.length, summary }, null, 2)); process.exit(0) }

console.log(`AutoMode live checks. Picker ID "${PICKER}". ${events.length} events in ${bySession.size} sessions.\n`)
for (const [t, s] of Object.entries(summary)) {
  console.log(`${t}: ${s.verdict} (${s.passed} pass, ${s.failed} fail)`)
  for (const r of s.details.filter((d) => !d.ok)) console.log(`   FAIL ${r.sid.slice(0, 8)}  ${r.msg}`)
}
console.log('\nT3 (cache, tokens, context, billing): run am-usage.mjs <session> --json on the test sessions.')
