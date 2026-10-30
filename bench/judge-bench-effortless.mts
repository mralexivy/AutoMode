#!/usr/bin/env node
// @ts-nocheck TODO(types): 3 errors with strict off. Fix them and delete this line to turn checking on for this file.
// The effortless judge on upstream's own labeled cases (bench/external/effortless/judge-cases.json, 75 cases, 20
// held out), scored with upstream benchGrade. Default is a DRY RUN: it prints the plan and the estimate, spends nothing.
//
//   node bench/judge-bench-effortless.mts                                   # dry run
//   node bench/judge-bench-effortless.mts --run --approve-usd 0.5 --batch 2026-10-25
//
// Arms:
//   always medium, always high   upstream's fixed baselines (no calls)
//   upstream                     upstream runBench: a short follow-up keeps the current effort (keepsEffort), every
//                                other case asks Haiku 5.5 with JUDGE_SYSTEM and judgeQuestion(message, current, context)
//   automode-auto               the same judge input through AutoMode's adaptation (judgeInputFor) and resolution steps
//                                4 and 5: the shortcut never keeps an acknowledgment, a commit or an approval
// One call serves both judged arms when their inputs are the same. Label agreement is a proxy, not task quality.
import fs from 'node:fs'
import path from 'node:path'
import { benchGrade, JUDGE_SYSTEM, judgeQuestion, keepsEffort, parseVerdict } from '../hooks/lib/effortless.ts'
import { judgeInputFor } from '../hooks/lib/effortless-adapt.ts'
import { shortcutApplies } from '../hooks/lib/auto.ts'
import { transitionOf } from '../hooks/lib/transition.ts'
import { haikuCall } from './lib/haiku-call.mts'
import { total } from './lib/ledger.mts'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const argv = process.argv.slice(2)
const val = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined)
const cap = Number(val('--approve-usd') ?? 0)
const batch = val('--batch') ?? new Date().toISOString().slice(0, 10)
const PER_CALL = 0.0025 // estimate per Haiku call through the CLI; the ledger records the real cost

export const cases = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'external', 'effortless', 'judge-cases.json'), 'utf8')).cases
const lastReplyOf = (context) => (String(context ?? '').split('\nassistant: ').pop() ?? '').replace(/^assistant: /, '')
const messagesOf = (context) => String(context ?? '').split('\n').reduce((out, line) => {
  const m = line.match(/^(user|assistant): ([\s\S]*)$/)
  if (m) out.push({ role: m[1], text: m[2] })
  else if (out.length) out[out.length - 1].text += `\n${line}`
  return out
}, [])

// plan: per case, what each judged arm does (keep or ask) and the exact judge input.
export function plan() {
  return cases.map((c) => {
    const ctx = c.context ?? ''
    const upKeeps = keepsEffort(c.message, ctx)
    const approves = transitionOf(c.message, lastReplyOf(ctx)).kind === 'begin-approved'
    const hmKeeps = shortcutApplies(upKeeps, c.message, { required: false }) && !approves
    return {
      c,
      upstream: upKeeps ? { keep: true } : { input: judgeQuestion(c.message, c.current, ctx) },
      auto: hmKeeps ? { keep: true } : { input: judgeInputFor(c.message, { family: c.current.model, effort: c.current.effort, messages: messagesOf(ctx) }) },
    }
  })
}

function report(answers) {
  const arms = [...new Set(answers.map((a) => a.arm))]
  const byId = new Map(cases.map((c) => [c.id, c]))
  const pct = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : '-')
  const lines = ['| Arm | Right | Too low | Too high | No answer | Held out right |', '| --- | --- | --- | --- | --- | --- |']
  for (const arm of arms) {
    const mine = answers.filter((a) => a.arm === arm)
    const g = mine.map((a) => benchGrade(byId.get(a.id), a.effort))
    const n = (k) => g.filter((x) => x === k).length
    const ho = mine.filter((a) => byId.get(a.id).holdout)
    lines.push(`| ${arm} | ${pct(n('hit'), g.length)} (${n('hit')}/${g.length}) | ${n('under')} | ${n('over')} | ${n('none')} | ${pct(ho.filter((a) => benchGrade(byId.get(a.id), a.effort) === 'hit').length, ho.length)} (${ho.length}) |`)
  }
  const diff = cases.filter((c) => answers.find((a) => a.arm === 'upstream' && a.id === c.id)?.effort !== answers.find((a) => a.arm === 'automode-auto' && a.id === c.id)?.effort)
  lines.push('', `Cases where the two judged arms differ: ${diff.length}`, ...diff.map((c) => `- ${c.id} (${c.kind}): upstream ${answers.find((a) => a.arm === 'upstream' && a.id === c.id)?.effort}, auto ${answers.find((a) => a.arm === 'automode-auto' && a.id === c.id)?.effort}, labels ${c.ok.join('/')}: "${c.message.slice(0, 50)}"`))
  return lines.join('\n')
}

async function main() {
  const p = plan()
  const inputs = new Map()
  for (const r of p) for (const arm of ['upstream', 'auto']) if (!r[arm].keep) inputs.set(r[arm].input, null)
  console.log(`Effortless judge bench: ${cases.length} cases (${cases.filter((c) => c.holdout).length} held out). Unique judge calls: ${inputs.size}. Estimate $${(inputs.size * PER_CALL).toFixed(3)}. Ledger total in batch ${batch}: $${total(undefined, batch).toFixed(4)}.`)
  if (!argv.includes('--run')) { console.log('Dry run: nothing was spent. Run with --run --approve-usd <amount> --batch <id>.'); return }
  for (const input of inputs.keys()) {
    const r = haikuCall(JUDGE_SYSTEM, input, { cap, batch, what: 'judge-bench-effortless', estimate: PER_CALL })
    inputs.set(input, r.ok ? parseVerdict(r.text) ?? null : null)
  }
  // Every call failed: the table would read as a very bad judge, so stop and write no result.
  if (![...inputs.values()].some(Boolean)) throw new Error('No judge call returned a verdict. Check that claude runs and is signed in. No result was written.')
  const answers = []
  for (const r of p) {
    for (const fixed of ['medium', 'high']) answers.push({ id: r.c.id, arm: `always ${fixed}`, effort: fixed })
    answers.push({ id: r.c.id, arm: 'upstream', effort: r.upstream.keep ? r.c.current.effort : inputs.get(r.upstream.input)?.effort, model: r.upstream.keep ? undefined : inputs.get(r.upstream.input)?.model })
    answers.push({ id: r.c.id, arm: 'automode-auto', effort: r.auto.keep ? r.c.current.effort : inputs.get(r.auto.input)?.effort, model: r.auto.keep ? undefined : inputs.get(r.auto.input)?.model })
  }
  const out = path.join(REPO, 'bench', 'results', `judge-bench-effortless-${batch}.json`)
  fs.writeFileSync(out, JSON.stringify({ batch, spentUsd: total(undefined, batch), answers }, null, 1) + '\n')
  console.log(report(answers))
  console.log(`\nAnswers: ${path.relative(REPO, out)}. Ledger total in batch ${batch}: $${total(undefined, batch).toFixed(4)}.`)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1) })
