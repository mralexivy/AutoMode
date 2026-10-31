// The Chat Completions format that DeepSeek, xAI, Mistral and local servers share. Sharing a format does not mean sharing
// abilities: the capability map says what each one takes, and nothing is sent that a provider did not document.
import { needKey, parseArgs, postJson, type CanonicalCompletion, type CanonicalMessage, type CompletionRequest, type ProviderAdapter } from './provider.mts'

export interface ChatCapabilities {
  effort: 'reasoning_effort' | null // the request field for effort, if the provider documents one
  maxTokensField: 'max_tokens' | 'max_completion_tokens'
}

function messages(req: CompletionRequest) {
  const convert = (m: CanonicalMessage): unknown => {
    if (m.role === 'user') return { role: 'user', content: m.text }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.callId, content: m.text }
    return m.native ?? {
      role: 'assistant', content: m.text || null,
      ...(m.toolCalls.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}),
    }
  }
  return [{ role: 'system', content: req.system }, ...req.messages.map(convert)]
}

export function requestBody(req: CompletionRequest, model: string, caps: ChatCapabilities) {
  return {
    model, messages: messages(req), stream: false,
    tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    ...(req.maxOutputTokens ? { [caps.maxTokensField]: req.maxOutputTokens } : {}),
    ...(req.reasoning?.effort && caps.effort ? { [caps.effort]: req.reasoning.effort } : {}),
    ...(req.reasoning?.native ?? {}),
  }
}

export function fromResponse(j: any): CanonicalCompletion {
  const choice = j.choices?.[0] ?? {}
  const m = choice.message ?? {}
  const toolCalls = (m.tool_calls ?? []).map((c: any) => ({ id: c.id, name: c.function?.name, args: parseArgs(c.function?.arguments) }))
  const u = j.usage ?? {}
  return {
    text: typeof m.content === 'string' ? m.content : '', toolCalls, effectiveModel: j.model ?? null, nativeUsage: u,
    // The whole message goes back unchanged. DeepSeek's reasoning_content lives in it.
    native: m,
    stop: m.refusal ? 'refused' : toolCalls.length || choice.finish_reason === 'tool_calls' ? 'tool' : choice.finish_reason === 'length' ? 'length' : choice.finish_reason === 'stop' ? 'end' : 'other',
    usage: {
      inputTokens: u.prompt_tokens ?? null, outputTokens: u.completion_tokens ?? null, reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? null,
      cacheReadTokens: u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? null, cacheWriteTokens: null,
    },
  }
}

export interface ChatProvider { id: string; url: string; keyEnv: string | null; caps: ChatCapabilities }

export const chatAdapter = (p: ChatProvider, fetchImpl?: typeof fetch): ProviderAdapter => ({
  id: p.id,
  complete: async (req, model, signal) => fromResponse(await postJson(p.url, p.keyEnv ? { authorization: `Bearer ${needKey(p.keyEnv)}` } : {}, requestBody(req, model, p.caps), signal, fetchImpl)),
})

export const DEEPSEEK: ChatProvider = { id: 'deepseek', url: 'https://api.deepseek.com/chat/completions', keyEnv: 'DEEPSEEK_API_KEY', caps: { effort: 'reasoning_effort', maxTokensField: 'max_tokens' } }
// xAI's own docs were not confirmed for effort, and secondary sources disagree, so this sends none.
export const XAI: ChatProvider = { id: 'xai', url: 'https://api.x.ai/v1/chat/completions', keyEnv: 'XAI_API_KEY', caps: { effort: null, maxTokensField: 'max_tokens' } }
export const MISTRAL: ChatProvider = { id: 'mistral', url: 'https://api.mistral.ai/v1/chat/completions', keyEnv: 'MISTRAL_API_KEY', caps: { effort: null, maxTokensField: 'max_tokens' } }
export const localProvider = (url = process.env.BENCH_LOCAL_URL ?? 'http://127.0.0.1:8080/v1/chat/completions'): ChatProvider => ({ id: 'local', url, keyEnv: null, caps: { effort: null, maxTokensField: 'max_tokens' } })
