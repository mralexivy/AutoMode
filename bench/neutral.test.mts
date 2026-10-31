// The neutral track with no network and no model: mocked vendor replies, a stand-in sandbox, and the real evaluator.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ARMS, armInvocation, armSpec } from './arms.mts'
import { isPeak, loadCatalog, rateFor, requestUsd } from './lib/catalog.mts'
import { bigCodePlan, liveCodePlan, liveCodeTest, materialize } from './datasets/codegen.mts'
import { DATASETS } from './datasets/catalog.mts'
import { applyReport, evaluationCommand, predictions, sweRunName, sweTask } from './datasets/swebench.mts'
import { harborCommand, summarizeTrials, trialReward } from './datasets/terminal-bench.mts'
import { isResult } from './lib/outcome.mts'
import { oneRun } from './lib/run-one.mts'
import { problems } from './lib/task-repo.mts'
import * as anthropic from './providers/anthropic.mts'
import * as chat from './providers/chat-completions.mts'
import * as gemini from './providers/gemini.mts'
import * as openai from './providers/openai-responses.mts'
import { errorKind, needKey, parseArgs, postJson, ProviderError, type CanonicalCompletion, type CompletionRequest } from './providers/provider.mts'
import { adapterFor } from './providers/registry.mts'
import { clip, inside, runTool, toolSchemaSha256, TOOLS } from './runners/canonical-tools.mts'
import { neutralRunner } from './runners/neutral-agent.mts'
import { dockerArgs, dockerSandbox, imagePinned, type Sandbox } from './runners/sandbox.mts'

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'am-neutral-test-'))
after(() => fs.rmSync(ROOT, { recursive: true, force: true }))

const history: CompletionRequest = {
  system: 'sys',
  tools: [{ name: 'shell', description: 'd', parameters: { type: 'object', properties: {} } }],
  maxOutputTokens: 100,
  reasoning: { effort: 'high' },
  messages: [
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'ok', toolCalls: [{ id: 'c1', name: 'shell', args: { command: 'ls' } }] },
    { role: 'tool', callId: 'c1', name: 'shell', text: 'out' },
  ],
}

test('OpenAI Responses: request and reply follow the documented shape', () => {
  const b: any = openai.requestBody(history, 'gpt-6.1-sol')
  assert.equal(b.instructions, 'sys')
  assert.deepEqual(b.reasoning, { effort: 'high' })
  assert.equal(b.max_output_tokens, 100)
  assert.deepEqual(b.input[1], { role: 'assistant', content: 'ok' })
  assert.deepEqual(b.input[2], { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"command":"ls"}' })
  assert.deepEqual(b.input[3], { type: 'function_call_output', call_id: 'c1', output: 'out' })
  assert.equal(b.tools[0].type, 'function')
  const r = openai.fromResponse({ model: 'gpt-6.1-sol', status: 'completed',
    output: [{ type: 'reasoning', id: 'rs' }, { type: 'function_call', call_id: 'c2', name: 'shell', arguments: '{"command":"pwd"}' }],
    usage: { input_tokens: 291, output_tokens: 23, output_tokens_details: { reasoning_tokens: 7 }, input_tokens_details: { cached_tokens: 5, cache_write_tokens: 2 } } })
  assert.equal(r.stop, 'tool')
  assert.deepEqual(r.toolCalls, [{ id: 'c2', name: 'shell', args: { command: 'pwd' } }])
  assert.deepEqual(r.usage, { inputTokens: 291, outputTokens: 23, reasoningTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 2 })
  const replay: any = openai.requestBody({ ...history, messages: [{ role: 'assistant', text: '', toolCalls: [], native: r.native }] }, 'm')
  assert.equal(replay.input[0].type, 'reasoning', 'reasoning items go back unchanged')
  assert.equal(openai.fromResponse({ status: 'incomplete', output: [] }).stop, 'length')
  assert.equal(openai.fromResponse({ output: [{ type: 'message', content: [{ type: 'refusal' }] }] }).stop, 'refused')
})

test('Chat Completions: capabilities decide what is sent', () => {
  const ds: any = chat.requestBody(history, 'deepseek-flash', chat.DEEPSEEK.caps)
  assert.equal(ds.reasoning_effort, 'high')
  assert.equal(ds.max_tokens, 100)
  assert.deepEqual(ds.messages[0], { role: 'system', content: 'sys' })
  assert.deepEqual(ds.messages[3], { role: 'tool', tool_call_id: 'c1', content: 'out' })
  const x: any = chat.requestBody(history, 'grok-4.7', chat.XAI.caps)
  assert.equal(x.reasoning_effort, undefined, 'no effort goes to a provider with none documented')
})

test('Chat Completions: DeepSeek cache fields and reasoning_content survive', () => {
  const m = { role: 'assistant', content: null, reasoning_content: 'kept', tool_calls: [{ id: 'c', function: { name: 'shell', arguments: '{"command":"x"}' } }] }
  const r = chat.fromResponse({ model: 'deepseek-flash', choices: [{ finish_reason: 'tool_calls', message: m }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60, completion_tokens_details: { reasoning_tokens: 9 } } })
  assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 20, reasoningTokens: 9, cacheReadTokens: 60, cacheWriteTokens: null })
  assert.equal(r.stop, 'tool')
  const again: any = chat.requestBody({ ...history, messages: [{ role: 'assistant', text: '', toolCalls: r.toolCalls, native: r.native }] }, 'm', chat.DEEPSEEK.caps)
  assert.equal(again.messages[1].reasoning_content, 'kept')
  assert.equal(chat.fromResponse({ choices: [{ finish_reason: 'length', message: { content: 'x' } }] }).stop, 'length')
})

