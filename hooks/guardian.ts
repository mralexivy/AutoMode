// Session and cost guardian: the wiring. The policy is in lib/guardian.ts; this module feeds it from engine events and
// acts only through supported calls (Claude Code 2.1.300, plugin API types):
//   cost and context    $.session.usage(): cost.usd (every priced response, subagents included), context.tokens   used
//   mid-turn note       tool.call result `context` (the model reads it after the result; the person does not)     recommend+
//   end a turn          $.turn.abort({ turnId }), only between requests and never right after a write             auto + hardPause
//   compact             $.session.compact({ instructions }) from turn.complete, after the turn has finished (the
//                       engine refuses it from prompt.submit, which holds the next turn)                          auto + autoCompact
//   clear / roll over   no API. A sealed checkpoint, `/clear` proposed in the prompt box (Tab, Enter), and after
//                       session.end reason `clear` a verified handoff on the next session's first prompt         assist+
//   shorten a result    tool.call returns its own result: Bash `{ stdout, stderr }`, or a text-only MCP result;
//                       the full output is saved first, or nothing changes                                       auto + reduceOutputs
// The fs API has no rename, delete or chmod: a write is read back and checksummed, the previous good copy is kept,
// and permissions and retention go through $.process.run on the plugin's own data folder only.
// The router keeps model and effort: the guardian never picks one, and prices with the running model.
// Modes: off, observe (default), recommend, assist, auto. Kill switch: AUTOMODE_GUARDIAN=off, or config.json
// "guardian": { "mode": "off" }, read again at every prompt. The rest of AutoMode is unaffected.
import type { EngineInterface } from 'claude-code'
import {
  GUARDIAN_DEFAULTS, newTurn, observeTool, observeOutcome, observeRequest, assess, noteFor, safeToAbort, lifecycle,
  reduceOutput, reduceMcp, reducible, validateCheckpoint, checkpointSum, handoffText, scrub, modeOf, shouldOffer, atLeast, buildCheckpoint,
  verifyRestore, restrictionsIn, sealCheckpoint, openCheckpoint, failedOutput, type GuardianConfig, type TurnState, type Checkpoint,
} from './lib/guardian.ts'
import { FOLLOW_UP } from './lib/classify.ts'
import { familyOf } from './lib/prices.ts'
import { guardianOverrides } from './lib/settings.ts'
import { currentOptions, storedOptions } from './options.ts'
import { publish } from './ui/publish.ts'
import type { GuardSnap } from './ui/view.ts'
import { sid, fsRead, sessionModel, fsWrite } from './lib/io.ts'

const MAX_FILES_READ = 200
const RECORDS_ROTATE_BYTES = 1_000_000
const RETENTION_MS = { checkpoints: 7 * 86_400_000, outputs: 3 * 86_400_000, guardian: 30 * 86_400_000 }
const CLEANUP_EVERY_MS = 6 * 3_600_000

interface SessionState {
  loaded: boolean
  cfg: GuardianConfig
  picker: string
  sessionId: string
  cwd: string
  turn: TurnState | null
  lastUsd: number | null        // session cost at the last reading
  contextTokens: number
  lastRequestAt: number | null
  model: string
  objective: string | null
  taskStartTokens: number       // the context size when the current task began: what came before it is stale for it
  baseTokens: number            // the session's own base (system prompt and tools): its first request's context, measured
  closed: boolean
  filesRead: string[]
  checks: { command: string; passed: boolean }[]
  authorizeNext: boolean
  restrictions: string[]        // what the person said not to do in this task, verbatim
  approvals: string[]           // what the person allowed (an approved plan, am:continue)
  lastOffer: { action: 'continue' | 'compact' | 'clear'; contextTokens: number } | null
  handoff: Checkpoint | null    // a checkpoint left for this session by a /clear in the same folder
  handoffSuccessor: boolean     // this session began within two minutes of that /clear: it may decline the handoff
  pendingChecked: boolean       // the pending pointer was read for this session
  records: Record<string, unknown>[]
  recordsPart: number           // the rotation index of this session's records file
  recordsBytes: number
  view: GuardView               // what the UI shows (hooks/ui): copies made where the guardian acts; never read by it
}

interface GuardView {
  assess: { level: GuardSnap['level']; reasons: string[] } | null
  offer: GuardSnap['offer']
  paused: GuardSnap['paused']
  checkpoint: GuardSnap['checkpoint']
  restored: GuardSnap['restored']
  continued: boolean
  last: GuardSnap['last']
}
const freshView = (): GuardView => ({ assess: null, offer: null, paused: null, checkpoint: null, restored: null, continued: false, last: null })

