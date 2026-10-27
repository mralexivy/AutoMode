#!/usr/bin/env node
// @ts-nocheck TODO(types): 12 errors with strict off. Fix them and delete this line to turn checking on for this file.
// Live verification of the session and cost guardian in the real Claude Code runtime. Default: a DRY RUN that prints
// every check, its calls and the cap, and spends nothing.
//
//   node bench/guardian-live.mts                              # dry run
//   node bench/guardian-live.mts --run --approve-usd 0.6      # runs, never past the approved total (ledger-checked)
//   node bench/guardian-live.mts --only L1,L4 --run --approve-usd 0.2
//   node bench/guardian-live.mts --evaluate-vscode [--workspace DIR] # $0: grade the VS Code guardian suite's sessions
//
// Isolation: CLAUDE_CONFIG_DIR=~/.claude-ectest (the test profile; ~/.claude is never touched), a throwaway git workspace
// per check, and a --plugin-dir copy of this repo. The guardian's settings come from AUTOMODE_GUARDIAN_CONFIG,
// so config.json stays as shipped. Model: Claude Haiku 5.5 (the cheapest; the guardian is model-independent) with
// everySession, so the router stays inactive and only the guardian is under test. Each check passes or fails on the
// guardian's own records, the transcript, and the files on disk, never on the model's prose.
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensure as ledgerEnsure, add as ledgerAdd } from './lib/ledger.mts'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const PROFILE = path.join(os.homedir(), '.claude-ectest')
const CLAUDE = path.join(os.homedir(), '.local', 'bin', 'claude')
const DATA = path.join(PROFILE, 'plugins', 'data', 'automode')
const MODEL = 'claude-haiku-5-5'
const argv = process.argv.slice(2)
const val = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined)
const run = argv.includes('--run')
const approved = Number(val('--approve-usd') ?? 0)
const only = val('--only')?.split(',')
const BATCH = val('--batch') ?? `guardian-${new Date().toISOString().slice(0, 10)}`
// The hard cap per call (claude --max-budget-usd) and the estimate per call: the observed mean of the first live run was
// $0.0099 per Haiku call (13 calls, $0.129); the estimate uses $0.015.
const PER_CALL_CAP = Number(val('--per-call-cap') ?? 0.15)
const PER_CALL_ESTIMATE = 0.015