test('Gemini: ids and thought signatures go back, and output counts thinking', () => {
  const parts = [{ functionCall: { id: 'g1', name: 'shell', args: { command: 'ls' } }, thoughtSignature: 'SIG' }]
  const r = gemini.fromResponse({ modelVersion: 'gemini-4-argon', candidates: [{ finishReason: 'STOP', content: { parts } }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 4, cachedContentTokenCount: 8 } })
  assert.equal(r.usage.outputTokens, 14)
  assert.equal(r.usage.reasoningTokens, 4)
  const b: any = gemini.requestBody({ ...history, messages: [{ role: 'user', text: 'u' }, { role: 'assistant', text: '', toolCalls: r.toolCalls, native: r.native }, { role: 'tool', callId: 'g1', name: 'shell', text: 'o' }, { role: 'tool', callId: 'g2', name: 'shell', text: 'p' }] })
  assert.equal(b.contents[1].parts[0].thoughtSignature, 'SIG')
  assert.deepEqual(b.contents[2].parts[0].functionResponse, { id: 'g1', name: 'shell', response: { result: 'o' } })
  assert.equal(b.contents[2].parts.length, 2, 'parallel results share one turn')
  assert.equal(gemini.fromResponse({ candidates: [{ finishReason: 'SAFETY' }] }).stop, 'refused')
  assert.equal(gemini.fromResponse({ promptFeedback: { blockReason: 'OTHER' } }).stop, 'refused')
  assert.equal(gemini.fromResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'hidden' }, { text: 'shown' }] } }] }).text, 'shown')
})

test('Anthropic Messages: tool blocks and cache-aware input', () => {
  const b: any = anthropic.requestBody(history, 'claude-opus-5-5')
  assert.equal(b.messages[1].content[1].type, 'tool_use')
  assert.equal(b.messages[2].content[0].tool_use_id, 'c1')
  assert.deepEqual(b.output_config, { effort: 'high' })
  const r = anthropic.fromResponse({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } })
  assert.equal(r.usage.inputTokens, 130)
  assert.equal(r.stop, 'end')
})

test('the HTTP layer classifies errors and keeps keys out of messages', async () => {
  assert.deepEqual([429, 401, 403, 500, 503, 400].map(errorKind), ['rate_limit', 'auth', 'auth', 'server', 'server', 'bad_request'])
  const failing = (async () => new Response('{"error":"slow down"}', { status: 429 })) as unknown as typeof fetch
  await assert.rejects(postJson('https://x', { authorization: 'Bearer SECRET' }, {}, undefined, failing), (e: ProviderError) => e.kind === 'rate_limit' && !e.message.includes('SECRET'))
  const down = (async () => { throw new Error('connect failed with Bearer SECRET') }) as unknown as typeof fetch
  await assert.rejects(postJson('https://x', {}, {}, undefined, down), (e: ProviderError) => e.kind === 'network' && !e.message.includes('SECRET'))
  assert.throws(() => needKey('NOPE', {}), /NOPE is not set/)
  assert.deepEqual(Object.keys(parseArgs('{oops')), ['_bad_arguments'])
  assert.deepEqual(parseArgs({ a: 1 }), { a: 1 })
})

