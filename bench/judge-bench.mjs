#!/usr/bin/env node
// Judge accuracy benchmark. Runs every labeled case in bench/judge-cases.json through the exact
// JUDGE_SYSTEM prompt from hooks/register.ts on Haiku, applies the router's own
// risk rule, and scores path and effort against the labels. Each call is a bare `claude -p` with no
// tools, run from an empty folder, so it costs a fraction of a cent.
//
// Usage: node bench/judge-bench.mjs [--policy risk|never|always] [--parallel 4] [--out bench/results/judge.jsonl]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const opt = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const policy = opt('policy', 'risk')
const parallelRuns = Number(opt('parallel', 4))
const out = opt('out', path.join(REPO, 'bench', 'results', `judge-${policy}.jsonl`))

const router = fs.readFileSync(path.join(REPO, 'hooks', 'register.ts'), 'utf8')
const SYSTEM = router.match(/export const JUDGE_SYSTEM = `([\s\S]*?)`/)[1]
const RISK = [...router.matchAll(/\{ reason: '([^']+)', text: \/(.*?)\/i \}/g)].map((m) => ({ reason: m[1], re: new RegExp(m[2], 'i') }))
const cases = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'judge-cases.json'), 'utf8')).cases
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-judge-'))

function judge(text) {
  return new Promise((resolve) => {
    const started = Date.now()
    const args = ['-p', `Message:\n${text}`, '--model', 'haiku', '--system-prompt', SYSTEM, '--tools', '', '--output-format', 'json',
      '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence']
    const child = spawn('claude', args, { cwd: empty, env: { ...process.env, CLAUDE_CODE_USE_VERTEX: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let s = ''
    child.stdout.on('data', (d) => { s += d })
    child.on('close', () => {
      let j = {}
      try { j = JSON.parse(s) } catch {}
      resolve({ reply: j.result ?? '', cost: j.total_cost_usd ?? null, ms: Date.now() - started })
    })
  })
}

// The router's rules, applied in code exactly as hooks/register.ts does.
function applyRules(v, text) {
  const words = text.replace(/\S+\.[A-Za-z]{1,5}\b/g, ' ') // as register.ts risksOf: file names are not risk words
  const risks = RISK.filter((r) => r.re.test(words)).map((r) => r.reason)
  if (policy === 'never') return { ...v, path: v.path === 'review' ? 'change' : v.path, risks }
  let p = v.path
  if (risks.length && p === 'change') p = 'review'
  if (policy === 'always' && p === 'change') p = 'review'
  return { ...v, path: p, risks }
}

function parse(reply) {
  const m = String(reply).match(/\{[\s\S]*\}/)
  try { const j = JSON.parse(m[0]); return { path: j.path, effort: j.effort, why: j.why } } catch { return null }
}

const rows = []
let next = 0
async function worker() {
  while (next < cases.length) {
    const c = cases[next++]
    const r = await judge(c.text)
    // No verdict: score what the router does then, its fallback of change at medium effort.
    const v = parse(r.reply) ?? { path: 'change', effort: 'medium', why: 'judge unavailable', fallback: true }
    const routed = applyRules(v, c.text)
    const okPaths = policy === 'never' ? c.paths.map((p) => (p === 'review' ? 'change' : p)) : c.paths
    rows.push({ id: c.id, held_out: c.id >= 31, preregistered: c.id >= 41, risk: Boolean(c.risk), text: c.text, judged: v, routed, path_ok: Boolean(routed && okPaths.includes(routed.path)),
      effort_ok: Boolean(v && c.efforts.includes(v.effort)), too_cheap: Boolean(c.risk && routed && routed.path === 'change' && policy !== 'never'), cost: r.cost, ms: r.ms })
  }
}
await Promise.all(Array.from({ length: parallelRuns }, worker))
rows.sort((a, b) => a.id - b.id)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')

const pct = (xs) => (xs.length ? `${Math.round((100 * xs.filter(Boolean).length) / xs.length)}%` : 'n/a')
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
const all = rows, held = rows.filter((r) => r.held_out)
console.log(`Judge benchmark, policy ${policy}: ${rows.length} cases (${held.length} held out). Failed parses: ${rows.filter((r) => !r.judged).length}.`)
console.log(`| Set | Path right | Effort right | Both right | Risk cases left on change |`)
console.log(`|---|---:|---:|---:|---:|`)
for (const [name, set] of [['all', all], ['held out (31-80)', held], ['pre-registered (41-80)', rows.filter((r) => r.preregistered)]]) {
  console.log(`| ${name} | ${pct(set.map((r) => r.path_ok))} | ${pct(set.map((r) => r.effort_ok))} | ${pct(set.map((r) => r.path_ok && r.effort_ok))} | ${set.filter((r) => r.too_cheap).length} |`)
}
const costs = rows.map((r) => r.cost).filter(Number.isFinite)
console.log(`\nCost: $${costs.reduce((a, b) => a + b, 0).toFixed(4)} for ${costs.length} calls through claude -p (the in-session judge is cheaper: no CLI system prompt). Median ${median(rows.map((r) => r.ms))} ms per call, CLI start-up included.`)
const misses = rows.filter((r) => !r.path_ok || !r.effort_ok)
if (misses.length) {
  console.log('\nMisses:')
  for (const r of misses) console.log(`  #${r.id}${r.held_out ? ' (held out)' : ''} "${r.text.slice(0, 70)}": got ${r.routed ? `${r.routed.path}/${r.judged.effort}` : 'no verdict'}`)
}
