#!/usr/bin/env node
// Output style check: does the Concise style save output tokens without damaging anything that is not prose?
//
// Two arms, same model, same prompt, no tools, an empty working folder, an isolated test profile:
//   control   no output style
//   style     the Concise output style (outputStyle "automode:Concise", loaded from this repository)
// Each case in bench/style-cases.json has deterministic checks (lib/style-check.mjs). Hard groups are code, verbatim,
// calibration and safety: a case where the control passes every repeat and the style fails one is a regression.
// The facts group is soft: mean recall may drop by at most 0.1. The report also gives output tokens per arm.
//
//   node bench/style-check.mjs --dry                      list the cases and the call count, spend nothing
//   node bench/style-check.mjs --approve-usd 3            run it (paid, capped by the ledger)
//   options: --model <id> (default claude-sonnet-5-5)  --reps <n> (default 3)  --only <group>  --case <id,id>  --tag <suffix for the report files>
//
// What it does not show: it uses short single-turn prompts through `claude -p` with no tools. Long agentic sessions,
// other models and other languages need their own runs. 20 cases is a small set.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { add, ensure } from './lib/ledger.mjs'
import { compareArms, median, scoreCase } from './lib/style-check.mjs'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const CLAUDE = process.env.CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude')
const PROFILE = process.env.STYLE_CHECK_PROFILE || path.join(os.homedir(), '.claude-ectest')
const STYLE = 'automode:Concise'

const argv = process.argv.slice(2)
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback }
const model = opt('model', 'claude-sonnet-5-5')
const reps = Number(opt('reps', 3))
const only = opt('only', null)
const onlyCase = opt('case', null)
const tag = opt('tag', '')
const cap = Number(opt('approve-usd', 0))
const ESTIMATE = 0.03 // per call, checked against the cap before each call

const all = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'style-cases.json'), 'utf8')).cases
const cases = all.filter((c) => (!only || c.group === only) && (!onlyCase || onlyCase.split(',').includes(c.id)))
const calls = cases.length * reps * 2

if (argv.includes('--dry')) {
  for (const c of cases) console.log(`${c.group.padEnd(12)} ${c.hard ? 'hard' : 'soft'}  ${c.id}`)
  console.log(`\n${cases.length} cases x ${reps} repeats x 2 arms = ${calls} calls on ${model}. Estimate $${(calls * ESTIMATE).toFixed(2)}. Nothing was run.`)
  process.exit(0)
}
if (!(cap > 0)) { console.error('Refusing to spend: pass --approve-usd <amount>. Use --dry to see the plan.'); process.exit(2) }
if (!fs.existsSync(CLAUDE)) { console.error(`claude CLI not found at ${CLAUDE}. Set CLAUDE_BIN.`); process.exit(2) }

const batch = `style-${new Date().toISOString().slice(0, 10)}`
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'style-check-'))

function call(arm, prompt) {
  ensure(ESTIMATE, cap, batch)
  const settings = path.join(empty, `${arm}.json`)
  fs.writeFileSync(settings, JSON.stringify(arm === 'style' ? { outputStyle: STYLE } : {}))
  const r = spawnSync(CLAUDE, ['-p', prompt, '--model', model, '--output-format', 'json', '--setting-sources', 'project', '--settings', settings,
    '--strict-mcp-config', '--tools', '', '--plugin-dir', REPO], {
    cwd: empty, encoding: 'utf8', timeout: 120_000, maxBuffer: 1e7,
    env: { ...process.env, CLAUDE_CONFIG_DIR: PROFILE, CLAUDE_CODE_USE_VERTEX: '0' },
  })
  let j = {}
  try { j = JSON.parse(r.stdout) } catch {}
  const usd = Number(j.total_cost_usd ?? 0)
  add({ batch, what: `style-check ${arm}`, usd, model, source: 'cli total_cost_usd' })
  const out = j.usage?.output_tokens ?? Object.values(j.modelUsage ?? {}).reduce((a, u) => a + (u.outputTokens ?? 0), 0)
  return { text: String(j.result ?? ''), outTokens: out || NaN, usd, ok: !j.is_error && typeof j.result === 'string' }
}

const rows = []
for (const c of cases) {
  for (let rep = 0; rep < reps; rep++) {
    for (const arm of ['control', 'style']) {
      const r = call(arm, c.prompt)
      const s = r.ok ? scoreCase(c, r.text) : { ok: false, recall: null, results: [{ type: 'call', ok: false, why: 'the call failed' }] }
      rows.push({ caseId: c.id, group: c.group, hard: c.hard, arm, rep, ok: s.ok, recall: s.recall, outTokens: r.outTokens, usd: r.usd, why: s.results.filter((x) => !x.ok).map((x) => `${x.type}: ${x.why}`) })
      process.stdout.write(`${c.id} ${arm} #${rep} ${s.ok ? 'pass' : 'FAIL'} ${r.outTokens} tok\n`)
    }
  }
}

const verdict = compareArms(rows)
const date = new Date().toISOString().slice(0, 10)
const dir = path.join(REPO, 'bench', 'results')
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, `style-check-${date}${tag}.json`), JSON.stringify({ date, model, reps, style: STYLE, verdict, rows }, null, 2))

const pct = (x) => (x === null || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(0)}%`)
const md = [
  `# Output style check, ${date}`, '',
  `Model ${model}, ${reps} repeats, ${cases.length} cases, ${rows.length} calls, spend $${rows.reduce((a, r) => a + r.usd, 0).toFixed(3)}.`, '',
  `**Verdict: ${verdict.safe ? 'no regression found' : 'REGRESSION FOUND'}.**`, '',
  `- Output tokens, style against control: median per case ${pct(verdict.tokens.medianRatio)}, total ${pct(verdict.tokens.totalRatio)}.`,
  `- Fact recall: control ${pct(verdict.factRecall.control)}, style ${pct(verdict.factRecall.style)}.`,
  `- Hard regressions: ${verdict.regressions.length}.`, '',
  ...(verdict.regressions.length ? ['## Regressions', '', ...verdict.regressions.map((r) => `- ${r.caseId} (${r.group}): style failed ${r.failed} of ${r.of} repeats, control passed all`), ''] : []),
  '## Tokens per case', '', '| Case | Control | Style | Ratio |', '|---|---|---|---|',
  ...verdict.tokens.cases.map((t) => `| ${t.caseId} | ${t.control} | ${t.style} | ${pct(t.ratio)} |`), '',
  '## Limits', '',
  '- Short single-turn prompts, no tools. Long agentic sessions are not covered.',
  '- One model. Small case set. Runs differ by a few points.',
].join('\n')
fs.writeFileSync(path.join(dir, `style-check-${date}${tag}.md`), md + '\n')
console.log(`\n${md}`)
process.exit(verdict.safe ? 0 : 1)