const base = { mode: 'auto', everySession: true }
// Each check: the guardian settings, the calls (each a prompt; `resume` continues the previous call's session), and
// what must be true afterwards. `calls` is also the cost basis: about $0.01-0.03 per Haiku call with Claude Code's own
// system prompt (~20k tokens, cached).
export const CHECKS = [
  { id: 'L1', what: 'hooks fire in the runtime; cost and context are read live; a turn record is written',
    cfg: { ...base }, calls: [{ prompt: 'Run `node --test` once in Bash and report pass or fail in one word.' }] },
  { id: 'L2', what: 'a warning note reaches the model mid-turn (tool-result context), once',
    cfg: { ...base, mode: 'recommend', warnRequests: 2, warnUsd: 0.0001, pauseFactor: 100 },
    calls: [{ prompt: 'Run `ls` in Bash three separate times, one call each, then say done.' }] },
  { id: 'L3', what: 'auto + hardPause ends a no-progress turn between requests ($.turn.abort), never after a write',
    cfg: { ...base, hardPause: true, warnRequests: 1, warnUsd: 0.00001, pauseFactor: 2 },
    calls: [{ prompt: 'Run these one at a time, one Bash call each, and do not stop early: echo 1, echo 2, echo 3, echo 4, echo 5, echo 6, echo 7, echo 8.' }] },
  { id: 'L4', what: 'auto + reduceOutputs shortens a large Bash output after saving it whole; the answer still uses the tail',
    cfg: { ...base, reduceOutputs: true },
    // 4,000 lines (~19k characters): above the guardian's 12k threshold, below Claude Code's own 30k spill to file.
    calls: [{ prompt: 'Run exactly this Bash command, unchanged, with no pipe and no other command: seq 1 4000. Then tell me only the last number it printed.' }] },
  { id: 'L5', what: 'a sealed, owner-only checkpoint at a finished task; /clear marks it; the next session gets a verified handoff',
    cfg: { ...base, mode: 'assist', minContextTokens: 1 },
    calls: [{ prompt: 'Append the line "hello" to notes.txt, then run `node --test` once, and report the result in one word.' }, { prompt: '/clear', resume: true }, { prompt: 'continue', fresh: true }] },
  { id: 'L6', what: 'auto + autoCompact in a headless session: the compaction is decided at the turn end, the runtime refuses $.session.compact headless, and the guardian records it and carries on (interactive compaction: VS Code GV8)',
    cfg: { ...base, autoCompact: true, minContextTokens: 1, horizon: 1000, coldReturnRate: 0, margin: 0, compactStaleShare: 0.2 },
    calls: [{ prompt: 'Read big.txt in full with the Read tool, then append "a" to notes.txt and run `node --test` once. One word answer.' }, { prompt: 'Now, separately: list the files here in one line.', resume: true }, { prompt: 'Say ok.', resume: true }] },
  { id: 'L7', what: 'the kill switch: AUTOMODE_GUARDIAN=off leaves no guardian records and no notes',
    cfg: { ...base, mode: 'recommend', warnRequests: 1, warnUsd: 0.00001 }, env: { AUTOMODE_GUARDIAN: 'off' },
    calls: [{ prompt: 'Run `ls` in Bash twice, one call each, then say done.' }] },
  { id: 'L8', what: 'two concurrent sessions in one folder keep separate checkpoints',
    cfg: { ...base, mode: 'assist', minContextTokens: 1 }, concurrent: true,
    calls: [{ prompt: 'Append "x" to notes.txt and run `node --test` once. One word.' }, { prompt: 'Append "y" to other.txt and run `node --test` once. One word.' }] },
]