const fresh = (): SessionState => ({
  loaded: false, cfg: GUARDIAN_DEFAULTS, picker: 'claude-sonnet-5-5[1m]', sessionId: 'unknown', cwd: '', turn: null, lastUsd: null,
  contextTokens: 0, lastRequestAt: null, model: '', objective: null, taskStartTokens: 0, baseTokens: 0, closed: false, filesRead: [], checks: [],
  authorizeNext: false, restrictions: [], approvals: [], lastOffer: null, handoff: null, handoffSuccessor: false, pendingChecked: false, records: [],
  recordsPart: 0, recordsBytes: 0, view: freshView(),
})
let G = fresh()
let lastCleanup = 0 // per process: retention runs at most every few hours
let killedByEnv = false // AUTOMODE_GUARDIAN=off, for the UI's label
let lastEnabled = false // the last answer of enabled(), for the UI's snapshot (which gets no $)
export const __resetGuardian = () => { G = fresh(); lastCleanup = 0; killedByEnv = false; lastEnabled = false }

async function now($: EngineInterface) { try { return await $.clock.now() } catch { return Date.now() } }
async function dataDir($: EngineInterface): Promise<string> {
  let dir: string | undefined
  try { dir = await $.env.get('CLAUDE_PLUGIN_DATA') } catch {}
  if (dir) return dir
  let home: string | undefined
  try { home = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude` } catch {}
  return `${home ?? '.'}/plugins/data/automode`
}
const safeName = (s: string) => s.replace(/[^\w.-]/g, '_')
// One checkpoint file per session, in a folder per project, so concurrent sessions in one repository never overwrite each
// other. A /clear writes `pending.json` in that folder, naming the session whose checkpoint the next session receives.
const projectDir = (dir: string, cwd: string) => `${dir}/checkpoints/${safeName(cwd).slice(-120)}`
const sessionFile = (dir: string, cwd: string, id: string) => `${projectDir(dir, cwd)}/${safeName(id)}.json`
const pendingFile = (dir: string, cwd: string) => `${projectDir(dir, cwd)}/pending.json`

// load reads config.json and AUTOMODE_GUARDIAN. `fresh` reads them again: every prompt does, so a mode change or the
// kill switch takes effect mid-session without a reload.
async function load($: EngineInterface, again = false) {
  if (G.loaded && !again) return
  G.loaded = true
  let cfg: GuardianConfig = { ...GUARDIAN_DEFAULTS }
  try {
    const raw = JSON.parse(await fsRead($, `${$.plugin.root}/config.json`))
    cfg = { ...GUARDIAN_DEFAULTS, ...(raw.guardian ?? {}), mode: modeOf(raw.guardian?.mode ?? GUARDIAN_DEFAULTS.mode) }
    if (raw.pickerModel) G.picker = raw.pickerModel
  } catch {}
  // Settings from the UI (userConfig, lib/settings.ts) sit over config.json; the environment below still wins.
  const over = guardianOverrides(currentOptions(), storedOptions())
  if (Object.keys(over).length) cfg = { ...cfg, ...over, mode: modeOf(over.mode ?? cfg.mode) }
  // AUTOMODE_GUARDIAN_CONFIG: a JSON object over config.json, for a test profile or one machine. Only known keys of
  // the right type are taken; anything else is ignored.
  try {
    const raw = (await $.env.get('AUTOMODE_GUARDIAN_CONFIG'))?.trim()
    if (raw) {
      const over = JSON.parse(raw)
      for (const [k, v] of Object.entries(over ?? {})) {
        if (!(k in GUARDIAN_DEFAULTS)) continue
        const want = typeof (GUARDIAN_DEFAULTS as any)[k]
        if (k === 'mode') cfg.mode = modeOf(v)
        else if (k === 'turnBudgetUsd' ? v === null || typeof v === 'number' : typeof v === want) (cfg as any)[k] = v
      }
    }
  } catch {}
  killedByEnv = false
  try { const env = (await $.env.get('AUTOMODE_GUARDIAN'))?.trim(); if (env) { cfg = { ...cfg, mode: modeOf(env) }; killedByEnv = cfg.mode === 'off' } } catch {}
  G.cfg = cfg
}

// enabled: the guardian runs while its mode is not off, in AutoMode sessions, and in every session with everySession.
async function enabled($: EngineInterface): Promise<boolean> {
  lastEnabled = await isEnabled($)
  return lastEnabled
}
async function isEnabled($: EngineInterface): Promise<boolean> {
  await load($)
  if (G.cfg.mode === 'off') return false
  // One process can host several sessions in turn (/clear, /resume): state belongs to one session id. A new id keeps
  // the configuration and the folder, and starts the rest over.
  let id = G.sessionId
  try { id = await sid($) } catch {}
  if (id !== G.sessionId) {
    if (G.sessionId !== 'unknown') { await flushRecords($); const keep = { loaded: G.loaded, cfg: G.cfg, picker: G.picker, cwd: G.cwd }; G = { ...fresh(), ...keep } }
    G.sessionId = id
    await restore($)
  }
  if (G.cfg.everySession) return true
  try { return (await sessionModel($)).trim() === G.picker } catch { return false }
}
// Persistence: a resumed session (`--resume`, a CLI restart, a VS Code reload) runs in a new process, but its task does
// not reset. The task-level state is saved per session at each turn end and read back once (live check L6, 2026-10-26:
// each `claude -p --resume` turn forgot that the previous task had closed). The open turn's counters are not kept: a
// new process starts a new turn.
const PERSISTED = ['objective', 'taskStartTokens', 'baseTokens', 'closed', 'filesRead', 'checks', 'restrictions', 'approvals', 'lastOffer', 'contextTokens', 'lastRequestAt', 'model', 'recordsPart', 'cwd'] as const
async function stateFile($: EngineInterface): Promise<string> { return `${await dataDir($)}/guardian/${safeName(G.sessionId)}.state.json` }
async function persist($: EngineInterface) {
  const snap: Record<string, unknown> = { v: 1 }
  for (const k of PERSISTED) snap[k] = (G as any)[k]
  snap.filesRead = G.filesRead.slice(-50)
  await writeDurable($, await stateFile($), JSON.stringify(snap))
}
async function restore($: EngineInterface) {
  try {
    const snap = JSON.parse(await fsRead($, await stateFile($)))
    if (snap?.v !== 1) return
    for (const k of PERSISTED) if (snap[k] !== undefined && !(k === 'cwd' && G.cwd)) (G as any)[k] = snap[k]
  } catch {}
}

const notifying = () => atLeast(G.cfg.mode, 'recommend')
const assisting = () => atLeast(G.cfg.mode, 'assist')
const automatic = () => atLeast(G.cfg.mode, 'auto')

// ---------------------------------------------------------------- storage
// tighten: owner-only permissions on the guardian's own files (the fs API has no chmod). Best effort, never fatal.
async function tighten($: EngineInterface, path: string, mode: '600' | '700') {
  try { await $.process.run(['chmod', mode, path], { timeoutMs: 3000 }) } catch {}
}
// writeDurable: write, read back, compare. The fs API has no rename, so the write is verified instead of atomic; the
// caller keeps a previous copy where losing the file would matter.
async function writeDurable($: EngineInterface, path: string, text: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fsWrite($, path, text)
      if ((await fsRead($, path)) === text) { await tighten($, path, '600'); return true }
    } catch {}
  }
  return false
}

async function record($: EngineInterface, r: Record<string, unknown>) {
  if (G.sessionId === 'unknown') { try { G.sessionId = await sid($) } catch {} }
  G.records.push({ v: 1, kind: 'guardian', at: await now($), sessionId: G.sessionId, ...r })
}
// flushRecords appends to this session's records file; past 1 MB the session starts its next part, so no read-and-
// rewrite grows without bound in a long session.
async function flushRecords($: EngineInterface) {
  if (!G.records.length) return
  try {
    const base = `${await dataDir($)}/guardian/${safeName(G.sessionId)}`
    const file = G.recordsPart ? `${base}.${G.recordsPart}.jsonl` : `${base}.jsonl`
    let prev = ''
    try { prev = await fsRead($, file) } catch {}
    const add = G.records.map((r) => JSON.stringify(r)).join('\n') + '\n'
    await fsWrite($, file, prev + add)
    // Owner-only, as every other guardian file (found live, 2026-10-26: the records file was 644).
    await tighten($, file, '600')
    G.recordsBytes = prev.length + add.length
    if (G.recordsBytes > RECORDS_ROTATE_BYTES) { G.recordsPart += 1; G.recordsBytes = 0 }
    G.records = []
  } catch {}
}

// readCheckpoint: the session's checkpoint if its checksum holds, else the previous good copy, else nothing.
async function readCheckpoint($: EngineInterface, dir: string, id: string): Promise<{ cp: Checkpoint | null; problem: string | null; usedPrevious: boolean }> {
  const file = sessionFile(dir, G.cwd, id)
  let text: string | null = null
  try { text = await fsRead($, file) } catch {}
  const main = openCheckpoint(text)
  if (main.cp) return { cp: main.cp, problem: null, usedPrevious: false }
  let prevText: string | null = null
  try { prevText = await fsRead($, file.replace(/\.json$/, '.prev.json')) } catch {}
  const prev = openCheckpoint(prevText)
  return { cp: prev.cp, problem: main.problem, usedPrevious: !!prev.cp }
}

// cleanup: retention for the guardian's own folders (checkpoints 7 days, saved outputs 3 days, records 30 days). It
// lists with $.fs.list and removes with `rm -f` on paths it built under the data folder; nothing else is ever touched.
async function cleanup($: EngineInterface) {
  const t = await now($)
  if (t - lastCleanup < CLEANUP_EVERY_MS) return
  lastCleanup = t
  const dir = await dataDir($)
  const old: string[] = []
  const walk = async (path: string, maxAge: number, depth: number) => {
    let entries: any[] = []
    try { entries = await $.fs.list(path) } catch { return }
    for (const en of entries) {
      const p = `${path}/${en.name}`
      if (en.kind === 'directory' && depth > 0) await walk(p, maxAge, depth - 1)
      else if (en.kind === 'file' && en.name !== 'pending.json' && en.mtimeMs && t - en.mtimeMs > maxAge && !p.includes(safeName(G.sessionId))) old.push(p)
    }
  }
  await walk(`${dir}/checkpoints`, RETENTION_MS.checkpoints, 1)
  await walk(`${dir}/outputs`, RETENTION_MS.outputs, 1)
  await walk(`${dir}/guardian`, RETENTION_MS.guardian, 0)
  const safe = old.filter((p) => p.startsWith(`${dir}/checkpoints/`) || p.startsWith(`${dir}/outputs/`) || p.startsWith(`${dir}/guardian/`)).slice(0, 200)
  if (!safe.length) return
  try { await $.process.run(['rm', '-f', '--', ...safe], { timeoutMs: 10_000 }); await record($, { event: 'cleanup', removed: safe.length }) } catch {}
}

async function readUsage($: EngineInterface): Promise<{ usd: number | null; tokens: number }> {
  try { const u = await $.session.usage(); return { usd: u.cost?.usd ?? null, tokens: u.context?.tokens ?? 0 } } catch { return { usd: null, tokens: 0 } }
}

// ---------------------------------------------------------------- session boundaries
export async function guardianSessionStart($: EngineInterface, e: any, next: any) {
  const res = await next(e)
  try { await afterStart($, e, res) } catch {}
  return res
}

async function afterStart($: EngineInterface, e: any, res: any) {
  if (!(await enabled($))) return
  try { G.sessionId = await sid($) } catch {}
  G.cwd = res?.cwd ?? e.cwd ?? G.cwd
  await loadPending($)
  if (assisting()) await cleanup($)
  await flushRecords($)
}

// loadPending: a checkpoint left by a /clear in this folder, still valid, offered to this session's first prompt. Read
// at session.start and again at the first prompt: in the VS Code extension a /clear starts the next session in the same
// process without a session.start reaching the plugin (live check GV5, 2026-10-26).
async function loadPending($: EngineInterface) {
  if (G.pendingChecked || !G.cwd) return
  G.pendingChecked = true
  try {
    const dir = await dataDir($)
    const pending = JSON.parse(await fsRead($, pendingFile(dir, G.cwd)))
    if (!pending?.sessionId || pending.sessionId === G.sessionId) return
    const read = await readCheckpoint($, dir, pending.sessionId)
    if (read.problem) await record($, { event: 'checkpoint-corrupt', problem: read.problem, usedPrevious: read.usedPrevious })
    const v = validateCheckpoint(read.cp, await now($), G.cwd)
    // The pointer names the folder and the checkpoint the /clear left. Another folder or another file is not this handoff.
    if (v.ok && pending.cwd !== undefined && pending.cwd !== G.cwd) v.missing.push('the folder named by the clear')
    if (v.ok && pending.sum !== undefined && read.cp && pending.sum !== checkpointSum(read.cp)) v.missing.push('the checkpoint named by the clear')
    v.ok = v.missing.length === 0
    if (v.ok) { G.handoff = read.cp; G.handoffSuccessor = typeof pending.at === 'number' && (await now($)) - pending.at <= 120_000 }
    else { await record($, { event: 'handoff-rejected', missing: v.missing }); await fsWrite($, pendingFile(dir, G.cwd), '{}') }
  } catch {}
}

export async function guardianSessionEnd($: EngineInterface, e: any, next: any) {
  try {
    if ((await enabled($)) && e.reason === 'clear') {
      // The person ran /clear: the checkpoint written at the last turn end becomes the next session's handoff.
      const dir = await dataDir($)
      const left = assisting() ? (await readCheckpoint($, dir, G.sessionId)).cp : null
      if (left) await writeDurable($, pendingFile(dir, G.cwd), JSON.stringify({ sessionId: G.sessionId, at: await now($), cwd: G.cwd, sum: checkpointSum(left) }))
      await record($, { event: 'cleared' })
      await flushRecords($)
    }
  } catch {}
  return next(e)
}

// ---------------------------------------------------------------- prompts
export async function guardianPromptSubmit($: EngineInterface, e: any, next: any) {
  try { await load($, true) } catch {}
  let ctx: string[] = []
  try {
    if (await enabled($)) ctx = await beforePrompt($, e)
  } catch {}
  return next(ctx.length ? { ...e, context: [...(e.context ?? []), ...ctx] } : e)
}

async function beforePrompt($: EngineInterface, e: any): Promise<string[]> {
  const byPerson = e.origin?.kind === 'composer' || e.origin?.kind === 'bridge' || e.origin?.kind === 'sdk'
  const text = String(e.text ?? '').trim()
  if (!byPerson || e.command || e.isMeta || text.startsWith('/')) return []
  G.authorizeNext = /\bam:continue\b/i.test(text)
  // A new prompt ends a paused turn's card; am:continue shows as approved until that turn ends.
  G.view.paused = null
  G.view.continued = G.authorizeNext
  G.view.restored = null
  if (G.authorizeNext) G.approvals.push('am:continue: more work allowed in this turn')
  // A new task after a closed one: a new objective.
  if (!G.objective || (G.closed && !FOLLOW_UP.test(text))) {
    G.objective = scrub(text.replace(/\s+/g, ' ').slice(0, 500)); G.closed = false; G.filesRead = []; G.checks = []
    G.taskStartTokens = G.contextTokens; G.restrictions = []; G.approvals = []
  }
  G.restrictions = [...new Set([...G.restrictions, ...restrictionsIn(text)])].slice(-20)
  const context: string[] = []
  if (!G.cwd) { try { G.cwd = await $.env.get('PWD') ?? '' } catch {} }
  await loadPending($)
  if (G.handoff) {
    const forced = /\bam:handoff\b/i.test(text)
    // A handoff belongs to the session that followed the /clear. Another chat in the same folder leaves it alone, unless
    // the person asks for it by name.
    const mine = G.handoffSuccessor || forced
    const leans = mine && (G.handoff.status === 'open' || FOLLOW_UP.test(text) || forced)
    const check = verifyRestore(G.handoff, await git($))
    let consumed = true
    if (!mine) {
      consumed = false
      await record($, { event: 'handoff-foreign', from: G.handoff.sessionId })
    } else if (leans && !assisting()) await record($, { event: 'handoff-would-restore', from: G.handoff.sessionId, problems: check.problems })
    else if (leans && !check.ok && !forced) {
      // The tree moved since the checkpoint: the handoff waits, the checkpoint stays pending, the person decides.
      consumed = false
      await record($, { event: 'handoff-held', from: G.handoff.sessionId, problems: check.problems })
      if (notifying()) $.ui.toast(`AutoMode: the task checkpoint was not restored: ${check.problems.join('; ')}. Say "am:handoff" to restore it anyway.`)
    } else if (leans) {
      context.push(handoffText(G.handoff) + (check.ok ? '' : `\nWarning: ${check.problems.join('; ')}. Check the working tree before you continue.`))
      G.objective = G.handoff.objective
      G.restrictions = G.handoff.approvals.filter((a) => a.startsWith('restriction: ')).map((a) => a.slice(13))
      await record($, { event: 'handoff-restored', from: G.handoff.sessionId, status: G.handoff.status, verified: check.ok })
      G.view.restored = { from: G.handoff.sessionId, at: await now($) }
      if (notifying()) $.ui.toast('AutoMode: restored the task checkpoint from the cleared session.')
    } else {
      // Only the session that followed the /clear may decline the handoff; another session leaves it for that one.
      consumed = G.handoffSuccessor
      await record($, { event: 'handoff-not-needed', from: G.handoff.sessionId, successor: G.handoffSuccessor })
    }
    G.handoff = null
    if (consumed) { try { await fsWrite($, pendingFile(await dataDir($), G.cwd), '{}') } catch {} }
    await flushRecords($)
  }
  // A cold cache on a large context: recorded with the economics, for the person's records and the replay.
  const t = await now($)
  if (G.lastRequestAt !== null && G.contextTokens >= G.cfg.minContextTokens && G.model && t - G.lastRequestAt > 3_600_000) {
    const d = lifecycle({ family: familyOf(G.model) ?? 'opus', contextTokens: G.contextTokens, baseTokens: G.baseTokens || 40_000, staleTokens: Math.max(0, G.contextTokens - (G.baseTokens || 40_000)), idleMs: t - G.lastRequestAt, ttlMs: 3_600_000, horizon: G.cfg.horizon, taskClosed: G.closed, openFailures: 0 }, G.cfg)
    await record($, { event: 'cold-prompt', contextTokens: G.contextTokens, decision: d.action, costs: d.costs })
  }
  await publish($)
  return context
}

// ---------------------------------------------------------------- turns
export async function guardianTurnStart($: EngineInterface, e: any, next: any) {
  try {
    if (e.agentId === undefined && (await enabled($)) && G.turn?.turnId !== e.turnId) {
      G.turn = newTurn(e.turnId, await now($), G.authorizeNext ? 1 : 0)
      G.authorizeNext = false
      G.view.assess = null
      G.lastUsd = (await readUsage($)).usd
    }
  } catch {}
  return next(e)
}

// guardianStep: one main-loop request is about to be sent. A hard pause, when opted in, ends the turn here: between
// requests, so no tool is running.
export async function guardianStep($: EngineInterface, e: any) {
  if (e.agentId !== undefined || !(await enabled($))) return
  // A turn starts at its first request when turn.start did not reach this plugin.
  if (!G.turn || G.turn.turnId !== e.turnId) { G.turn = newTurn(e.turnId, await now($), G.authorizeNext ? 1 : 0); G.authorizeNext = false; if (G.lastUsd === null) G.lastUsd = (await readUsage($)).usd }
  G.model = e.model ?? G.model
  const u = await readUsage($)
  const delta = u.usd !== null && G.lastUsd !== null ? Math.max(0, u.usd - G.lastUsd) : 0
  if (u.usd !== null) G.lastUsd = u.usd
  observeRequest(G.turn, delta)
  G.contextTokens = u.tokens || G.contextTokens
  // The base is the smallest context a request of this session has carried (its first request, or after a compaction).
  if (u.tokens > 5_000 && (!G.baseTokens || u.tokens < G.baseTokens)) G.baseTokens = u.tokens
  G.lastRequestAt = await now($)
  const a = assess(G.turn, G.cfg)
  G.view.assess = { level: a.level, reasons: a.reasons }
  if (a.level === 'pause' && automatic() && G.cfg.hardPause && safeToAbort(G.turn) && G.turn.noted === 'pause') {
    await record($, { event: 'hard-pause', turnId: e.turnId, reasons: a.reasons, requests: G.turn.requests, usd: G.turn.usd })
    await writeCheckpoint($, 'open', `The guardian paused a turn that was not converging (${a.reasons.join('; ')}): reassess the approach before continuing.`)
    await flushRecords($)
    // The UI says "paused" only after the abort succeeded; a refusal is shown as what it is.
    const at = await now($)
    try {
      await $.turn.abort({ turnId: e.turnId })
      G.view.paused = { at, reasons: a.reasons }
      G.view.last = { kind: 'pause', at, why: a.reasons[0] ?? 'not converging' }
    } catch (err) {
      await record($, { event: 'hard-pause-unavailable', error: String((err as Error)?.message ?? err).slice(0, 120) })
      G.view.last = { kind: 'pause not possible here', at, why: 'the turn could not be ended; the guardian only advises' }
    }
    await publish($)
  }
}

export async function guardianToolCall($: EngineInterface, e: any, next: any) {
  let on = false
  try { on = e.agentId === undefined && (await enabled($)) } catch {}
  if (!on) return next(e)
  const res = await next(e)
  // The tool has run: from here a guardian error returns the tool's own result, never a second run.
  try { return await afterTool($, e, res) } catch { return res }
}

async function afterTool($: EngineInterface, e: any, res: any) {
  if (!G.turn || !res || res.deny) return res
  const input = e.input ?? e
  const text = typeof res.text === 'string' ? res.text : ''
  const outcome = observeTool(G.turn, { tool: e.tool, input, isError: !!res.isError, text }, G.cfg.weakOutcomes)
  if (e.tool === 'Read' && input.file_path && !G.filesRead.includes(input.file_path)) G.filesRead = [...G.filesRead, String(input.file_path)].slice(-MAX_FILES_READ)
  if (e.tool === 'Bash' && /\b(test|build|tsc|check|lint|vet)\b/.test(String(input.command ?? ''))) {
    G.checks = [...G.checks, { command: scrub(String(input.command).slice(0, 160)), passed: !failedOutput(!!res.isError, text) }].slice(-8)
  }
  if (outcome) { observeOutcome(G.turn, outcome, await now($)); await record($, { event: 'outcome', outcome, turnId: G.turn.turnId, requests: G.turn.requests }) }
  if (outcome === 'plan-approved') G.approvals.push('plan approved')
  const a = assess(G.turn, G.cfg)
  const note = noteFor(G.turn, a)
  const before = G.view.assess?.level
  G.view.assess = { level: a.level, reasons: a.reasons }
  if (note) await record($, { event: a.level, turnId: G.turn.turnId, reasons: a.reasons, requests: G.turn.requests, usd: G.turn.usd, delivered: notifying() })
  if (note) G.view.last = { kind: a.level, at: await now($), why: a.reasons[0] ?? a.level }
  if (outcome || note || before !== a.level) await publish($)
  let out = res
  if (automatic() && G.cfg.reduceOutputs && reducible(e.tool) && !res.isError) out = await reduce($, e, res)
  if (note && notifying()) out = { ...out, context: [...(out.context ?? []), note] }
  return out
}

// reduce: save the whole result first; only a verified save allows a shorter result. Bash keeps its own fields; an MCP
// result keeps its non-text blocks. Anything else, or a failed save, leaves the result as it was.
async function reduce($: EngineInterface, e: any, res: any) {
  const id = safeName(String(e.toolUseId ?? e.tool_use_id ?? `${Date.now()}`))
  const path = `${await dataDir($)}/outputs/${safeName(G.sessionId)}/${id}.txt`
  if (e.tool === 'Bash' && res.result && typeof res.result.stdout === 'string') {
    const total = res.result.stdout.length + (res.result.stderr ?? '').length
    if (total <= G.cfg.reduceAboveChars) return res
    if (!(await writeDurable($, path, `${res.result.stdout}\n--- stderr ---\n${res.result.stderr ?? ''}`))) return res
    const r = reduceOutput(res.result.stdout, G.cfg.reduceAboveChars, path)
    if (!r.reduced) return res
    await record($, { event: 'reduced', tool: e.tool, from: total, to: r.text.length, path })
    return { result: { ...res.result, stdout: r.text } }
  }
  if (/^mcp__/.test(e.tool)) {
    const probe = reduceMcp(res.result, G.cfg.reduceAboveChars, path)
    if (!probe) return res
    if (!(await writeDurable($, path, probe.full))) return res
    await record($, { event: 'reduced', tool: e.tool, from: probe.from, to: probe.to, path })
    return { result: probe.result }
  }
  return res
}

export async function guardianTurnComplete($: EngineInterface, e: any, next: any) {
  const res = await next(e)
  try { await afterTurn($, e) } catch {}
  return res
}

async function afterTurn($: EngineInterface, e: any) {
  if (e.agentId !== undefined || !G.turn || !(await enabled($))) return
  const t = G.turn
  const last = t.outcomes.at(-1)
  G.closed = !!last && last.request >= t.requests - 5 && Object.keys(t.failures).length === 0
  await record($, { event: 'turn', turnId: t.turnId, requests: t.requests, usd: t.usd, outcomes: t.outcomes.map((o) => o.kind), closed: G.closed })
  const u = await readUsage($)
  G.contextTokens = u.tokens || G.contextTokens
  const nextStep = String(e.answer ?? '').replace(/\s+/g, ' ').slice(-400) || 'continue from the last step'
  if (G.contextTokens >= G.cfg.minContextTokens) {
    const d = lifecycle({ family: familyOf(G.model) ?? 'opus', contextTokens: G.contextTokens, baseTokens: G.baseTokens || 40_000, staleTokens: Math.max(0, Math.min(G.taskStartTokens, G.contextTokens) - (G.baseTokens || 40_000)), idleMs: 0, pCold: G.cfg.coldReturnRate, ttlMs: 3_600_000, horizon: G.cfg.horizon, taskClosed: G.closed, openFailures: Object.keys(t.failures).length }, G.cfg)
    await record($, { event: 'lifecycle', action: d.action, why: d.why, costs: d.costs, contextTokens: G.contextTokens })
    if (d.action !== 'continue') {
      const cp = await writeCheckpoint($, G.closed ? 'closed' : 'open', nextStep)
      // A clear drops the conversation, so it needs a valid checkpoint to hand over. A compaction keeps a summary in the
      // session itself, so it does not (a task that has just begun has no work state to checkpoint yet).
      const allowed = d.action === 'compact' || !!cp
      if (allowed && notifying() && shouldOffer(G.lastOffer, d.action, G.contextTokens)) { await offer($, d.action, d.costs, G.objective ?? ''); G.lastOffer = { action: d.action, contextTokens: G.contextTokens } }
      await persist($)
      await flushRecords($)
      G.view.continued = false
      await publish($)
      return
    }
  }
  // A checkpoint at every turn end of a large or just-finished task, so a /clear the person runs on their own still
  // has a handoff. A file write and two git reads; nothing is sent to a model.
  if (G.contextTokens >= G.cfg.minContextTokens || G.closed) await writeCheckpoint($, G.closed ? 'closed' : 'open', nextStep)
  await persist($)
  await flushRecords($)
  G.view.continued = false
  await publish($)
}

// offer: auto with autoCompact queues the compaction for the next prompt; otherwise the person gets the case in a toast
// (recommend) and the command in the prompt box, one key away (assist and above).
async function offer($: EngineInterface, action: 'compact' | 'clear', costs: { continue: number; compact: number; clear: number }, objective: string) {
  const save = `about $${(costs.continue - costs[action]).toFixed(2)} over the next requests`
  G.view.offer = { action, at: await now($), contextTokens: G.contextTokens, saves: save }
  G.view.last = { kind: action === 'clear' ? 'handoff advised' : 'compact advised', at: G.view.offer.at, why: action === 'clear' ? 'the task looks done on a large context' : 'most of the context is older than the task' }
  if (action === 'compact' && G.cfg.autoCompact && automatic()) {
    // Called from turn.complete after the turn has finished: the boundary the engine names for $.session.compact (a
    // prompt.submit hook holds the next turn and is refused; live check L6, 2026-10-26). A refusal or a veto falls back
    // to the suggestion below.
    try {
      const r: any = await $.session.compact({ instructions: `Keep the objective, the decisions, the files changed, the failing and passing checks, the restrictions, and the next step. Objective: ${objective}` })
      if (!r?.skip) {
        const before = G.contextTokens
        await record($, { event: 'compacted', contextBefore: before, saves: save })
        G.taskStartTokens = 0; G.lastOffer = null; G.view.offer = null
        G.contextTokens = (await readUsage($)).tokens || G.contextTokens
        if (notifying()) $.ui.toast(`AutoMode: compacted a ${Math.round(before / 1000)}k-token context after this turn (saves ${save}). Set guardian.autoCompact false to stop this.`)
        return
      }
      await record($, { event: 'compact-vetoed', skip: r.skip })
    } catch (err) {
      await record($, { event: 'compact-unavailable', error: String((err as Error)?.message ?? err).slice(0, 300) })
    }
  }
  if (assisting()) {
    try {
      const shown: any = await $.prompt.suggest({ text: action === 'clear' ? '/clear' : `/compact keep: ${objective.slice(0, 120)}` })
      await record($, { event: 'suggested', action, shown: shown?.isShown ?? null })
    } catch (err) { await record($, { event: 'suggest-unavailable', action, error: String((err as Error)?.message ?? err).slice(0, 200) }) }
  }
  $.ui.toast(action === 'clear'
    ? `AutoMode: this task looks done and the context is ${Math.round(G.contextTokens / 1000)}k tokens. A fresh session saves ${save}; the checkpoint is saved and restored if you continue the task. ${assisting() ? 'Tab, Enter to clear.' : 'Run /clear to start fresh.'}`
    : `AutoMode: most of this ${Math.round(G.contextTokens / 1000)}k context is old. Compacting saves ${save}. ${assisting() ? 'Tab, Enter to compact.' : 'Run /compact to shrink it.'}`)
}

async function git($: EngineInterface): Promise<{ branch: string | null; dirty: string[] }> {
  try {
    const b = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 })
    if (b.exitCode !== 0) return { branch: null, dirty: [] }
    const s = await $.process.run(['git', 'status', '--porcelain'], { timeoutMs: 5000 })
    return { branch: b.stdout.trim(), dirty: s.stdout.split('\n').map((l) => l.slice(3).trim()).filter(Boolean).slice(0, 40) }
  } catch { return { branch: null, dirty: [] } }
}

// writeCheckpoint: the task state on disk, outside the repository (the plugin data folder), with secrets blanked, sealed
// with a checksum, written and read back, owner-only. The previous good copy is kept as .prev.json.
async function writeCheckpoint($: EngineInterface, status: 'open' | 'closed', nextStep: string): Promise<Checkpoint | null> {
  if (!G.turn) return null
  const cp = buildCheckpoint({
    sessionId: G.sessionId, cwd: G.cwd, at: await now($), objective: G.objective ?? '', closed: status === 'closed', turn: G.turn,
    filesRead: G.filesRead, checks: G.checks, approvals: G.approvals, restrictions: G.restrictions, git: await git($), next: nextStep,
  })
  const v = validateCheckpoint(cp, cp.at, G.cwd)
  if (!v.ok) { await record($, { event: 'checkpoint-invalid', missing: v.missing }); return null }
  // observe and recommend record the checkpoint they would keep; assist and above write it.
  if (!assisting()) { await record($, { event: 'checkpoint-would-write', status: cp.status }); G.view.checkpoint = { at: cp.at, status: cp.status, sum: checkpointSum(cp).slice(0, 8), written: false }; return cp }
  const dir = await dataDir($)
  const file = sessionFile(dir, G.cwd, G.sessionId)
  try { const prev = await fsRead($, file); if (openCheckpoint(prev).cp) await writeDurable($, file.replace(/\.json$/, '.prev.json'), prev) } catch {}
  if (!(await writeDurable($, file, sealCheckpoint(cp)))) { await record($, { event: 'checkpoint-write-failed' }); return null }
  await tighten($, projectDir(dir, G.cwd), '700')
  await record($, { event: 'checkpoint', status: cp.status })
  G.view.checkpoint = { at: cp.at, status: cp.status, sum: checkpointSum(cp).slice(0, 8), written: true }
  return cp
}

// ---------------------------------------------------------------- the UI's view of the guardian (hooks/ui)

// guardianSnapshot: the guardian's state as the UI reads it. Copies; assesses nothing. An offer stops showing once the
// context fell well below the size it was made at (a compaction or a /clear outside the guardian).
export function guardianSnapshot(): GuardSnap {
  const on = lastEnabled
  const a = G.view.assess
  const offer = G.view.offer && G.contextTokens >= G.view.offer.contextTokens * 0.8 ? G.view.offer : null
  return {
    enabled: on, killed: killedByEnv, mode: G.cfg.mode, everySession: G.cfg.everySession,
    level: a?.level ?? 'normal', reasons: a?.reasons ?? [], outcomes: G.turn?.outcomes.length ?? 0,
    sinceOutcome: { requests: G.turn?.sinceOutcome.requests ?? 0, usd: G.turn?.sinceOutcome.usd ?? 0 },
    gates: { requests: G.cfg.warnRequests, usd: G.cfg.warnUsd }, turnUsd: G.turn ? G.turn.usd : null,
    checkpoint: G.view.checkpoint, offer, restored: G.view.restored, paused: G.view.paused, continued: G.view.continued, last: G.view.last,
    hardPause: G.cfg.hardPause, autoCompact: G.cfg.autoCompact, reduceOutputs: G.cfg.reduceOutputs,
  }
}
