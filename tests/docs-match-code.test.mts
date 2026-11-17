// Keeps the docs in step with what ships. A reviewer found the README saying one Haiku call per prompt and calling
// guardian actions opt-in while config.json turned them on. This test reads config.json and fails when the README or
// the guardian page leaves out an action that ships on, or when the README drops the behavior notes below.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const read = (p: string) => readFileSync(new URL(p, root), 'utf8')
const config = JSON.parse(read('config.json'))
const section = (text: string, heading: string) => {
  const start = text.indexOf(heading)
  assert.ok(start >= 0, `no "${heading}" heading`)
  const next = text.indexOf('\n## ', start + heading.length)
  return text.slice(start, next < 0 ? undefined : next)
}

test('the README guardian section says which guardian actions ship on', () => {
  const guardian = section(read('README.md'), '## Guardian')
  assert.ok(guardian.includes(`\`${config.guardian.mode}\``), `the README does not name the shipped guardian mode ${config.guardian.mode}`)
  for (const key of ['reduceOutputs', 'hardPause', 'autoCompact'] as const) {
    if (config.guardian[key] !== true) continue
    assert.ok(new RegExp(`\`${key}\`, on`).test(guardian), `config.json ships ${key} on, and the README guardian section does not say "\`${key}\`, on"`)
  }
})

test('the guardian page lists every shipped default', () => {
  const page = read('site/content/docs/concepts/guardian.mdx')
  for (const key of ['mode', 'everySession', 'hardPause', 'autoCompact', 'reduceOutputs']) {
    const row = page.split('\n').find((l) => l.startsWith(`| \`guardian.${key}\``))
    assert.ok(row, `the guardian page has no row for guardian.${key}`)
    assert.ok(row.includes(`\`${config.guardian[key]}\``), `guardian.${key}: the page default differs from config.json (${config.guardian[key]})`)
  }
})

test('the README states the behaviors a reviewer asked for', () => {
  const readme = read('README.md')
  for (const [needle, why] of [
    ['set -o pipefail', 'the command rewrite'],
    ['2 to 4 calls', 'the judge call count'],
    ['It can change the model in the middle of a chat', 'mid-chat model changes'],
    ['`/model`', 'pinning with /model'],
    ['`AUTOMODE_ROUTER=off`', 'turning routing off'],
  ] as const) assert.ok(readme.includes(needle), `the README no longer covers ${why}`)
  assert.ok(!readme.includes('One short Haiku call per prompt'), 'the README again claims one Haiku call per prompt')
})