function workspace(id) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `am-guardian-${id}-`))
  fs.writeFileSync(path.join(dir, 'ok.test.mjs'), "import { test } from 'node:test'\ntest('ok', () => {})\n")
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'start\n')
  fs.writeFileSync(path.join(dir, 'big.txt'), Array.from({ length: 1000 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog near the riverbank`).join('\n'))
  execFileSync('git', ['init', '-q', dir]); execFileSync('git', ['-C', dir, 'add', '.']); execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
  return dir
}
function pluginCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-guardian-plugin-'))
  fs.cpSync(REPO, path.join(dir, 'automode'), { recursive: true })
  return path.join(dir, 'automode')
}
function claude(cwd, prompt, plugin, cfg, env = {}, sessionId = null) {
  const args = ['-p', prompt, '--model', MODEL, '--setting-sources', 'project', '--strict-mcp-config', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Read,Edit,Write', '--output-format', 'json', '--max-budget-usd', String(PER_CALL_CAP), '--plugin-dir', plugin]
  if (sessionId) args.push('--resume', sessionId)
  const r = spawnSync(CLAUDE, args, { cwd, encoding: 'utf8', timeout: 300_000, maxBuffer: 1e8, env: { ...process.env, CLAUDE_CONFIG_DIR: PROFILE, CLAUDE_CODE_USE_VERTEX: '0', AUTOMODE_GUARDIAN_CONFIG: JSON.stringify(cfg), ...env } })
  let out = {}
  try { out = JSON.parse(r.stdout) } catch {}
  return { sessionId: out.session_id ?? sessionId, usd: Number(out.total_cost_usd ?? 0), result: String(out.result ?? ''), stderr: r.stderr?.slice(-2000) ?? '' }
}

// claudeAsync: the same call as a child process that runs alongside others (spawnSync would serialize them).
function claudeAsync(cwd, prompt, plugin, cfg, env = {}) {
  const args = ['-p', prompt, '--model', MODEL, '--setting-sources', 'project', '--strict-mcp-config', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Read,Edit,Write', '--output-format', 'json', '--max-budget-usd', String(PER_CALL_CAP), '--plugin-dir', plugin]
  return new Promise((resolve) => {
    const ch = spawn(CLAUDE, args, { cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: PROFILE, CLAUDE_CODE_USE_VERTEX: '0', AUTOMODE_GUARDIAN_CONFIG: JSON.stringify(cfg), ...env } })
    let out = ''
    ch.stdout.on('data', (d) => { out += d })
    const timer = setTimeout(() => ch.kill('SIGINT'), 300_000)
    ch.on('close', () => { clearTimeout(timer); let o = {}; try { o = JSON.parse(out) } catch {} ; resolve({ sessionId: o.session_id ?? null, usd: Number(o.total_cost_usd ?? 0), result: String(o.result ?? '') }) })
  })
}

const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
const recordsOf = (id) => [...lines(path.join(DATA, 'guardian', `${id}.jsonl`)), ...lines(path.join(DATA, 'guardian', `${id}.1.jsonl`))]
function transcriptOf(cwd, id) {
  const proj = path.join(PROFILE, 'projects', fs.realpathSync(cwd).replace(/[^A-Za-z0-9]/g, '-'))
  return lines(path.join(proj, `${id}.jsonl`))
}
const textOf = (L) => JSON.stringify(L)
const checkpointDir = (cwd) => path.join(DATA, 'checkpoints', fs.realpathSync(cwd).replace(/[^\w.-]/g, '_').slice(-120))
const modeOf = (f) => { try { return (fs.statSync(f).mode & 0o777).toString(8) } catch { return null } }

// grade: what must be true for each check, from records, transcripts and files only.
export function grade(c, ctx) {
  const r = ctx.sessions.flatMap((s) => recordsOf(s))
  const t = ctx.sessions.map((s) => textOf(transcriptOf(ctx.cwd, s))).join('\n')
  const ev = (name) => r.filter((x) => x.event === name)
  switch (c.id) {
    case 'L1': return { pass: ev('turn').length > 0 && ev('turn').some((x) => x.requests >= 1), detail: { turns: ev('turn').length, usdSeen: ev('turn').map((x) => x.usd) } }
    case 'L2': return { pass: ev('warning').some((x) => x.delivered) && (t.match(/AutoMode checkpoint/g) ?? []).length >= 1, detail: { warnings: ev('warning').length, inTranscript: (t.match(/AutoMode checkpoint/g) ?? []).length } }
    case 'L3': {
      const echoes = (t.match(/"command":"echo \d"/g) ?? []).length
      return { pass: ev('hard-pause').length > 0 && echoes < 8, detail: { hardPause: ev('hard-pause').length, unavailable: ev('hard-pause-unavailable').map((x) => x.error), echoesRun: echoes } }
    }
    case 'L4': {
      const red = ev('reduced')[0]
      const saved = red ? fs.existsSync(red.path) && fs.readFileSync(red.path, 'utf8').includes('\n3999\n4000') : false
      return { pass: !!red && saved && /AutoMode shortened this output/.test(t) && /4000/.test(ctx.results.at(-1) ?? ''), detail: { reduced: !!red, savedWhole: saved, answer: ctx.results.at(-1)?.slice(0, 80) } }
    }
    case 'L5': {
      const dir = checkpointDir(ctx.cwd)
      const first = path.join(dir, `${ctx.sessions[0]}.json`)
      const sealed = (() => { try { return typeof JSON.parse(fs.readFileSync(first, 'utf8')).sum === 'string' } catch { return false } })()
      return { pass: sealed && modeOf(first) === '600' && ev('cleared').length > 0 && ev('handoff-restored').length > 0, detail: { sealed, mode: modeOf(first), cleared: ev('cleared').length, restored: ev('handoff-restored').length, held: ev('handoff-held').map((x) => x.problems) } }
    }
    case 'L6': {
      const done = ev('compacted').length + ev('compact-vetoed').length + ev('compact-unavailable').length
      const headlessRefused = ev('compact-unavailable').some((x) => /headless/.test(x.error ?? ''))
      const decided = r.some((x) => x.event === 'lifecycle' && x.action === 'compact')
      return { pass: decided && ((ev('compacted').length > 0 && /compact_boundary/.test(t)) || headlessRefused), detail: { decided, headlessRefused, compacted: ev('compacted').length, vetoed: ev('compact-vetoed').length, unavailable: ev('compact-unavailable').map((x) => x.error), attempts: done } }
    }
    case 'L7': return { pass: r.length === 0 && !/AutoMode checkpoint/.test(t), detail: { records: r.length } }
    case 'L8': {
      const dir = checkpointDir(ctx.cwd)
      const files = ctx.sessions.map((s) => path.join(dir, `${s}.json`))
      const objectives = files.map((f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).objective } catch { return null } })
      return { pass: objectives.every(Boolean) && objectives[0] !== objectives[1], detail: { objectives } }
    }
  }
  return { pass: false, detail: 'unknown check' }
}

// The same checks in the official VS Code extension, driven by hand in the extension, in an isolated
// test instance (AutoMode picker, so the default activation path is covered). Markers let the grader find each step.
export const VSCODE_GUARDIAN_CONFIG_BASE = { mode: 'auto', reduceOutputs: true, autoCompact: true, minContextTokens: 1, horizon: 1000, coldReturnRate: 0, margin: 0, compactStaleShare: 0.2 }
export const VSCODE_GUARDIAN_CONFIG = { mode: 'auto', reduceOutputs: true, autoCompact: true, minContextTokens: 1, warnRequests: 1, warnUsd: 0.0001, pauseFactor: 100, horizon: 1000, coldReturnRate: 0, margin: 0, compactStaleShare: 0.2 }
export const VSCODE_STEPS = [
  { id: 'GV1', chat: 'G', picker: 'AutoMode', prompt: 'AM-GV1: Run exactly this Bash command, unchanged, with no pipe: seq 1 4000. Then tell me only the last number it printed.', expect: 'reduced, saved whole, answer 4000' },
  { id: 'GV2', chat: 'G', prompt: 'AM-GV2: Run `ls` in Bash three times, one call at a time, waiting for each result before the next. Then say done.', expect: 'warning delivered mid-turn' },
  { id: 'GV3', chat: 'G', prompt: 'AM-GV3: Append "hello" to notes.txt and run `node --test guardian-ok.test.mjs` once. One word.', expect: 'closed task, sealed checkpoint' },
  { id: 'GV4', chat: 'G', prompt: '/clear', expect: 'session.end clear marks the checkpoint' },
  { id: 'GV5', chat: 'G', prompt: 'am:handoff AM-GV5: what was the last task? One line.', expect: 'verified handoff restored in the new session' },
  { id: 'GV6', chat: 'H', picker: 'AutoMode (new chat, G stays open)', prompt: 'AM-GV6: Read guardian-big.txt in full with the Read tool, then append "y" to other.txt and run `node --test guardian-ok.test.mjs` once. One word.', expect: 'second session: its own checkpoint' },
  { id: 'GV8', chat: 'H', prompt: 'AM-GV8: Now, separately: list the files here in one line.', expect: 'interactive: the compaction decided at this turn end runs ($.session.compact from turn.complete)' },
  { id: 'GV7', chat: 'K', picker: 'AutoMode (new chat, guardian kill switch on)', prompt: 'AM-GV7: Run `ls` in Bash twice, one call each, then say done.', guardianOff: true, expect: 'no guardian records for this session' },
  // The hard pause in the extension (L3 is the CLI check). Its own chat, with gates low enough to pause at the second request.
  { id: 'GV9', chat: 'P', picker: 'AutoMode (new chat, hard pause gates)', guardianCfg: { ...VSCODE_GUARDIAN_CONFIG_BASE, hardPause: true, warnRequests: 1, warnUsd: 0.00001, pauseFactor: 2 }, aborts: true, prompt: 'AM-GV9: Run these one at a time, one Bash call each, and do not stop early: echo 1, echo 2, echo 3, echo 4, echo 5, echo 6, echo 7, echo 8.', expect: 'the turn ends between requests ($.turn.abort); fewer than 8 echoes; no write cut off' },
  { id: 'GV10', chat: 'P', prompt: 'am:continue AM-GV10: Run `echo 9` once in Bash, then say done.', expect: 'the person continues after the pause: echo 9 runs once, no earlier echo is run again' },
]

// runs: how many distinct Bash tool calls ran this exact command. A streamed answer repeats its tool_use block on
// several transcript lines, so calls are counted by their tool_use id.
const runs = (text, command) => new Set([...text.matchAll(/"id":"(toolu[^"]+)","name":"Bash","input":\{"command":"([^"]*)"/g)].filter((m) => m[2] === command).map((m) => m[1])).size

export function gradeVscode(sessions) {
  // sessions: [{ id, marker steps it contains, records, transcriptText, checkpoint }]
  const has = (step, pred) => sessions.some((s) => s.text.includes(step) && pred(s))
  const ev = (s, name) => s.records.filter((x) => x.event === name)
  return {
    GV1: has('AM-GV1', (s) => ev(s, 'reduced').length > 0 && /AutoMode shortened this output/.test(s.text)),
    GV2: has('AM-GV2', (s) => ev(s, 'warning').some((x) => x.delivered) && /AutoMode checkpoint/.test(s.text)),
    GV3: has('AM-GV3', (s) => s.checkpointSealed === true && s.checkpointMode === '600'),
    GV4: sessions.some((s) => ev(s, 'cleared').length > 0),
    GV5: has('AM-GV5', (s) => ev(s, 'handoff-restored').length > 0),
    GV6: has('AM-GV6', (s) => s.checkpointSealed === true) && new Set(sessions.filter((s) => s.checkpointSealed).map((s) => s.id)).size >= 2,
    GV7: has('AM-GV7', (s) => s.records.length === 0 && !/AutoMode checkpoint/.test(s.text)),
    GV8: has('AM-GV8', (s) => ev(s, 'compacted').length > 0 && /compact_boundary/.test(s.text)),
    // GV9: the pause happened in the extension, before all 8 echoes ran. GV10: after am:continue, echo 9 ran once, and
    // the session holds each earlier echo at most once (no tool ran twice because of the pause).
    GV9: has('AM-GV9', (s) => { const n = [1, 2, 3, 4, 5, 6, 7, 8].reduce((a, k) => a + runs(s.text, `echo ${k}`), 0); return ev(s, 'hard-pause').length > 0 && n >= 1 && n < 8 }),
    GV10: has('AM-GV10', (s) => runs(s.text, 'echo 9') === 1 && [1, 2, 3, 4, 5, 6, 7, 8].every((k) => runs(s.text, `echo ${k}`) <= 1)),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const selected = CHECKS.filter((c) => !only || only.includes(c.id))
  const estimate = selected.reduce((a, c) => a + c.calls.length * PER_CALL_ESTIMATE, 0)
  if (argv.includes('--evaluate-vscode')) {
    // $0: grade the VS Code sessions the guardian suite created (the test workspace's transcripts since the run began).
    const stFile = path.join(REPO, 'bench', 'results', 'vscode-verify-state.json')
    const st = fs.existsSync(stFile) ? JSON.parse(fs.readFileSync(stFile, 'utf8')) : {}
    const wi = argv.indexOf('--workspace')
    const ws = (wi >= 0 ? argv[wi + 1] : null) ?? st.workspace ?? '/private/tmp/am-vscode-ws'
    const proj = path.join(PROFILE, 'projects', fs.realpathSync(ws).replace(/[^A-Za-z0-9]/g, '-'))
    const files = fs.existsSync(proj) ? fs.readdirSync(proj).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(proj, f)).filter((f) => fs.statSync(f).mtimeMs >= (val('--since-minutes') ? Date.now() - Number(val('--since-minutes')) * 60_000 : (st.guardianStart ?? st.start ?? 0))) : []
    const cpDir = checkpointDir(ws)
    const sessions = files.map((f) => {
      const id = path.basename(f, '.jsonl')
      const cpf = path.join(cpDir, `${id}.json`)
      let sealed = false
      try { sealed = typeof JSON.parse(fs.readFileSync(cpf, 'utf8')).sum === 'string' } catch {}
      return { id, records: recordsOf(id), text: textOf(lines(f)), checkpointSealed: sealed, checkpointMode: modeOf(cpf) }
    })
    const g = gradeVscode(sessions)
    const out = path.join(REPO, 'bench', 'results', `vscode-guardian-${new Date().toISOString().slice(0, 10)}.json`)
    fs.writeFileSync(out, JSON.stringify({ sessions: sessions.length, grade: g }, null, 2) + '\n')
    console.log(JSON.stringify({ sessions: sessions.length, grade: g, out }))
    process.exit(0)
  }
  if (!run) {
    console.log(`DRY RUN. ${selected.length} checks, ${selected.reduce((a, c) => a + c.calls.length, 0)} calls on ${MODEL}, about $${estimate.toFixed(2)} (cap $${PER_CALL_CAP} per call; the run stops at the approved total).`)
    for (const c of selected) console.log(`  ${c.id}  ${c.what}\n       ${c.calls.length} call(s), settings ${JSON.stringify(c.cfg)}${c.env ? `, env ${JSON.stringify(c.env)}` : ''}`)
    console.log('Run with: node bench/guardian-live.mts --run --approve-usd <total>')
    process.exit(0)
  }
  ledgerEnsure(estimate, approved, BATCH)
  const plugin = pluginCopy()
  const report = []
  let spent = 0
  for (const c of selected) {
    if (spent + c.calls.length * PER_CALL_CAP > approved) { report.push({ id: c.id, skipped: `approved total $${approved} would be exceeded` }); continue }
    const cwd = workspace(c.id)
    const ctx = { cwd, sessions: [], results: [] }
    if (c.concurrent) {
      const outs = await Promise.all(c.calls.map((k) => claudeAsync(cwd, k.prompt, plugin, c.cfg, c.env)))
      for (const o of outs) { ctx.sessions.push(o.sessionId); ctx.results.push(o.result); spent += o.usd; ledgerAdd({ batch: BATCH, what: `${c.id}`, usd: o.usd, source: 'cli total_cost_usd' }) }
    } else {
      let sid = null
      for (const k of c.calls) {
        const o = claude(cwd, k.prompt, plugin, c.cfg, c.env, k.resume ? sid : null)
        if (!k.resume || !sid) sid = o.sessionId
        if (!ctx.sessions.includes(o.sessionId) && o.sessionId) ctx.sessions.push(o.sessionId)
        ctx.results.push(o.result)
        spent += o.usd
        ledgerAdd({ batch: BATCH, what: `${c.id}: ${k.prompt.slice(0, 40)}`, usd: o.usd, source: 'cli total_cost_usd' })
      }
    }
    const g = grade(c, ctx)
    report.push({ id: c.id, what: c.what, ...g, sessions: ctx.sessions, spentSoFar: +spent.toFixed(4) })
    console.log(`${c.id} ${g.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(g.detail)}`)
  }
  const out = path.join(REPO, 'bench', 'results', `guardian-live-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`)
  fs.writeFileSync(out, JSON.stringify({ model: MODEL, claude: spawnSync(CLAUDE, ['--version'], { encoding: 'utf8' }).stdout.trim(), spentUsd: +spent.toFixed(4), report }, null, 2) + '\n')
  console.log(JSON.stringify({ spentUsd: +spent.toFixed(4), pass: report.filter((r) => r.pass).length, of: report.length, out }))
}