test('every provider sends its key and URL through the registry', async () => {
  const seen: { url: string; headers: any }[] = []
  const fetchImpl = (async (url: string, init: any) => { seen.push({ url, headers: init.headers }); return new Response('{}') }) as unknown as typeof fetch
  const keys = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g', DEEPSEEK_API_KEY: 'd', XAI_API_KEY: 'x', MISTRAL_API_KEY: 'm' }
  const saved = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]))
  Object.assign(process.env, keys)
  for (const p of ['anthropic', 'openai', 'google', 'deepseek', 'xai', 'mistral', 'local']) await adapterFor(p, fetchImpl).complete(history, 'm')
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  assert.deepEqual(seen.map((s) => new URL(s.url).host), ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com', 'api.deepseek.com', 'api.x.ai', 'api.mistral.ai', '127.0.0.1:8080'])
  assert.equal(seen[0].headers['x-api-key'], 'a')
  assert.equal(seen[2].headers['x-goog-api-key'], 'g')
  assert.equal(seen[3].headers.authorization, 'Bearer d')
  assert.equal(seen[6].headers.authorization, undefined)
  assert.throws(() => adapterFor('nobody'))
})

test('prices follow the date, the hour and the prompt size', () => {
  const c = loadCatalog()
  const u = { inputTokens: 200_000, outputTokens: 1_000_000, reasoningTokens: null, cacheReadTokens: 100_000, cacheWriteTokens: null }
  assert.ok(Math.abs(requestUsd(c.models['gpt-6.1-sol'], u, new Date('2026-11-01')) - 10.21) < 1e-9)
  assert.equal(rateFor(c.models['gemini-4-argon'], new Date('2026-11-30T12:00:00Z'), 10).input, 2)
  assert.equal(rateFor(c.models['gemini-4-argon'], new Date('2026-12-01T00:00:00Z'), 10).input, 4)
  assert.equal(rateFor(c.models['grok-4.7'], new Date(), 199_999).input, 2)
  assert.equal(rateFor(c.models['grok-4.7'], new Date(), 200_000).input, 4)
  assert.equal(isPeak(new Date('2026-11-02T02:00:00Z')), true, 'Monday 02:00 UTC')
  assert.equal(isPeak(new Date('2026-11-02T05:00:00Z')), false)
  assert.equal(isPeak(new Date('2026-11-01T02:00:00Z')), false, 'Sunday')
  assert.equal(rateFor(c.models['deepseek-flash'], new Date('2026-11-02T02:00:00Z'), 1).input, 0.3)
  assert.equal(rateFor(c.models['deepseek-flash'], new Date('2026-11-02T05:00:00Z'), 1).input, 0.15)
  assert.equal(rateFor(c.models['gpt-6.1-sol'], new Date(), 300_000), null, 'no guess above the listed tier')
  assert.equal(requestUsd(undefined, u, new Date()), null)
  assert.equal(requestUsd(c.models['gpt-6.1-sol'], { ...u, outputTokens: null }, new Date()), null)
})

test('the sandbox isolates by default, and network is opt-in', () => {
  const a = dockerArgs({ name: 'n', workspace: '/w', image: 'i', network: false, command: 'c' })
  const value = (flag: string) => a[a.indexOf(flag) + 1]
  assert.equal(value('--network'), 'none')
  assert.equal(value('--cap-drop'), 'ALL')
  assert.equal(value('--security-opt'), 'no-new-privileges')
  assert.equal(value('--mount'), 'type=bind,src=/w,dst=/workspace')
  assert.ok(!a.includes('--env') && !a.includes('-e') && !a.includes('--privileged'))
  const open = dockerArgs({ name: 'n', workspace: '/w', image: 'i', network: true, command: 'c' })
  assert.equal(open[open.indexOf('--network') + 1], 'bridge')
  assert.equal(imagePinned('node:24'), false)
  assert.equal(imagePinned(`node@sha256:${'a'.repeat(64)}`), true)
})

