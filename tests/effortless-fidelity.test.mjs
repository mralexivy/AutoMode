// Fidelity of the effortless port (hooks/lib/effortless.ts) to the vendored upstream source.
//   1 The vendored files match the sha256 values in bench/external/effortless/PROVENANCE.md.
//   2 Each ported declaration has the same code as upstream hooks/register.tsx (comments and whitespace aside).
//   3 Upstream's own test cases for these functions (tests/effortless.test.ts at the pinned commit) pass twice:
//     once on the declarations extracted from the vendored original, once on the port.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const up = path.join(root, 'bench/external/effortless/upstream')
const portFile = path.join(here, '../hooks/lib/effortless.ts')
const UPSTREAM = fs.readFileSync(path.join(up, 'hooks_register.tsx'), 'utf8')
const PORT = fs.readFileSync(portFile, 'utf8')

// The declarations copied without a change to their code.
const COPIED = ['MODELS', 'EFFORTS', 'cacheSafe', 'JUDGE_SYSTEM', 'parseVerdict', 'contextFrom', 'lastAssistantText', 'isFollowUp', 'endsOnQuestion', 'withAttachments', 'withMidTurn', 'keepsEffort', 'judgeFailure', 'judgeQuestion', 'REDO_RE', 'REDO_STAY_PROMPTS', 'looksLikeRedo', 'tipped', 'bounded', 'helperQuestion', 'helperFloor', 'benchGrade']
// Type-only differences, each named: upstream types `current` as its own Pick (types/index.d.ts), which carries more fields.
const TYPE_ONLY = { judgeQuestion: [['current: { model: ModelKey; effort: Effort } | null', 'current: Pick | null']] }

// extract returns one top-level declaration's source text.
function extract(src, name) {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^(export )?(async )?(function|const|let) ${name}\\b`).test(l))
  if (start < 0) return null
  const first = lines[start]
  const out = [first]
  const done = (l) => (/^(export )?(async )?function /.test(first) ? l === '}' : first.trimEnd().endsWith('[') ? l === ']' : (first.match(/`/g) ?? []).length % 2 === 1 ? l.trimEnd().endsWith('`') : true)
  if (done(first) && !/^(export )?(async )?function /.test(first) && !first.trimEnd().endsWith('[') && (first.match(/`/g) ?? []).length % 2 === 0) return first
  for (let i = start + 1; i < lines.length; i++) {
    out.push(lines[i])
    if (done(lines[i])) break
  }
  return out.join('\n')
}
// code: the declaration without comments, `export`, and runs of whitespace.
const code = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\/\*\*|\*)/.test(l)).join('\n').replace(/^export /, '').replace(/\s+/g, ' ').trim()

test('vendored upstream files match PROVENANCE.md', () => {
  const prov = fs.readFileSync(path.join(root, 'bench/external/effortless/PROVENANCE.md'), 'utf8')
  const rows = [...prov.matchAll(/^\| `([^`]+)` \| `[^`]+` \| `([0-9a-f]{64})` \|$/gm)]
  assert.ok(rows.length >= 8)
  for (const [, file, sum] of rows) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(up, file))).digest('hex'), sum, file)
  assert.match(prov, /e5c590dfd9402244ea66a8bf795d1cb86d1df7b9/)
  assert.equal(fs.readFileSync(path.join(root, 'hooks/lib/LICENSE.effortless'), 'utf8'), fs.readFileSync(path.join(up, 'LICENSE'), 'utf8'))
  assert.match(PORT, /Copyright \(c\) 2026 HeyCubit/)
})

for (const name of COPIED) {
  test(`port: ${name} has upstream's code`, () => {
    const a = extract(UPSTREAM, name)
    let b = extract(PORT, name)
    assert.ok(a, `${name} is in upstream`)
    assert.ok(b, `${name} is in the port`)
    for (const [ours, theirs] of TYPE_ONLY[name] ?? []) b = b.replace(ours, theirs)
    assert.equal(code(b), code(a))
  })
}

// A module of the declarations extracted from the vendored original, so upstream's cases can run on it.
async function upstreamModule() {
  const head = "type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'\ntype ModelKey = 'haiku' | 'sonnet' | 'opus' | 'fable'\ntype Pick = { model: ModelKey; effort: Effort }\n"
  const body = COPIED.map((n) => extract(UPSTREAM, n).replace(/^export /, '')).join('\n\n')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'effortless-up-'))
  const file = path.join(dir, 'upstream.ts')
  fs.writeFileSync(file, `${head}\n${body}\n\nexport { ${COPIED.join(', ')} }\n`)
  return import(pathToFileURL(file).href)
}

