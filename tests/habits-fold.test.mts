// scripts/habits-fold.mjs (for huge transcripts, in the person's node) must give what hooks/lib/scan.ts gives.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { compactOf, foldTranscript } from '../hooks/lib/scan.ts'

const ts = (min: number) => new Date(Date.UTC(2026, 0, 1) + min * 60_000).toISOString()
const asst = (id: string, min: number, tokens: number, model: string, tool = false, side = false) => JSON.stringify({ type: 'assistant', requestId: id, timestamp: ts(min), isSidechain: side, message: { model, usage: { input_tokens: 5, cache_read_input_tokens: tokens, cache_creation_input_tokens: 7 }, content: tool ? [{ type: 'tool_use' }] : [{ type: 'text', text: 'SECRET' }] } })
const user = (min: number, content: unknown) => JSON.stringify({ type: 'user', timestamp: ts(min), message: { content } })

test('the streaming script and the library agree, and neither prints text', () => {
  const text = [
    user(0, 'first SECRET'), asst('a', 0.1, 90_000, 'claude-opus-5-5'), asst('a', 0.1, 90_000, 'claude-opus-5-5', true),
    asst('x', 1, 5, 'claude-haiku-5-5', false, true), user(1, [{ type: 'tool_result' }]), asst('b', 12, 120_000, 'claude-opus-5-5'),
    user(12.5, '<command-name>/clear</command-name>'), user(40, [{ type: 'text', text: 'again SECRET' }]), asst('c', 41, 200_000, 'claude-sonnet-5-5'),
    asst('d', 42, 200_000, 'claude-fable-9'), 'not json', '',
  ].join('\n')
  const dir = mkdtempSync(path.join(tmpdir(), 'habits-fold-'))
  const file = path.join(dir, 's.jsonl')
  writeFileSync(file, text)
  const out = execFileSync('node', [new URL('../scripts/habits-fold.mjs', import.meta.url).pathname, file], { encoding: 'utf8' })
  assert.deepEqual(JSON.parse(out), JSON.parse(JSON.stringify(compactOf(foldTranscript(text)))))
  assert.ok(!out.includes('SECRET'))
  assert.equal(JSON.parse(out).prompts, 2)
})
