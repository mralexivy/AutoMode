// A small agent loop that treats every model alike: the same system prompt, tools, limits and evaluator. It answers "how
// good is the model under comparable conditions", not "how good is a vendor's agent". It never runs AutoMode.
import fs from 'node:fs'
import path from 'node:path'
import { ARMS } from '../arms.mts'
import { loadCatalog, requestUsd, type Catalog } from '../lib/catalog.mts'
import type { ExitReason } from '../lib/outcome.mts'
import { sha256 } from '../lib/prompt.mts'
import { ProviderError, type CanonicalCompletion, type CanonicalMessage, type ProviderAdapter } from '../providers/provider.mts'
import { adapterFor } from '../providers/registry.mts'
import { runTool, toolSchemaSha256, TOOLS } from './canonical-tools.mts'
import type { AgentRun, AgentRunner, RunRequest } from './runner.mts'
import { dockerAvailable, dockerSandbox, imagePinned, type Sandbox } from './sandbox.mts'

const SYSTEM_FILE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'prompts', 'neutral-system-v1.md')
const MAX_TURNS = 80
const MAX_OUTPUT_TOKENS = 16_000
const SHELL_TIMEOUT_MS = 5 * 60_000
const RETRIES = 4

export interface NeutralOptions {
  adapter?: (provider: string) => ProviderAdapter
  sandbox?: (workspace: string) => Sandbox
  catalog?: Catalog
  sleep?: (ms: number) => Promise<void>
  allowUnverified?: boolean
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function neutralRunner(o: NeutralOptions = {}): AgentRunner {
  const catalog = o.catalog ?? loadCatalog()
  const sandboxFor = o.sandbox ?? ((workspace: string) => {
    if (!dockerAvailable()) throw new Error('the neutral runner needs Docker, and it never falls back to the host')
    return dockerSandbox(workspace)
  })
  const sleep = o.sleep ?? realSleep

  return {
    id: 'neutral-agent',
    sandbox: sandboxFor,
    async run(req: RunRequest): Promise<AgentRun> {
      const arm = ARMS[req.armId]
      const entry = catalog.models[arm.model]
      if (arm.provider !== 'anthropic' && arm.provider !== 'local' && entry?.status !== 'verified' && !o.allowUnverified) throw new Error(`${arm.model} is not verified in the price table`)
      const adapter = (o.adapter ?? adapterFor)(arm.provider)
      const sandbox = sandboxFor(req.workspace)
      const system = fs.readFileSync(SYSTEM_FILE, 'utf8')
      const messages: CanonicalMessage[] = [{ role: 'user', text: req.prompt }]
      const started = performance.now()
      const deadline = started + req.timeoutMs
      // The canonical transcript stays in the scratch folder. Model text never goes to bench/results.
      const log = (x: unknown) => fs.appendFileSync(path.join(req.dir, 'transcript.jsonl'), JSON.stringify(x) + '\n')

      const modelCalls: unknown[] = []
      const tools = { calls: {} as Record<string, number>, failed: 0, repeated_reads: 0 }
      const reads = new Set<string>()
      const totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
      const models = new Set<string>()
      let cost: number | null = 0, modelMs = 0, turns = 0, peak = 0, exitReason: ExitReason = 'agent_error', stopped = 'turn limit', retries = 0

      const finish = (): AgentRun => {
        return {
          runner: 'neutral-agent', exitReason, exitCode: null, signal: null, isError: exitReason !== 'done', turns, costUsd: cost, sessionId: null, modelMs: Math.round(modelMs), modelUsage: null,
          wallS: Math.round((performance.now() - started) / 1000), stderrTail: exitReason === 'done' ? [] : [stopped], toolSchemaSha256: toolSchemaSha256(),
          evidence: {
            effective_models: [...models].sort(), effective_efforts: arm.effort && arm.effort !== 'default' ? [arm.effort] : [], requests: { [arm.model]: turns }, compactions: 0, peak_prompt_tokens: peak,
            tokens: { input: totals.input, output: totals.output, thinking: totals.reasoning, cacheRead: totals.cacheRead, cacheWrite5m: totals.cacheWrite, cacheWrite1h: 0 }, by_model: {},
            tool_calls: tools, retries, stop: stopped, model_calls: modelCalls, sandbox_image: sandbox.image, image_pinned: imagePinned(sandbox.image),
            system_sha256: sha256(system), hardware: arm.provider === 'local' ? process.env.BENCH_LOCAL_HARDWARE ?? null : null,
          },
        }
      }

      while (turns < MAX_TURNS) {
        if (performance.now() >= deadline) { exitReason = 'timeout'; stopped = 'time limit'; return finish() }
        let reply: CanonicalCompletion | null = null
        const callStart = performance.now()
        for (let attempt = 0; !reply; attempt++) {
          try {
            reply = await adapter.complete({ system, messages, tools: TOOLS, maxOutputTokens: MAX_OUTPUT_TOKENS, reasoning: arm.effort && arm.effort !== 'default' ? { effort: arm.effort } : undefined }, arm.model, AbortSignal.timeout(Math.ceil(Math.max(1000, deadline - performance.now()))))
          } catch (e) {
            if (!(e instanceof ProviderError)) throw e
            // A wrong key or a rejected request is a harness fault, so it must not read as a model's failure.
            if (e.kind === 'auth' || e.kind === 'bad_request') throw e
            retries++
            if (performance.now() >= deadline) { exitReason = 'timeout'; stopped = 'time limit'; return finish() }
            if (attempt >= RETRIES) { exitReason = e.kind === 'rate_limit' ? 'quota' : 'agent_error'; stopped = `provider ${e.kind}`; return finish() }
            await sleep(1000 * 2 ** attempt)
          }
        }
        const ms = performance.now() - callStart
        modelMs += ms
        turns++
        const u = reply.usage
        const usd = requestUsd(entry, u, new Date())
        cost = cost === null || usd === null ? (arm.provider === 'local' ? 0 : null) : cost + usd
        if (reply.effectiveModel) models.add(reply.effectiveModel)
        totals.input += u.inputTokens ?? 0; totals.output += u.outputTokens ?? 0; totals.reasoning += u.reasoningTokens ?? 0; totals.cacheRead += u.cacheReadTokens ?? 0; totals.cacheWrite += u.cacheWriteTokens ?? 0
        peak = Math.max(peak, u.inputTokens ?? 0)
        modelCalls.push({ ms: Math.round(ms), usage: u, native_usage: reply.nativeUsage, usd })
        messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls, native: reply.native })
        log({ turn: turns, text: reply.text, toolCalls: reply.toolCalls, stop: reply.stop })

        if (reply.stop === 'refused') { stopped = 'refused'; return finish() }
        if (!reply.toolCalls.length) {
          if (reply.stop === 'end') { exitReason = 'done'; stopped = 'finished' } else stopped = `stop: ${reply.stop}`
          return finish()
        }
        for (const call of reply.toolCalls) {
          tools.calls[call.name] = (tools.calls[call.name] ?? 0) + 1
          if (call.name === 'read_file') { const k = String(call.args.path); if (reads.has(k)) tools.repeated_reads++; reads.add(k) }
          const result = await runTool(call, req.workspace, sandbox, Math.ceil(Math.min(SHELL_TIMEOUT_MS, Math.max(1000, deadline - performance.now()))))
          if (result.failed) tools.failed++
          messages.push({ role: 'tool', callId: call.id, name: call.name, text: result.text })
          log({ tool: call.name, failed: result.failed, chars: result.text.length })
        }
        if (req.runCap && cost !== null && cost >= req.runCap) { stopped = 'run cap'; return finish() }
      }
      return finish()
    },
  }
}