test('a timed-out sandbox command gives no status and the container is killed', async () => {
  const bin = path.join(ROOT, 'docker-bin')
  fs.mkdirSync(bin, { recursive: true })
  const log = path.join(ROOT, 'docker.log')
  fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "$1" >> "${log}"\n[ "$1" = kill ] && exit 0\nexec sleep 30\n`, { mode: 0o755 })
  const saved = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${saved}`
  const r = await dockerSandbox(ROOT, 'img').exec('x', { timeoutMs: 200 })
  process.env.PATH = saved
  assert.equal(r.timedOut, true)
  assert.equal(r.status, null)
  assert.match(fs.readFileSync(log, 'utf8'), /kill/)
})

test('a missing docker binary is a failed command, not a crash', async () => {
  const saved = process.env.PATH
  process.env.PATH = path.join(ROOT, 'empty')
  const r = await dockerSandbox(ROOT, 'img').exec('x', { timeoutMs: 1000 })
  process.env.PATH = saved
  assert.equal(r.status, null)
  assert.match(r.stderr, /ENOENT/)
})

test('file tools refuse paths that leave the workspace, by .. and by symlink', () => {
  const w = fs.mkdtempSync(path.join(ROOT, 'w-'))
  const outside = fs.mkdtempSync(path.join(ROOT, 'out-'))
  fs.writeFileSync(path.join(outside, 'secret'), 'x')
  fs.symlinkSync(outside, path.join(w, 'link'))
  assert.throws(() => inside(w, '../secret'), /outside/)
  assert.throws(() => inside(w, '/etc/passwd'), /outside/)
  assert.throws(() => inside(w, 'link/secret'), /outside/)
  assert.throws(() => inside(w, 'link/new/file'), /outside/)
  assert.throws(() => inside(w, ''), /required/)
  assert.ok(inside(w, '/workspace/a.txt').endsWith('a.txt'))
  assert.ok(inside(w, 'new/dir/a.txt').endsWith('a.txt'))
})

const hostShell = (cwd: string): Sandbox => ({
  image: 'test-image',
  exec: async (command) => { const r = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8' }); return { status: r.status, stdout: r.stdout, stderr: r.stderr, timedOut: false } },
})

test('tools behave and report failure to the model', async () => {
  const w = fs.mkdtempSync(path.join(ROOT, 't-'))
  const box = hostShell(w)
  const call = (name: string, args: Record<string, unknown>) => runTool({ id: 'x', name, args }, w, box, 1000)
  assert.equal((await call('write_file', { path: 'a/b.txt', content: 'one two two' })).text, 'written')
  assert.equal((await call('read_file', { path: 'a/b.txt' })).text, 'one two two')
  assert.equal((await call('replace_text', { path: 'a/b.txt', old_text: 'two', new_text: 'x' })).failed, true)
  assert.equal((await call('replace_text', { path: 'a/b.txt', old_text: 'one', new_text: '$&!' })).failed, false)
  assert.equal(fs.readFileSync(path.join(w, 'a/b.txt'), 'utf8'), '$&! two two', 'replacement text is literal')
  assert.equal((await call('list_files', { path: '.' })).text, 'a/b.txt')
  assert.match((await call('shell', { command: 'exit 3' })).text, /exit code: 3/)
  assert.equal((await call('shell', { command: 'exit 3' })).failed, true)
  assert.equal((await call('nope', {})).failed, true)
  assert.equal((await call('shell', { _bad_arguments: 'x' })).failed, true)
  assert.ok(clip('x'.repeat(50_000)).length < 21_000)
  assert.match(toolSchemaSha256(), /^[0-9a-f]{64}$/)
  assert.equal(new Set(TOOLS.map((t) => t.name)).size, 5)
})

const usage = { inputTokens: 1000, outputTokens: 100, reasoningTokens: 10, cacheReadTokens: 0, cacheWriteTokens: null }
const end = (text = 'done'): CanonicalCompletion => ({ text, toolCalls: [], stop: 'end', usage, nativeUsage: {}, effectiveModel: 'gpt-6.1-sol' })
const tool = (name: string, args: Record<string, unknown>): CanonicalCompletion => ({ text: '', toolCalls: [{ id: `id-${Math.random()}`, name, args }], stop: 'tool', usage, nativeUsage: {}, effectiveModel: 'gpt-6.1-sol' })
const script = (steps: (CanonicalCompletion | Error)[]) => ({ id: 'mock', complete: async () => { const s = steps.shift(); if (!s) throw new Error('script ran out'); if (s instanceof Error) throw s; return s } })

async function loop(steps: (CanonicalCompletion | Error)[], { armId = 'n-gpt-sol', runCap = null as number | null, timeoutMs = 30_000, allowUnverified = false } = {}) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'loop-'))
  const workspace = path.join(dir, 'wt')
  fs.mkdirSync(workspace)
  const runner = neutralRunner({ adapter: () => script(steps), sandbox: hostShell, sleep: async () => {}, allowUnverified })
  return runner.run({ armId, workspace, dir, prompt: 'p', timeoutMs, runCap })
}

