#!/usr/bin/env node
// @ts-nocheck TODO(types): 11 errors with strict off. Fix them and delete this line to turn checking on for this file.
// Ask the real judges about the real prompts of the replay window, once, and cache the answers. The replay's
// `measured` regime then routes with these verdicts instead of an assumed class-to-verdict table.
//
//   node bench/retro-judge.mts [--days 30] [--from ISO] [--workload engineering]            # dry run: counts and estimate
//   node bench/retro-judge.mts --run --approve-usd 1.5 --batch final-2026-10-26 [--jobs 8]  # asks the missing verdicts
//
// What the router does, as in v4.ts decideAuto: a short follow-up that keeps the effort (upstream keepsEffort) asks no
// judge. Otherwise the AutoMode judge (config judgeVersion 2: JUDGE_SYSTEM, judgePrompt) and the effortless judge
// with the fixed anchor (A9) and the running model run; then at most one more effortless call for the model secondCall
// names. A plan exit is judged again with the router's PLAN_EXIT_NOTE. The Current effort follows A7: the running
// effort while the cache is warm (under an hour since the last request), else Anthropic's default.
// Every call goes through the ledger. The text of a prompt goes only to the judge, never into the cache file.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { parseLines } from './lib/transcripts.mts'
import { workloadOf, familyOf, rateOf } from './spend-audit.mts'
import { turnsOf } from './retro-replay.mts'
import { add, ensure, total } from './lib/ledger.mts'
import { JUDGE_SYSTEM as HM_SYSTEM, judgePrompt, parseJudge } from '../hooks/lib/classify.ts'
import { JUDGE_SYSTEM as EFF_SYSTEM, keepsEffort, parseVerdict } from '../hooks/lib/effortless.ts'
import { judgeInputFor, contextOf } from '../hooks/lib/effortless-adapt.ts'
import { firstCalls, secondCall, shortcutApplies } from '../hooks/lib/auto.ts'
import { tierOf } from '../hooks/lib/optimizer.ts'
import { DEFAULT_PARAMS } from '../hooks/lib/policy.ts'

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const RUN = args.includes('--run')
const END = Date.now(), START = opt('--from') ? Date.parse(opt('--from')) : END - Number(opt('--days', 30)) * 86_400_000
const WORKLOAD = opt('--workload', 'engineering')
const CAP = Number(opt('--approve-usd', 0)), BATCH = opt('--batch', 'retro-judge'), JOBS = Number(opt('--jobs', 8))
const ROOT = path.join(os.homedir(), '.claude/projects')
export const VERDICTS = path.join(path.dirname(new URL(import.meta.url).pathname), 'results', 'retro-verdicts.json')
const DEFAULT_EFFORT = { haiku: 'medium', sonnet: 'high', opus: 'medium' }
const HOUR = 3_600_000
const EST = 0.0006 // per call, from the ledger's earlier judge batches (0.0003 to 0.0005)
const CLAUDE = path.join(os.homedir(), '.local', 'bin', 'claude')
const PROFILE = path.join(os.homedir(), '.claude-ectest')
const PLAN_EXIT_NOTE = (acceptance) => `[The plan was approved and implementation starts. Judge the IMPLEMENTATION work the plan starts, not the planning. Acceptance: ${acceptance}]`

const textOf = (r) => { const c = r.message?.content; return typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '' }

