// Long-context tasks at controlled distance. The answer needs facts spread across a chain of documents, one naming the
// next, so how far the agent must read is set by the tier. A shell can still shortcut the walk, so a report groups by the
// measured peak prompt size as well as the tier. Everything comes from a seed, so each tier is the same for every arm.
import type { RepoPlan } from '../datasets/codegen.mts'
import { rng } from '../lib/stats.mts'

export const TIERS = [32_000, 100_000, 200_000, 400_000, 800_000]
const FILE_TOKENS = 8000
const CHARS_PER_TOKEN = 4
const WORDS = ['ledger', 'rotation', 'quorum', 'replica', 'shard', 'window', 'cursor', 'segment', 'manifest', 'retention', 'checkpoint', 'batch', 'stream', 'offset', 'tenant', 'region']

export function longctxPlan(tier: number, seed = 1): RepoPlan {
  const r = rng(seed * tier)
  const pick = () => WORDS[Math.floor(r() * WORDS.length)]
  const prose = (chars: number) => {
    let s = ''
    while (s.length < chars) s += `The ${pick()} service keeps its ${pick()} near the ${pick()} so that a ${pick()} can recover after a ${pick()} ends.\n`
    return s
  }
  const steps = Math.max(2, Math.round(tier / FILE_TOKENS))
  const files: Record<string, string> = { 'package.json': '{"type":"module"}\n', 'code.js': 'export const code = (x) => x\n' }
  const rules: ((x: number) => number)[] = []
  const ops: string[] = []
  let formula = 'x'
  for (let i = 0; i < steps; i++) {
    const n = 1 + Math.floor(r() * 9)
    const add = r() < 0.5
    rules.push(add ? (x) => x + n : (x) => x * n % 100_003)
    formula = add ? `(${formula} + ${n})` : `(${formula} * ${n} % 100003)`
    ops.push(add ? `add ${n}` : `multiply by ${n}, then take the remainder after dividing by 100003`)
  }
  ops.forEach((op, i) => {
    const before = prose(FILE_TOKENS * CHARS_PER_TOKEN / 2), after = prose(FILE_TOKENS * CHARS_PER_TOKEN / 2)
    const next = i + 1 < steps ? `The next rule is in docs/rule-${String(i + 1).padStart(4, '0')}.md.` : 'This is the last rule.'
    files[`docs/rule-${String(i).padStart(4, '0')}.md`] = `${before}\nRule ${i + 1}: ${op}. ${next}\n\n${after}`
  })
  const expected = (x: number) => rules.reduce((v, rule) => rule(v), x)
  return {
    id: `longctx-${tier}`, prompt: `code(x) in code.js must start from x and apply every rule in order. The first rule is in docs/rule-0000.md, and each rule names the next one. Implement it for any integer x from 0 to 1000.`,
    baseFiles: files, hiddenFile: 'hidden.test.js', solution: { 'code.js': `export const code = (x) => ${formula}\n` },
    hiddenText: `import assert from 'node:assert/strict'\nimport { code } from './code.js'\n${[7, 11, 523].map((x) => `assert.equal(code(${x}), ${expected(x)})`).join('\n')}\n`, accept: 'node hidden.test.js', source: 'automode-longctx', dataset: 'automode-longctx', revision: 'v1',
  }
}