test('loop: runs tools until the model stops, and counts what happened', async () => {
  const r = await loop([tool('write_file', { path: 'f', content: 'x' }), tool('read_file', { path: 'f' }), tool('read_file', { path: 'f' }), tool('shell', { command: 'false' }), end()])
  assert.equal(r.exitReason, 'done')
  assert.equal(r.turns, 5)
  assert.ok(Math.abs(r.costUsd - 5 * (1000 * 2 + 100 * 10) / 1e6) < 1e-9)
  const ev: any = r.evidence
  assert.deepEqual(ev.tool_calls, { calls: { write_file: 1, read_file: 2, shell: 1 }, failed: 1, repeated_reads: 1 })
  assert.deepEqual(ev.effective_models, ['gpt-6.1-sol'])
  assert.equal(ev.image_pinned, false)
  assert.match(r.toolSchemaSha256, /^[0-9a-f]{64}$/)
})

test('loop: provider faults are classified, and a model is not blamed for a harness fault', async () => {
  const limit = () => new ProviderError('rate_limit', 429, 'x')
  const recovered = await loop([limit(), new ProviderError('server', 500, 'x'), end()])
  assert.equal(recovered.exitReason, 'done')
  assert.equal((recovered.evidence as any).retries, 2)
  assert.equal((await loop([limit(), limit(), limit(), limit(), limit()])).exitReason, 'quota')
  assert.equal((await loop(Array.from({ length: 5 }, () => new ProviderError('server', 503, 'x')))).exitReason, 'agent_error')
  await assert.rejects(loop([new ProviderError('auth', 401, 'bad key')]), /bad key/)
  await assert.rejects(loop([new ProviderError('bad_request', 400, 'bad field')]), /bad field/)
})

test('loop: refusal, truncation, the turn limit, the run cap and the clock all stop it', async () => {
  assert.equal((await loop([{ ...end(), stop: 'refused' }])).stderrTail[0], 'refused')
  assert.equal((await loop([{ ...end(), stop: 'length' }])).exitReason, 'agent_error')
  const forever = Array.from({ length: 100 }, () => tool('list_files', { path: '.' }))
  const limited = await loop(forever)
  assert.equal(limited.turns, 80)
  assert.equal(limited.exitReason, 'agent_error')
  const capped = await loop(Array.from({ length: 100 }, () => tool('list_files', { path: '.' })), { runCap: 0.01 })
  assert.equal(capped.stderrTail[0], 'run cap')
  assert.ok(capped.turns < 10)
  assert.equal((await loop(Array.from({ length: 10 }, () => tool('list_files', { path: '.' })), { timeoutMs: 0 })).exitReason, 'timeout')
})

test('loop: a request that dies at the deadline is a timeout', async () => {
  const hung = { id: 'hung', complete: () => new Promise<CanonicalCompletion>((_, reject) => setTimeout(() => reject(new ProviderError('network', null, 'aborted')), 20)) }
  const dir = fs.mkdtempSync(path.join(ROOT, 'hung-'))
  const r = await neutralRunner({ adapter: () => hung, sandbox: hostShell, sleep: async () => {} }).run({ armId: 'n-gpt-sol', workspace: dir, dir, prompt: 'p', timeoutMs: 5, runCap: null })
  assert.equal(r.exitReason, 'timeout')
})