// The judge points of one session: each turn start, and each approved plan exit, with the context the router reads.
export function judgePoints(file) {
  const L = parseLines(file)
  const turns = turnsOf(L)
  // The previous assistant text and user prompt before each moment, for the judges' context.
  const timeline = L.filter((r) => !r.isSidechain && (r.type === 'assistant' || r.type === 'user') && r.timestamp).map((r) => ({ at: Date.parse(r.timestamp), role: r.type, text: textOf(r) })).filter((m) => m.text.trim())
  const before = (at) => {
    const prior = timeline.filter((m) => m.at < at)
    const lastReply = prior.filter((m) => m.role === 'assistant').at(-1)?.text ?? ''
    const prevUser = prior.filter((m) => m.role === 'user').at(-1)?.text ?? ''
    return { lastReply, prevUser }
  }
  const points = []
  let lastAt = null, last = null
  for (const turn of turns) {
    const live = turn.steps.filter((s) => s.at >= START && s.at < END && rateOf(s.model))
    const first = turn.steps[0]
    if (live.length && turn.text !== null && first) {
      const running = { family: familyOf(first.model), effort: first.effort ?? 'medium' }
      const warm = lastAt !== null && turn.at - lastAt < HOUR && last?.family === running.family
      points.push({ key: `${path.basename(file, '.jsonl')}|${turn.at}`, at: turn.at, text: turn.text, plan: turn.plan, running, warm, prefix: first.tokens.cacheRead + first.tokens.cacheWrite1h + first.tokens.cacheWrite5m + first.tokens.input, ...before(turn.at) })
      const exit = turn.steps.findIndex((s) => s.planExit)
      if (turn.plan && exit >= 0 && exit < turn.steps.length - 1) {
        const s = turn.steps[exit + 1]
        points.push({ key: `${path.basename(file, '.jsonl')}|${s.at}|exit`, at: s.at, text: PLAN_EXIT_NOTE(turn.text.replace(/\s+/g, ' ').slice(0, 300)), plan: false, running: { family: familyOf(s.model), effort: s.effort ?? 'medium' }, warm: true, prefix: s.tokens.cacheRead + s.tokens.cacheWrite1h, exit: true, lastReply: '', prevUser: turn.text })
      }
    }
    const lastStep = turn.steps.at(-1)
    if (lastStep) { lastAt = lastStep.at; last = { family: familyOf(lastStep.model) } }
  }
  return points
}

function sessions() {
  const out = []
  for (const project of fs.readdirSync(ROOT)) {
    if (workloadOf(ROOT, project) !== WORKLOAD) continue
    let files = []
    try { files = fs.readdirSync(path.join(ROOT, project)).filter((f) => f.endsWith('.jsonl')) } catch { continue }
    for (const f of files) { const file = path.join(ROOT, project, f); if (fs.statSync(file).mtimeMs >= START) out.push(file) }
  }
  return out
}

// One judge call through the CLI, the same flags as lib/haiku-call.mts, but asynchronous so that several run at once.
function call(system, prompt, what) {
  ensure(EST, CAP, BATCH)
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-rj-'))
  return new Promise((resolve) => {
    const p = spawn(CLAUDE, ['-p', prompt, '--model', 'claude-haiku-5-5', '--system-prompt', system, '--tools', '', '--disable-slash-commands', '--setting-sources', '', '--strict-mcp-config', '--output-format', 'json', '--no-session-persistence'], {
      cwd: empty, env: { ...process.env, CLAUDE_CONFIG_DIR: PROFILE, CLAUDE_CODE_USE_VERTEX: '0' },
    })
    let out = ''
    const timer = setTimeout(() => p.kill(), 60_000)
    p.stdout.on('data', (d) => { out += d })
    p.on('close', () => {
      clearTimeout(timer)
      let j = {}
      try { j = JSON.parse(out) } catch {}
      const usd = Number(j.total_cost_usd ?? 0)
      add({ batch: BATCH, what, usd, model: 'claude-haiku-5-5', source: 'cli total_cost_usd' })
      fs.rmSync(empty, { recursive: true, force: true })
      resolve({ text: String(j.result ?? ''), ok: !j.is_error && typeof j.result === 'string', usd })
    })
  })
}

