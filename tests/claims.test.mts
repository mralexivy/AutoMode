// Pins the public benchmark claims to the committed rows. bench/results/headline.json names each number, the rows it
// comes from and the pages that must show it. A benchmark run, a release or a docs edit that leaves a page behind fails
// here. See .claude/skills/publish-results.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const read = (p: string) => readFileSync(new URL(p, root), 'utf8')
const head = JSON.parse(read('bench/results/headline.json'))
const rows = (p: string) => read(p).trim().split('\n').map((l) => JSON.parse(l))
const usd = (r: any) => (r.cost_usd_api_equiv ?? 0) + (r.judge?.usd ?? 0)

test('each headline number is what its rows add up to', () => {
  for (const [name, m] of Object.entries<any>(head.mixed)) {
    const mine = rows(m.rows).filter((r) => r.arm === m.arm)
    assert.ok(mine.length > 0, `${name}: no rows for ${m.arm} in ${m.rows}`)
    assert.ok(mine.every((r) => r.accepted), `${name}: a step failed, so the table's pass count is wrong`)
    assert.equal(`$${mine.reduce((a, r) => a + usd(r), 0).toFixed(2)}`, m.shown, `${name} total in ${m.rows}`)
  }
})

test('every public surface shows every headline number', () => {
  for (const s of head.surfaces) {
    const text = read(s)
    for (const [name, m] of Object.entries<any>(head.mixed)) assert.ok(text.includes(m.shown), `${s} does not show ${name} ${m.shown}`)
  }
})

test('no tracked doc or page carries a stale claim', () => {
  const files = execFileSync('git', ['ls-files', '*.md', '*.html'], { cwd: root, encoding: 'utf8' }).split('\n')
    .filter((f) => f && !/^(CHANGELOG\.md|bench\/(external|results|experiments)\/|\.claude\/skills\/publish-results\/)/.test(f))
  for (const f of files) {
    const text = read(f)
    for (const b of head.banned) assert.ok(!text.includes(b), `${f} still says "${b}"`)
  }
})