test('an unverified model is refused unless a caller opts in, and no Docker means no run', async () => {
  await assert.rejects(loop([end()], { armId: 'n-mistral-small' }), /not verified/)
  assert.equal((await loop([end()], { armId: 'n-mistral-small', allowUnverified: true })).exitReason, 'done')
  const dir = fs.mkdtempSync(path.join(ROOT, 'nod-'))
  const saved = process.env.PATH
  process.env.PATH = dir
  await assert.rejects(neutralRunner({ adapter: () => script([end()]) }).run({ armId: 'n-gpt-sol', workspace: dir, dir, prompt: 'p', timeoutMs: 1000, runCap: null }), /needs Docker/)
  process.env.PATH = saved
})

test('arms: neutral arms sit in their track, and a gateway key never enters a row', () => {
  assert.equal(armSpec('n-gemini-argon').runner, 'neutral-agent')
  assert.equal(armSpec('n-gemini-argon').model.provider, 'google')
  assert.equal(armSpec('n-gemini-argon').alias_map, null)
  const c = loadCatalog()
  for (const [id, arm] of Object.entries(ARMS)) if (arm.runner && !['anthropic', 'local'].includes(arm.provider)) assert.ok(c.models[arm.model], id)
  const saved = process.env.DEEPSEEK_API_KEY
  process.env.DEEPSEEK_API_KEY = 'VERY-SECRET'
  const dir = fs.mkdtempSync(path.join(ROOT, 'gw-'))
  const { env } = armInvocation('cc-deepseek-pro', dir, 'p')
  if (saved === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = saved
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'VERY-SECRET')
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic')
  assert.doesNotMatch(JSON.stringify(armSpec('cc-deepseek-pro')), /VERY-SECRET/)
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), /VERY-SECRET/)
})

test('the same evaluator judges a neutral run, inside the sandbox, with a hidden test', async () => {
  const source = path.join(ROOT, 'src')
  fs.mkdirSync(source)
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: source, encoding: 'utf8' }).trim()
  git('init', '-q')
  fs.writeFileSync(path.join(source, 'README.md'), 'x\n'); git('add', '.'); git('commit', '-q', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  fs.writeFileSync(path.join(source, 'add.js'), 'export const add = (a, b) => a + b\n')
  fs.writeFileSync(path.join(source, 'add.test.js'), `import { add } from './add.js'\nif (add(2, 3) !== 5) process.exit(1)\n`); git('add', '.'); git('commit', '-q', '-m', 'reference')
  const task: any = { id: 'n', cohort: 'trivial', repo: source, base, reference: git('rev-parse', 'HEAD'), task: 'Add add.js.', hidden_tests: ['add.test.js'], accept: 'node add.test.js' }
  const seen: string[] = []
  const box = (cwd: string): Sandbox => ({ ...hostShell(cwd), exec: (c, o) => { seen.push(c); return hostShell(cwd).exec(c, o) } })
  const steps = [tool('write_file', { path: 'add.js', content: 'export const add = (a, b) => a + b\n' }), end()]
  const runner = neutralRunner({ adapter: () => script(steps), sandbox: box, sleep: async () => {} })
  const out = path.join(ROOT, 'n', 'r.jsonl')
  const row: any = await oneRun(task, 'n-gpt-sol', 1, { scratch: path.join(ROOT, 'ns'), out, timeoutMs: 20_000, runCap: 3, repoFor: () => source, runnerFor: () => runner })
  assert.equal(row.accepted, true)
  assert.equal(row.harness.runner, 'neutral-agent')
  assert.equal(row.model.provider, 'openai')
  assert.ok(row.cost_usd_api_equiv > 0)
  assert.equal(row.estimated_cost_usd, row.cost_usd_api_equiv)
  assert.deepEqual(row.tool_efficiency.calls, { write_file: 1 })
  assert.match(row.prompt.tool_schema_sha256, /^[0-9a-f]{64}$/)
  assert.ok(seen.includes('node add.test.js'), 'the hidden test ran in the sandbox')
})

const sweItem = { repo: 'astropy/astropy', instance_id: 'astropy__astropy-12907', base_commit: 'd'.repeat(40), problem_statement: 'Fix the separability matrix.' }

