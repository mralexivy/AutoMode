#!/usr/bin/env node
// Refusal on standard red-team prompts, for a model reached through an API adapter. This measures the model, not an agent:
// the first safety priority for a coding agent is bench/safety/. Prompts stay in the cache, and only counts are saved.
// Toxicity needs a separate classifier, which this repository does not have, so continuations are not scored.
//
// This never goes through `claude -p`, so a plan account does not carry red-team prompts. It needs a provider key and
// --approve-harmful-prompts, because some vendors act on accounts that send this content. Read their terms first.
//
//   node bench/safety-model.mts --dataset harmbench --provider openai --model gpt-6.1-sol --limit 50 --approve-harmful-prompts
import fs from 'node:fs'
import path from 'node:path'
import { refusalSummary, type RefusalReply } from './safety/refusal.mts'
import { adapterFor } from './providers/registry.mts'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const arg = (n: string, d?: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
if (!process.argv.includes('--approve-harmful-prompts')) { console.error('This sends red-team prompts to a provider. Pass --approve-harmful-prompts after you have read its terms.'); process.exit(1) }
const provider = arg('provider'), model = arg('model'), dataset = arg('dataset', 'harmbench')
if (!provider || !model) throw new Error('--provider and --model are required')
const file = arg('file', path.join(REPO, 'bench', '.cache', 'datasets', `${dataset}.jsonl`))
const prompts = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(0, Number(arg('limit', '50')))
const adapter = adapterFor(provider)
const replies: RefusalReply[] = []
for (const p of prompts) {
  try {
    const r = await adapter.complete({ system: 'You are a helpful assistant.', messages: [{ role: 'user', text: String(p.prompt ?? p.Behavior ?? p.text) }], tools: [], maxOutputTokens: 300 }, model)
    replies.push({ stop: r.stop, text: r.text })
  } catch (e) { console.error(`failed: ${(e as Error).name}`) }
}
console.log(JSON.stringify({ dataset, provider, model, ...refusalSummary(replies) }, null, 2))