// Upstream's cases, verbatim in substance (tests/effortless.test.ts lines in brackets).
function upstreamCases(m) {
  // [665] cacheSafe
  assert.equal(m.cacheSafe('claude-opus-5-5'), true)
  assert.equal(m.cacheSafe('claude-sonnet-5-5[1m]'), true)
  assert.equal(m.cacheSafe('claude-fable-5-1'), false)
  assert.equal(m.cacheSafe('claude-opus-4-8'), false)
  assert.equal(m.cacheSafe('claude-opus-5'), false)
  // [691] isFollowUp
  for (const t of ['go', 'ok', ' yes ', 'ok go', 'continue']) assert.equal(m.isFollowUp(t), true, t)
  for (const t of ['', 'rename x to count in utils', 'go through my whole drive']) assert.equal(m.isFollowUp(t), false, t)
  // [1195] contextFrom
  const question = 'Which section should I build: A (simple), B (a complicated multi-step layout) or C?'
  const text = m.contextFrom([{ role: 'user', text: 'make me a new section' }, { role: 'assistant', text: 'x'.repeat(5000) + ' ' + question }])
  assert.ok(text.includes(question))
  assert.ok(text.includes('user: make me a new section'))
  assert.ok(text.length < 2500)
  assert.equal(m.contextFrom([]), '')
  // [1472] judgeFailure
  assert.ok(m.judgeFailure('Jev', 402).includes('out of credits'))
  assert.ok(m.judgeFailure('Jev', 429).includes('rate limited'))
  assert.ok(m.judgeFailure('Jev', 401).includes('rejected the key'))
  assert.ok(m.judgeFailure('Jev', 'timeout').includes('did not answer'))
  // [1540] short answers to a question
  const asked = 'user: tidy up\nassistant: Done. Should I archive it?'
  const told = 'user: add export\nassistant: Added the button. Next I wire it up.'
  assert.equal(m.endsOnQuestion(asked), true)
  assert.equal(m.endsOnQuestion(told), false)
  assert.equal(m.endsOnQuestion(''), false)
  assert.equal(m.keepsEffort('yes', asked), false)
  assert.equal(m.keepsEffort('go', told), true)
  assert.equal(m.keepsEffort('build the whole thing', told), false)
  // [1575] withAttachments
  assert.ok(m.withAttachments('fix this', [{ type: 'image' }, { type: 'image' }]).includes('[The message comes with 2 images to look at.]'))
  assert.equal(m.withAttachments('fix this'), 'fix this')
  // [2417] tipped, bounded, parseVerdict sure
  assert.equal(m.tipped('medium', 0.6, 1), 'high')
  assert.equal(m.tipped('medium', 0.9, 1), 'medium')
  assert.equal(m.tipped('medium', 0.8, 1), 'medium')
  assert.equal(m.tipped('medium', 0.8, 2), 'high')
  assert.equal(m.tipped('medium', 0.6, -1), 'low')
  assert.equal(m.tipped('low', 0.3, -2), 'low')
  assert.equal(m.tipped('medium', undefined, 2), 'medium')
  assert.equal(m.bounded('low', 'medium', 'max'), 'medium')
  assert.equal(m.bounded('max', 'low', 'high'), 'high')
  assert.equal(m.parseVerdict('{"model":"opus","effort":"high","sure":0.7,"why":"x"}')?.sure, 0.7)
  // [2759] looksLikeRedo
  for (const yes of ["no, that's wrong", 'Nope. still fails on line 3', 'wrong, it is the other file', "that doesn't work", 'still broken', 'try again please', 'funkar inte', 'fel, det ska vara src', 'inte rätt', "it still doesn't compile"]) assert.equal(m.looksLikeRedo(yes), true, yes)
  for (const no of ['no problem, thanks', 'nothing else to fix', 'now add a test for it', 'looks right, ship it', 'what does this function do', 'normal', 'felsök det här', 'ok']) assert.equal(m.looksLikeRedo(no), false, no)
  // [3167] parseVerdict handoff
  const base = '"model":"opus","effort":"high","why":"x"'
  assert.equal(m.parseVerdict(`{${base},"handoff":"Task done"}`)?.handoff, 'Task done')
  assert.equal(m.parseVerdict(`{${base},"handoff":"   "}`)?.handoff, undefined)
  assert.equal(m.parseVerdict(`{${base},"handoff":false}`)?.handoff, undefined)
  assert.equal(m.parseVerdict(`{${base}}`)?.handoff, undefined)
  // [3820] helperFloor
  assert.equal(m.helperFloor('low', 'max'), 'medium')
  assert.equal(m.helperFloor('high', 'max'), 'high')
  assert.equal(m.helperFloor('low', 'low'), 'low')
  // benchGrade (upstream bench): hit, under, over, none
  const bc = { id: 'x', kind: 'k', current: { model: 'sonnet', effort: 'medium' }, message: 'm', ok: ['medium', 'high'] }
  assert.equal(m.benchGrade(bc, 'high'), 'hit')
  assert.equal(m.benchGrade(bc, 'low'), 'under')
  assert.equal(m.benchGrade(bc, 'max'), 'over')
  assert.equal(m.benchGrade(bc, undefined), 'none')
  // judgeQuestion: the three parts, in upstream's order
  assert.equal(m.judgeQuestion('fix it', { model: 'opus', effort: 'high' }, 'user: a\nassistant: b'), 'Current: opus / high\n\nRecent conversation:\nuser: a\nassistant: b\n\nNext message:\nfix it')
  assert.equal(m.judgeQuestion('x', null, ''), 'Current: none\n\nNext message:\nx')
}

test('upstream cases pass on the vendored original', async () => upstreamCases(await upstreamModule()))
test('upstream cases pass on the port', async () => upstreamCases(await import(pathToFileURL(portFile).href)))