test('SWE-bench: an item is a valid task that another harness scores', () => {
  const t = sweTask(sweItem, 'princeton-nlp/SWE-bench_Verified', 'rev')
  assert.deepEqual(problems(t), [])
  assert.equal(t.repo, 'https://github.com/astropy/astropy')
  assert.equal(t.external_eval, 'swebench')
  assert.equal(t.task, 'Fix the separability matrix.')
  assert.equal(isResult({ external_eval: 'swebench', accepted: null }), false)
  assert.equal(isResult({ external_eval: 'swebench', accepted: false }), true)
})

test('SWE-bench: predictions use one file per arm and repeat, and upstream verdicts come back', () => {
  const rows = [{ run_id: 'a', task_id: 'i1', arm: 'n-opus', repeat: 1 }, { run_id: 'b', task_id: 'i2', arm: 'n-opus', repeat: 1 }, { run_id: 'c', task_id: 'i3', arm: 'n-opus', repeat: 1 }, { run_id: 'd', task_id: 'i1', arm: 'n-sonnet', repeat: 2 }]
  const p = predictions(rows, (id) => (id === 'b' ? null : `patch-${id}`))
  assert.deepEqual([...p.keys()], ['n-opus__r1', 'n-sonnet__r2'])
  assert.deepEqual(p.get('n-opus__r1')[0], { instance_id: 'i1', model_name_or_path: 'n-opus__r1', model_patch: 'patch-a' })
  assert.equal(p.get('n-opus__r1')[1].model_patch, '')
  assert.ok(evaluationCommand('d', 'f', sweRunName('x', 1)).includes('swebench.harness.run_evaluation'))
  const scored = applyReport(rows, { resolved_ids: ['i1'], unresolved_ids: ['i2'], empty_patch_ids: [], infra_failure_ids: ['i3'] }, 'n-opus__r1')
  assert.equal(scored[0].accepted, true)
  assert.equal(scored[1].accepted, false)
  assert.equal(scored[2].accepted, undefined, 'an infrastructure failure gives no verdict')
  assert.equal(scored[3].accepted, undefined, 'another run is untouched')
  assert.throws(() => applyReport(rows, {}, 'x'), /upstream format changed/)
})

test('a SWE-bench run saves an applying patch and gets no local verdict', async () => {
  const source = path.join(ROOT, 'swe-src')
  fs.mkdirSync(source)
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { cwd: source, encoding: 'utf8' }).trim()
  git('init', '-q'); fs.writeFileSync(path.join(source, 'a.txt'), 'old\n'); git('add', '.'); git('commit', '-q', '-m', 'base')
  const task = sweTask({ ...sweItem, instance_id: 'x__y-1', base_commit: git('rev-parse', 'HEAD') }, 'd', 'r')
  const runner = neutralRunner({ adapter: () => script([tool('write_file', { path: 'a.txt', content: 'new\n' }), tool('write_file', { path: 'b.txt', content: 'added\n' }), end()]), sandbox: hostShell, sleep: async () => {} })
  const out = path.join(ROOT, 'swe', 'r.jsonl')
  const row: any = await oneRun(task, 'n-gpt-sol', 1, { scratch: path.join(ROOT, 'swes'), out, timeoutMs: 20_000, runCap: null, repoFor: () => source, runnerFor: () => runner })
  assert.equal(row.accepted, null)
  assert.equal(isResult(row), false)
  const patchFile = path.join(ROOT, 'swe', 'diffs', `${row.run_id}.patch`)
  execFileSync('git', ['checkout', '-q', 'HEAD', '--', '.'], { cwd: source })
  execFileSync('git', ['apply', '--check', patchFile], { cwd: source })
})

test('Terminal-Bench: a changed trial shape stops the import instead of reading as zero', () => {
  assert.equal(trialReward({ verifier_result: { rewards: { reward: 1 } } }), 1)
  assert.throws(() => trialReward({ score: 1 }), /Harbor format/)
  assert.deepEqual(summarizeTrials([{ verifier_result: { rewards: { reward: 1 } } }, { verifier_result: { rewards: { reward: 0 } } }]), { trials: 2, solved: 1, mean_reward: 0.5 })
  assert.deepEqual(harborCommand('claude-code', 'm', 5).slice(0, 4), ['harbor', 'run', '-d', 'terminal-bench/terminal-bench-2'])
})