// judgeOne: the router's protocol for one point. Returns the cached record (no prompt text in it).
async function judgeOne(pt) {
  const ctxMsgs = [...(pt.prevUser ? [{ role: 'user', text: pt.prevUser.slice(0, 2000) }] : []), ...(pt.lastReply ? [{ role: 'assistant', text: pt.lastReply.slice(0, 2000) }] : [])]
  if (!pt.exit && shortcutApplies(keepsEffort(pt.text, contextOf(ctxMsgs)), pt.text, { required: false })) return { shortcut: true }
  const allowed = ['sonnet', 'opus', ...(pt.prefix && pt.prefix <= DEFAULT_PARAMS.haikuMaxContext ? ['haiku'] : [])]
  const families = firstCalls(undefined, allowed.includes(pt.running.family) ? pt.running.family : undefined)
  const anchor = families[0]
  const effortFor = (f) => (f === pt.running.family && pt.warm ? pt.running.effort : DEFAULT_EFFORT[f])
  const askEff = async (f) => {
    const r = await call(EFF_SYSTEM, judgeInputFor(pt.text, { family: f, effort: effortFor(f), messages: ctxMsgs, planMode: pt.plan }), 'retro-judge effortless')
    const v = r.ok ? parseVerdict(r.text) ?? null : null
    if (!v && process.env.RJ_DEBUG) console.log('effortless unparsed:', r.ok, JSON.stringify(r.text.slice(0, 160)))
    return v
  }
  const hmCall = pt.exit ? Promise.resolve(null) : call(HM_SYSTEM, judgePrompt(pt.text, { lastReply: pt.lastReply, current: `${tierOf(pt.running.family, pt.running.effort)} ${pt.running.family} ${pt.running.effort}` }), 'retro-judge automode')
  const [hmR, ...asked] = await Promise.all([hmCall, ...families.map(askEff)])
  const a = asked[0]
  const hmA = hmR?.ok ? parseJudge(hmR.text) : null
  const hm = hmA ? { tier: hmA.tier, complexity: hmA.complexity, effort: hmA.effort, confidence: hmA.confidence } : null
  const verdicts = Object.fromEntries(families.map((f, i) => [f, asked[i]]))
  const second = a ? secondCall({ allowed, verdicts: Object.fromEntries(Object.entries(verdicts).filter(([, v]) => v)), need: a, hm, floors: { because: [] }, current: null, cost: () => 0 }, anchor) : null
  if (second) verdicts[second] = await askEff(second)
  const clean = (v) => (v ? { model: v.model, effort: v.effort } : null)
  return { anchor, allowed, hm, verdicts: Object.fromEntries(Object.entries(verdicts).map(([k, v]) => [k, clean(v)])), calls: (pt.exit ? 0 : 1) + families.length + (second ? 1 : 0) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cache = fs.existsSync(VERDICTS) ? JSON.parse(fs.readFileSync(VERDICTS, 'utf8')) : {}
  const points = sessions().flatMap(judgePoints).filter((p) => !(p.key in cache))
  const quick = points.filter((p) => !p.exit && shortcutApplies(keepsEffort(p.text, contextOf([{ role: 'assistant', text: p.lastReply.slice(0, 2000) }])), p.text, { required: false })).length
  console.log(`${points.length} judge points to ask (${quick} short follow-ups ask no judge); about ${((points.length - quick) * 2.4 * EST).toFixed(2)} USD at ${EST} per call`)
  if (!RUN) process.exit(0)
  let i = 0, done = 0
  const worker = async () => {
    while (i < points.length) {
      const pt = points[i++]
      try { cache[pt.key] = await judgeOne(pt) } catch (e) { if (/ledger/.test(String(e))) { console.log(String(e)); i = points.length; return } cache[pt.key] = { error: String(e).slice(0, 100) } }
      if (++done % 25 === 0) { fs.writeFileSync(VERDICTS, JSON.stringify(cache)); console.log(`${done}/${points.length}, batch ${BATCH} $${total(undefined, BATCH).toFixed(3)}`) }
    }
  }
  await Promise.all(Array.from({ length: JOBS }, worker))
  fs.writeFileSync(VERDICTS, JSON.stringify(cache))
  console.log(`done ${done}; batch ${BATCH} $${total(undefined, BATCH).toFixed(3)}`)
}
