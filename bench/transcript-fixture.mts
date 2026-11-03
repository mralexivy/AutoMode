#!/usr/bin/env node
// transcript-fixture.mts <session-id> <name> [--why "..."]
// Turns a saved benchmark session into a small, permanent regression fixture: the tool calls only, in order. It keeps
// each command and the tail of each check's output, and drops all model text. Paths are scrubbed: the run folder
// becomes <wt> and any home folder becomes /Users/u. No model call. The fixture goes to bench/fixtures/transcripts/.
import fs from 'node:fs'
import path from 'node:path'
import { isCheck } from '../hooks/lib/failures.ts'
import { toolEvents } from './lib/replay.mts'
import { configDir } from './lib/run-evidence.mts'

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'transcripts')
export const scrub = (s: string) => s
  .replace(/\/(?:private\/)?var\/folders\/[^\s'"]*?\/T\/am-bench\/[^\s/'"]+\/wt/g, '<wt>')
  .replace(/\/(?:private\/)?var\/folders\/[^\s'"]+/g, '<tmp>')
  .replace(/\/Users\/[a-z][a-z0-9_-]*\//g, '/Users/u/')
  .replace(/\/home\/[a-z][a-z0-9_-]*\//g, '/home/u/')

export function findSession(id: string): string | null {
  const root = path.join(configDir(), 'projects')
  for (const d of fs.existsSync(root) ? fs.readdirSync(root) : []) { const f = path.join(root, d, `${id}.jsonl`); if (fs.existsSync(f)) return f }
  return null
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [id, name] = process.argv.slice(2)
  const wi = process.argv.indexOf('--why')
  const file = id && findSession(id)
  if (!file || !name) { console.error('usage: transcript-fixture.mts <session-id> <name> [--why "..."]'); process.exit(1) }
  const events = toolEvents(file).filter((e) => ['Bash', 'Edit', 'Write', 'MultiEdit'].includes(e.tool)).map((e) => ({
    tool: e.tool,
    cmd: scrub(e.tool === 'Bash' ? e.cmd.slice(0, 4000) : path.basename(e.cmd)),
    out: e.tool === 'Bash' && isCheck(e.cmd) ? scrub(e.out.slice(-1500)) : '',
    err: e.err,
  }))
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(path.join(DIR, `${name}.json`), JSON.stringify({ source_session: id, why: wi > 0 ? process.argv[wi + 1] : '', events }, null, 1) + '\n')
  console.log(`${name}: ${events.length} tool calls`)
}