test('BigCodeBench: the base holds no answer and no test, and the reference holds both', () => {
  const plan = bigCodePlan({ task_id: 'BigCodeBench/7', instruct_prompt: 'Add numbers.', code_prompt: 'def task_func(a, b):\n', canonical_solution: '    return a + b\n', test: 'import unittest\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(task_func(1, 2), 3)\n' }, 'd', 'r')
  const dir = path.join(ROOT, 'bcb')
  const task = materialize(plan, dir)
  assert.equal(task.id, 'bcb-bigcodebench-7')
  assert.equal(task.requirements.sandbox, true)
  const show = (ref: string, f: string) => spawnSync('git', ['show', `${ref}:${f}`], { cwd: dir, encoding: 'utf8' })
  assert.doesNotMatch(show(task.base, 'solution.py').stdout, /return a \+ b/)
  assert.notEqual(show(task.base, 'test_solution.py').status, 0)
  assert.match(show(task.reference, 'solution.py').stdout, /return a \+ b/)
  assert.deepEqual(problems(task), [])
})

test('LiveCodeBench: public tests only, in both test styles', () => {
  const stdin = liveCodeTest([{ input: '1 2', output: '3', testtype: 'stdin' }], '')
  assert.match(stdin, /subprocess\.run/)
  const fn = liveCodeTest([{ input: '[1]\n2', output: '3', testtype: 'functional' }], 'class Solution:\n    def addUp(self, a, b):\n        pass')
  assert.match(fn, /"addUp"/)
  assert.throws(() => liveCodeTest([{ input: '1', output: '1', testtype: 'functional' }], ''), /starter/)
  const plan = liveCodePlan({ question_id: 'abc 1', question_content: 'Q', starter_code: '', public_test_cases: '[{"input":"1","output":"1","testtype":"stdin"}]', private_test_cases: 'PICKLED' }, 'd', 'r')
  assert.equal(plan.id, 'lcb-abc-1')
  assert.doesNotMatch(JSON.stringify(plan), /PICKLED/)
})

test('generated python tests run as written', { skip: spawnSync('python3', ['--version']).status !== 0 }, () => {
  const dir = fs.mkdtempSync(path.join(ROOT, 'py-'))
  fs.writeFileSync(path.join(dir, 'solution.py'), 'import sys\nprint(sum(map(int, sys.stdin.read().split())))\n')
  fs.writeFileSync(path.join(dir, 'test_solution.py'), liveCodeTest([{ input: '1 2', output: '3', testtype: 'stdin' }], ''))
  assert.equal(spawnSync('python3', ['test_solution.py'], { cwd: dir }).status, 0)
  fs.writeFileSync(path.join(dir, 'solution.py'), 'class Solution:\n    def addUp(self, a, b):\n        return a + b\n')
  fs.writeFileSync(path.join(dir, 'test_solution.py'), liveCodeTest([{ input: '1\n2', output: '3', testtype: 'functional' }], 'class Solution:\n    def addUp(self, a, b):\n        pass'))
  assert.equal(spawnSync('python3', ['test_solution.py'], { cwd: dir }).status, 0)
  fs.writeFileSync(path.join(dir, 'test_solution.py'), liveCodeTest([{ input: '1\n2', output: '4', testtype: 'functional' }], 'class Solution:\n    def addUp(self, a, b):\n        pass'))
  assert.notEqual(spawnSync('python3', ['test_solution.py'], { cwd: dir, stdio: 'ignore' }).status, 0, 'a wrong answer fails')
})

test('a sandbox-only task is refused on an unsandboxed runner', async () => {
  const plan = bigCodePlan({ task_id: 'x/1', instruct_prompt: 'p', code_prompt: '', canonical_solution: '', test: '' }, 'd', 'r')
  const dir = path.join(ROOT, 'box-repo')
  const task = materialize(plan, dir)
  await assert.rejects(oneRun(task, 'sonnet-high', 1, { scratch: path.join(ROOT, 'bs'), out: path.join(ROOT, 'b.jsonl'), timeoutMs: 1000, runCap: null, repoFor: () => dir }), /needs a sandboxed runner/)
})

test('every dataset is pinned, and the CLI lists them with no network', () => {
  for (const d of Object.values(DATASETS)) if (d.kind !== 'terminal-bench') assert.match(d.revision, /^[0-9a-f]{40}$/, d.id)
  const r = spawnSync(process.execPath, ['bench/datasets/cli.mts', 'list'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /swebench-verified/)
})
